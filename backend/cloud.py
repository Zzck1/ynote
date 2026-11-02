"""Anonymous website gateway. Sessions isolate private data; quota is site-wide."""
import hashlib,os,secrets,time
from pathlib import Path
from fastapi import FastAPI,Request
from fastapi.responses import JSONResponse,FileResponse
import mimetypes
from .app import create_app
from .billing import Ledger,BillingError,SHARED_ACCOUNT,daily_budget_from_env
from .cloud_service import Connections,CloudService

COOKIE='ynote_visitor_v1'

def create_cloud_app(root=None,origins=('https://yuanshengzhe.com',),platform_key='',verified_profile=False,daily_budget=None,monthly_budget=0,secure_cookie=True,price=None,platform_runtime=None,local_admin=False,require_companion=False):
    daily_budget=daily_budget_from_env() if daily_budget is None else daily_budget
    root=Path(root or os.environ.get('YNOTE_CLOUD_DATA','./ynote-cloud-data')).resolve();root.mkdir(parents=True,exist_ok=True)
    gateway=FastAPI(title='Ynote anonymous shared-budget gateway',docs_url=None,openapi_url=None)
    ledger=Ledger(root/'billing.sqlite3',daily_budget,monthly_budget,price=price);connections=Connections();apps={}
    with ledger.tx() as db:db.execute('CREATE TABLE IF NOT EXISTS yn_visitors(digest TEXT PRIMARY KEY,expiry INTEGER NOT NULL)')
    gateway.state.ledger=ledger;gateway.state.connections=connections;gateway.state.private_apps=apps
    from .companion_relay import CompanionRelay
    relay=CompanionRelay(lambda visitor:CloudService(visitor,ledger,connections,platform_key,verified_profile,platform_runtime))
    gateway.state.companion_relay=relay
    if local_admin and platform_runtime:
        from .platform_admin import install_local_admin
        install_local_admin(gateway,platform_runtime,origins)
    @gateway.middleware('http')
    async def dispatch(req,call_next):
        path=req.url.path;fresh=None
        def attach(response):
            if fresh:response.set_cookie(COOKIE,fresh,max_age=86400,httponly=True,secure=secure_cookie,samesite='strict',path='/')
            return response
        try:
            if req.method not in ('GET','HEAD','OPTIONS') and req.headers.get('origin') not in origins:raise BillingError('ORIGIN_REJECTED','请求来源未授权',403)
            if path in ('/admin/platform','/api/admin/platform'):
                if not hasattr(gateway.state,'local_admin'):raise BillingError('ADMIN_FORBIDDEN','本地管理入口未启用',403)
                return await gateway.state.local_admin(req)
            if path.startswith('/api/relay/'):
                return await relay.dispatch(req)
            if require_companion and not path.startswith('/api/'):
                if req.method not in ('GET','HEAD'):raise BillingError('METHOD_NOT_ALLOWED','静态网站仅支持读取',405)
                dist=(Path(__file__).resolve().parent.parent/'frontend'/'dist').resolve()
                candidate=(dist/path.lstrip('/')).resolve()
                if not candidate.is_relative_to(dist):raise BillingError('INVALID_INPUT','非法静态文件路径',404)
                if path in ('/','/workspace','/notes','/settings'):candidate=dist/'index.html'
                if not candidate.is_file():raise BillingError('NOT_FOUND','静态资源不存在',404)
                mime='application/wasm' if candidate.suffix=='.wasm' else 'text/javascript' if candidate.suffix in ('.mjs','.js') else mimetypes.guess_type(str(candidate))[0] or 'application/octet-stream'
                return FileResponse(candidate,media_type=mime,headers={'Cache-Control':'no-cache'})
            if require_companion and path=='/api/health' and req.method in ('GET','HEAD'):
                return JSONResponse({'ok':True,'processing':{'media':'companion','models':'gateway'}},headers={'Cache-Control':'no-store'})
            raw=req.cookies.get(COOKIE,'');visitor=hashlib.sha256(raw.encode()).hexdigest() if len(raw)==43 else ''
            with ledger.tx() as db:
                valid=db.execute('SELECT expiry FROM yn_visitors WHERE digest=?',(visitor,)).fetchone()
                if not valid or valid[0]<time.time():
                    fresh=secrets.token_urlsafe(32);visitor=hashlib.sha256(fresh.encode()).hexdigest()
                    db.execute('DELETE FROM yn_visitors WHERE expiry<?',(int(time.time()),))
                    db.execute('INSERT INTO yn_visitors VALUES(?,?)',(visitor,int(time.time())+86400))
            service=CloudService(visitor,ledger,connections,platform_key,verified_profile,platform_runtime)
            if path=='/api/quota':
                if req.method not in ('GET','HEAD'):raise BillingError('METHOD_NOT_ALLOWED','额度配置只能由服务器环境变量修改',405)
                if req.query_params.get('tool','ynote')!='ynote':raise BillingError('INVALID_INPUT','此服务仅处理 Ynote')
                quota=ledger.quota(SHARED_ACCOUNT,available=service.available)
                quota['capabilities']=service.capabilities(quota['platform_available'])
                if require_companion:quota['processing']={'media':'companion','models':'gateway'}
                return attach(JSONResponse(quota,headers={'Cache-Control':'private, no-store'}))
            if path=='/api/companion/lease':
                if req.method!='POST':raise BillingError('METHOD_NOT_ALLOWED','助手连接仅支持 POST',405)
                return attach(JSONResponse(relay.leases.issue(visitor,req.headers['origin']),headers={'Cache-Control':'no-store'}))
            if path=='/api/byok/validate' and req.method=='POST':
                if int(req.headers.get('content-length','0'))>16384:raise BillingError('INVALID_INPUT','请求过大',413)
                import asyncio
                body=await req.json();result=await asyncio.to_thread(connections.validate,visitor,body)
                return attach(JSONResponse(result,headers={'Cache-Control':'private, no-store'}))
            if path=='/api/ai/text' and req.method=='POST':
                import asyncio
                b=await req.json();prompt=b.get('prompt','')
                if not isinstance(prompt,str) or not 1<=len(prompt)<=100000:raise BillingError('INVALID_INPUT','文字长度无效')
                text,config=await asyncio.to_thread(service.text,prompt,b)
                return attach(JSONResponse({'text':text,'provider':config['provider'],'model':config['model']},headers={'Cache-Control':'private, no-store'}))
            if require_companion:
                raise BillingError('LOCAL_COMPANION_REQUIRED','请连接本地助手；视频下载、媒体处理与任务资料保存在用户电脑，云端仅转发模型调用',409)
            if visitor not in apps:
                if len(apps)>=64:raise BillingError('CONCURRENCY_LIMIT','当前活动会话过多，请稍后重试',429)
                userroot=root/'visitors'/visitor;userroot.mkdir(parents=True,exist_ok=True)
                apps[visitor]=create_app(userroot,service,secure_remote=True)
            scope=dict(req.scope);scope['headers']=[(k,v) for k,v in scope['headers'] if k not in (b'host',b'origin')]+[(b'host',b'127.0.0.1')]
            from starlette.responses import Response
            class Proxy(Response):
                async def __call__(self,_scope,receive,send):
                    async def send_with_cookie(message):
                        if message['type']=='http.response.start':
                            extra=[(k,v) for k,v in self.raw_headers if k==b'set-cookie']
                            message={**message,'headers':list(message['headers'])+extra}
                        await send(message)
                    await apps[visitor](scope,receive,send_with_cookie)
            return attach(Proxy())
        except BillingError as exc:return attach(JSONResponse({'error':exc.error},status_code=exc.status,headers={'Cache-Control':'private, no-store'}))
        except (ValueError,TypeError):return attach(JSONResponse({'error':{'code':'INVALID_INPUT','message':'请求格式不正确','retryable':False}},status_code=422))
    return gateway
