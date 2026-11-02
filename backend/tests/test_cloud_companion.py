import concurrent.futures,json,tempfile,time,unittest
from pathlib import Path
from datetime import datetime,timezone
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.billing import Ledger,LIMIT,SHARED_ACCOUNT,BillingError,cost
from backend.cloud import create_cloud_app
from backend.cloud_service import CloudService,Connections
from backend.provider_profiles import payload,PROFILES,is_public,public_addresses
from companion.server import create_companion
import httpx

class Accounting(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.ledger=Ledger(Path(self.tmp.name)/'ledger.db',LIMIT)
    def tearDown(self):self.tmp.cleanup()
    def test_precision_cache_reasoning(self):
        self.assertEqual(cost({'prompt_tokens':100,'completion_tokens':20,'prompt_tokens_details':{'cached_tokens':50},'completion_tokens_details':{'reasoning_tokens':10}}),340000)
        self.assertEqual(cost({'prompt_tokens':1,'completion_tokens':0}),4000)
        with self.assertRaises(BillingError):cost({'prompt_tokens':1,'completion_tokens':0,'prompt_tokens_details':{'cached_tokens':2}})
    def test_offpeak_rate_snapshot_and_peak_boundary(self):
        self.ledger.price.update(input=2000,output=8000,cache=40,off_peak={'input':1000,'output':4000,'cache':20})
        before=datetime(2026,10,23,17,59,tzinfo=timezone.utc) # Beijing 01:59
        off=datetime(2026,10,23,18,0,tzinfo=timezone.utc) # Beijing 02:00
        end=datetime(2026,10,24,0,0,tzinfo=timezone.utc) # Beijing 08:00
        self.assertEqual(self.ledger.rate_snapshot(before)['input'],2000)
        self.assertEqual(self.ledger.rate_snapshot(off)['input'],1000)
        self.assertEqual(self.ledger.rate_snapshot(end)['input'],2000)
        self.ledger.reserve(SHARED_ACCOUNT,'offpeak',{},100000,at=off)
        with self.ledger.tx() as db:stored=json.loads(db.execute('SELECT price FROM yn_calls WHERE key=?',('offpeak',)).fetchone()[0])
        self.assertEqual(stored['output'],4000)
    def test_shared_concurrency_and_idempotency(self):
        def call(i):
            try:self.ledger.reserve(SHARED_ACCOUNT,str(i),{'mode':'platform','i':i},6_000_000_000);return True
            except BillingError as e:self.assertEqual(e.error['code'],'QUOTA_EXCEEDED');return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:self.assertEqual(sum(pool.map(call,range(8))),1)
        self.assertEqual(self.ledger.quota(SHARED_ACCOUNT)['reserved_nano_cny'],'6000000000')
    def test_idempotency_and_uncertainty(self):
        self.ledger.reserve(SHARED_ACCOUNT,'one',{'mode':'platform'},100000)
        with self.assertRaises(BillingError) as c:self.ledger.reserve(SHARED_ACCOUNT,'one',{'mode':'byok'},100000)
        self.assertEqual(c.exception.status,409)
        self.ledger.finish(SHARED_ACCOUNT,'one')
        self.assertEqual(self.ledger.quota(SHARED_ACCOUNT)['reserved_nano_cny'],'100000')
        with self.assertRaises(BillingError):self.ledger.reserve(SHARED_ACCOUNT,'one',{'mode':'platform'},100000)
    def test_midnight_and_settlement(self):
        before=datetime(2026,10,23,15,59,59,tzinfo=timezone.utc);after=datetime(2026,10,23,16,0,1,tzinfo=timezone.utc)
        self.ledger.reserve(SHARED_ACCOUNT,'night',{},100000,at=before)
        self.ledger.finish(SHARED_ACCOUNT,'night',{'prompt_tokens':1,'completion_tokens':1},'ok')
        self.assertEqual(self.ledger.quota(SHARED_ACCOUNT,at=before)['used_nano_cny'],'10000')
        self.assertEqual(self.ledger.quota(SHARED_ACCOUNT,at=after)['used_nano_cny'],'0')
        self.assertEqual(self.ledger.reserve(SHARED_ACCOUNT,'night',{},100000,at=after),'ok')
    def test_overspend_halts_and_new_model_has_no_inherited_price(self):
        self.ledger.reserve(SHARED_ACCOUNT,'excess',{},1)
        self.ledger.finish(SHARED_ACCOUNT,'excess',{'prompt_tokens':1,'completion_tokens':0},'ok')
        self.assertFalse(self.ledger.quota(SHARED_ACCOUNT,available=True)['platform_available'])
        service=CloudService('anonymous',self.ledger,Connections(),'not-a-real-key',True)
        self.assertEqual(PROFILES['siliconflow'][1],'deepseek-ai/DeepSeek-V4.1-Flash')
        self.assertFalse(service.available)
    def test_provider_payloads(self):
        self.assertEqual(PROFILES['zhipu'][1],'glm-5.3-flash')
        for provider in PROFILES:
            b=payload(provider,'test',[])
            self.assertNotIn('temperature',b)
            if provider=='openai':self.assertIn('max_completion_tokens',b);self.assertEqual(b['reasoning_effort'],'none');self.assertNotIn('max_tokens',b)
    def test_ssrf_addresses_and_redirect_validation(self):
        for ip in ('127.0.0.1','::1','10.0.0.1','169.254.169.254','100.64.0.1','224.0.0.1'):
            self.assertFalse(is_public(ip),ip)
        with patch('backend.provider_profiles.socket.getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(BillingError):public_addresses(PROFILES['siliconflow'][0])
        body={'tool':'ynote','base_url':PROFILES['siliconflow'][0],'model':PROFILES['siliconflow'][1],'api_key':'offline-test-secret','capability':'text_ai'}
        with patch('backend.cloud_service.upstream',return_value=httpx.Response(302,headers={'location':'http://169.254.169.254/'})) as upstream:
            with self.assertRaises(BillingError):Connections().validate('visitor',body)
            self.assertEqual(upstream.call_count,1)
    def test_byok_ttl_binding_and_no_platform_fallback(self):
        clock=[1000];connections=Connections(clock=lambda:clock[0])
        body={'tool':'ynote','base_url':PROFILES['siliconflow'][0],'model':PROFILES['siliconflow'][1],'api_key':'offline-test-secret','capability':'text_ai'}
        with patch('backend.cloud_service.upstream',return_value=httpx.Response(200,json={'data':[{'id':body['model'],'supported_endpoints':['chat/completions']}]})):
            result=connections.validate('visitor-a',body)
        self.assertNotIn('offline-test-secret',json.dumps(result));cid=result['connection_id']
        with self.assertRaises(BillingError):connections.get('visitor-b',cid,'text_ai')
        with self.assertRaises(BillingError):connections.get('visitor-a',cid,'transcription')
        service=CloudService('visitor-a',self.ledger,connections,'never-used-platform-key',True)
        self.ledger.price['input']=None  # Pending platform price must not break BYOK.
        with patch('backend.cloud_service.upstream',return_value=httpx.Response(429)) as mocked:
            with self.assertRaises(BillingError) as error:service.text('offline sample',{'tool':'ynote','billing_mode':'byok','connection_id':cid,'idempotency_key':'byok-rate-limit'})
            self.assertEqual(error.exception.status,429);self.assertEqual(mocked.call_count,1)
        self.assertEqual(self.ledger.quota(SHARED_ACCOUNT)['reserved_nano_cny'],'0')
        clock[0]=2000
        with self.assertRaises(BillingError):connections.get('visitor-a',cid,'text_ai')
        self.assertNotIn(cid,connections.entries)

class Gateways(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.apps=[]
    def tearDown(self):
        for app in self.apps:
            if hasattr(app.state,'private_apps'):
                for inner in app.state.private_apps.values():inner.state.store.db.close()
            if hasattr(app.state,'core'):app.state.core.state.store.db.close()
        self.tmp.cleanup()
    def test_anonymous_privacy_and_shared_balance_no_key_leak(self):
        app=create_cloud_app(self.tmp.name,origins=('http://127.0.0.1',),secure_cookie=False)
        self.apps.append(app)
        a=TestClient(app);b=TestClient(app)
        qa=a.get('/api/quota?tool=ynote');qb=b.get('/api/quota?tool=ynote')
        self.assertEqual(qa.json()['daily_limit_fen'],1000);self.assertEqual(qa.json()['quota_scope'],'site_shared');self.assertFalse(qa.json()['platform_available'])
        self.assertNotEqual(a.cookies.get('ynote_visitor_v1'),b.cookies.get('ynote_visitor_v1'))
        r=a.post('/api/materials/import',headers={'Origin':'http://127.0.0.1'},files={'file':('a.txt',b'private sample')});self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(b.get('/api/materials/'+r.json()['material']['id']).status_code,404)
        self.assertEqual(b.get('/api/materials').json()['materials'],[])
        app.state.ledger.reserve(SHARED_ACCOUNT,'one',{},1000000)
        self.assertEqual(a.get('/api/quota').json()['reserved_nano_cny'],b.get('/api/quota').json()['reserved_nano_cny'])
        self.assertEqual(a.post('/api/byok/validate',json={}).status_code,403)
    def test_local_origin_pairing_revocation_and_protected_files(self):
        app=create_companion(self.tmp.name,approval=lambda message:True,origins=('https://yuanshengzhe.com',))
        self.apps.append(app)
        c=TestClient(app,base_url='http://127.0.0.1:18790');origin={'Origin':'https://yuanshengzhe.com'}
        self.assertEqual(c.get('/v1/health').status_code,403)
        self.assertEqual(c.get('/v1/health',headers={'Origin':'null'}).status_code,403)
        self.assertEqual(c.get('/v1/health',headers=origin).status_code,200)
        self.assertEqual(c.get('/v1/local/api/tasks',headers=origin).status_code,409)
        started=c.post('/v1/pair/start',headers=origin,json={'client_nonce':'x'*40}).json()
        for _ in range(50):
            r=c.post('/v1/pair/claim',headers=origin,json={'pairing_id':started['pairing_id'],'client_nonce':'x'*40})
            if r.status_code!=202:break
            time.sleep(.01)
        self.assertEqual(r.status_code,200,r.text);token=r.json()['token']
        headers={**origin,'Authorization':'Bearer '+token,'X-Ynote-Protocol':'1'}
        r=c.post('/v1/local/api/tasks',headers=headers,json={});self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(c.get('/v1/local/api/assets/nope/download',headers=origin).status_code,409)
        self.assertEqual(c.get('/v1/local/api/tasks',headers={**headers,'Origin':'https://evil.example'}).status_code,403)
        self.assertEqual(c.post('/v1/session/revoke',headers=headers).status_code,200)
        self.assertEqual(c.get('/v1/local/api/tasks',headers=headers).status_code,401)

if __name__=='__main__':unittest.main()
