"""Trusted-server accounting. This module must never be shipped with platform keys."""
from __future__ import annotations
import hashlib, json, sqlite3, os, re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8))
LIMIT = 10_000_000_000
NANO_PER_FEN = 10_000_000
BUDGET_ENV = 'YNOTE_DAILY_SHARED_BUDGET_CNY'
MAX_BUDGET_FEN = (2**63 - 1) // NANO_PER_FEN
SHARED_ACCOUNT = 'ynote-public-shared-v1'
PRICE = {'version': 'sf-v3.2-20261023-unverified', 'model':'deepseek-ai/DeepSeek-V3.2', 'input': 4000, 'output': 6000, 'cache': 400, 'verified':False}

class BillingError(Exception):
    def __init__(self, code, message, status=422, **extra):
        self.status=status; self.error={'code':code,'message':message,'retryable':False,**extra}

def daily_budget_from_env(environ=None):
    """Read once at server startup. Never parse currency through binary floats."""
    value=(os.environ if environ is None else environ).get(BUDGET_ENV)
    if value is None:return LIMIT
    if not isinstance(value,str) or not re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?',value) or len(value)>20:
        raise ValueError(f'{BUDGET_ENV} 必须为非负人民币金额，最多两位小数；0 暂停新的平台免费调用')
    whole,_,fraction=value.partition('.')
    fen=int(whole)*100+int(fraction.ljust(2,'0') or '0')
    if fen>MAX_BUDGET_FEN:raise ValueError(f'{BUDGET_ENV} 超出整数账本可支持的金额范围')
    return fen*NANO_PER_FEN

def day_at(at=None):
    return (at or datetime.now(timezone.utc)).astimezone(BEIJING).date().isoformat()

def resets(day):
    return (datetime.fromisoformat(day).replace(tzinfo=BEIJING)+timedelta(days=1)).isoformat()

def cost(usage,price=PRICE):
    """Completion includes reasoning; cached input is a subset of prompt tokens."""
    try:
        if price.get('kind')=='asr' and 'audio_nano_cny_per_second' in price:
            duration=usage['audio_duration_us'];rate=price['audio_nano_cny_per_second']
            if type(duration) is not int or duration<=0 or type(rate) is not int or rate<0:raise ValueError()
            amount=(duration*rate+999999)//1000000
            if not 0<=amount<=2**63-1:raise ValueError()
            return amount
        p,c=usage['prompt_tokens'],usage['completion_tokens']
        details=usage.get('prompt_tokens_details') or {}
        h=details.get('cached_tokens',usage.get('prompt_cache_hit_tokens',0))
        if any(type(n) is not int or n<0 for n in (p,c,h)) or h>p: raise ValueError()
        amount=(p-h)*price['input']+h*price['cache']+c*price['output']
        if type(amount) is not int or not 0<=amount<=2**63-1:raise ValueError()
        return amount
    except (KeyError,TypeError,ValueError,AttributeError):
        raise BillingError('ACCOUNTING_REVIEW','缺少可靠最终用量，预占保留待对账',503)

class Ledger:
    def __init__(self,path,global_daily=0,global_monthly=0,price=None):
        if type(global_daily) is not int or not 0<=global_daily<=MAX_BUDGET_FEN*NANO_PER_FEN or global_daily%NANO_PER_FEN:
            raise ValueError('每日共享预算必须为非负整数分对应的 nano-CNY 金额')
        self.path=str(path); self.global_daily=global_daily; self.global_monthly=global_monthly;self.price=dict(price or PRICE)
        with self.tx() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS yn_accounts(user TEXT,tool TEXT,day TEXT,spent INTEGER NOT NULL DEFAULT 0,reserved INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user,tool,day));
            CREATE TABLE IF NOT EXISTS yn_calls(user TEXT,tool TEXT,key TEXT,day TEXT,fingerprint TEXT,bound INTEGER,cost INTEGER,state TEXT,response TEXT,price TEXT,PRIMARY KEY(user,tool,key));
            CREATE TABLE IF NOT EXISTS yn_control(id INTEGER PRIMARY KEY CHECK(id=1),halted INTEGER NOT NULL DEFAULT 0);
            INSERT OR IGNORE INTO yn_control VALUES(1,0);
            ''')
    def rate_snapshot(self, at=None):
        selected=dict(self.price)
        at=at or datetime.now(timezone.utc)
        if self.price.get('off_peak') and 2 <= at.astimezone(BEIJING).hour < 8:
            selected.update(self.price['off_peak'])
        selected['rate_selected_at']=at.isoformat()
        return selected
    @contextmanager
    def tx(self):
        db=sqlite3.connect(self.path,timeout=30,isolation_level=None)
        try:
            db.execute('PRAGMA journal_mode=WAL'); db.execute('BEGIN IMMEDIATE')
            yield db; db.commit()
        except BaseException:
            db.rollback();raise
        finally:db.close()
    def quota(self,user,tool='ynote',at=None,available=False):
        if tool!='ynote':raise BillingError('INVALID_INPUT','此服务仅处理 Ynote')
        day=day_at(at)
        with self.tx() as db:
            row=db.execute('SELECT spent,reserved FROM yn_accounts WHERE user=? AND tool=? AND day=?',(user,tool,day)).fetchone() or (0,0)
            halt=db.execute('SELECT halted FROM yn_control WHERE id=1').fetchone()[0]
        used,reserved=row;remaining=max(0,self.global_daily-used-reserved)
        enabled=bool(available and not halt and self.global_daily>0 and remaining>0)
        state='paused' if self.global_daily==0 else 'review' if halt else 'exhausted' if remaining==0 else 'available' if enabled else 'unavailable'
        message={'paused':'平台免费调用已由管理员暂停','review':'平台调用已暂停待对账','exhausted':'今日共享额度不足','available':'额度由服务端实时核算','unavailable':'平台调用暂未启用'}[state]
        return {'tool':tool,'status':'active','billing_mode':'platform','currency':'CNY','timezone':'Asia/Shanghai','daily_limit_fen':self.global_daily//NANO_PER_FEN,'daily_limit_nano_cny':str(self.global_daily),'quota_scope':'site_shared',
                'used_fen':used//10_000_000,'reserved_fen':reserved//10_000_000,'remaining_fen':remaining//10_000_000,
                'used_nano_cny':str(used),'reserved_nano_cny':str(reserved),'remaining_nano_cny':str(remaining),
                'platform_available':enabled,'budget_state':state,'platform_message':message,'resets_at':resets(day)}
    def reserve(self,user,key,payload,bound,at=None,tool='ynote',price_snapshot=None):
        free_asr=bound==0 and price_snapshot and price_snapshot.get('kind')=='asr' and price_snapshot.get('verified') is True and price_snapshot.get('audio_nano_cny_per_second',0)==0 and all(type(price_snapshot.get(k)) is int and price_snapshot[k]==0 for k in ('input','output','cache'))
        if tool!='ynote' or not user or not isinstance(key,str) or not 1<=len(key)<=512 or type(bound) is not int or (bound<=0 and not free_asr):
            raise BillingError('INVALID_INPUT','计费请求不合法')
        fp=hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest();day=day_at(at)
        with self.tx() as db:
            old=db.execute('SELECT fingerprint,state,response FROM yn_calls WHERE user=? AND tool=? AND key=?',(user,tool,key)).fetchone()
            if old:
                if old[0]!=fp:raise BillingError('IDEMPOTENCY_CONFLICT','同一幂等键不能更换内容或付款模式',409)
                if old[1]=='settled':return json.loads(old[2])
                raise BillingError('ACCOUNTING_REVIEW','调用已在执行或待对账，请勿重复调用',503)
            if self.global_daily==0:raise BillingError('PLATFORM_BUDGET_PAUSED','平台免费调用已由管理员暂停，个人自备 Key 不受影响',503)
            if db.execute('SELECT halted FROM yn_control WHERE id=1').fetchone()[0]:raise BillingError('ACCOUNTING_REVIEW','平台调用已暂停待对账',503)
            db.execute('INSERT OR IGNORE INTO yn_accounts(user,tool,day) VALUES(?,?,?)',(user,tool,day))
            spent,reserved=db.execute('SELECT spent,reserved FROM yn_accounts WHERE user=? AND tool=? AND day=?',(user,tool,day)).fetchone()
            if spent+reserved+bound>self.global_daily or (free_asr and spent+reserved>=self.global_daily):
                raise BillingError('QUOTA_EXCEEDED','今日共享额度不足以覆盖本次调用，请验证个人 API Key',402,reason='daily_exhausted' if spent+reserved>=self.global_daily else 'reservation_exceeds_available',resets_at=resets(day))
            for length,limit in ((10,self.global_daily),(7,self.global_monthly)):
                if length==7 and not limit:continue
                used=db.execute('SELECT COALESCE(SUM(spent+reserved),0) FROM yn_accounts WHERE substr(day,1,?)=?',(length,day[:length])).fetchone()[0]
                if not limit or used+bound>limit:raise BillingError('PLATFORM_BUDGET_UNAVAILABLE','平台运营预算未配置或不足',503)
            pending=db.execute("SELECT count(*) FROM yn_calls WHERE user=? AND state='reserved'",(user,)).fetchone()[0]
            if pending>=2:raise BillingError('CONCURRENCY_LIMIT','同时调用数量已达上限',429)
            db.execute('UPDATE yn_accounts SET reserved=reserved+? WHERE user=? AND tool=? AND day=?',(bound,user,tool,day))
            db.execute('INSERT INTO yn_calls VALUES(?,?,?,?,?,?,NULL,\'reserved\',NULL,?)',(user,tool,key,day,fp,bound,json.dumps(price_snapshot or self.rate_snapshot(at))))
        return None
    def finish(self,user,key,usage=None,response=None,unbilled=False,tool='ynote',truncated=False):
        with self.tx() as db:
            row=db.execute('SELECT day,bound,state,price FROM yn_calls WHERE user=? AND tool=? AND key=?',(user,tool,key)).fetchone()
            if not row or row[2] not in ('reserved','review'):return
            day,bound,_,price_json=row
            selected=json.loads(price_json)
            if selected.get('off_peak'):
                # At a tariff boundary use the higher rate to keep the budget safe.
                current=self.rate_snapshot()
                for k in ('input','output','cache'):selected[k]=max(selected[k],current[k])
            amount=0 if unbilled else cost(usage,selected) if usage is not None else None
            if amount is None:
                db.execute("UPDATE yn_calls SET state='review' WHERE user=? AND tool=? AND key=?",(user,tool,key));return
            db.execute('UPDATE yn_accounts SET reserved=reserved-?,spent=spent+? WHERE user=? AND tool=? AND day=?',(bound,amount,user,tool,day))
            state='truncated' if truncated else 'settled'
            db.execute("UPDATE yn_calls SET state=?,cost=?,response=? WHERE user=? AND tool=? AND key=?",(state,amount,json.dumps(None if truncated else response),user,tool,key))
            if amount>bound:db.execute('UPDATE yn_control SET halted=1 WHERE id=1')
