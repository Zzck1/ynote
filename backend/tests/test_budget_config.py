"""Offline regressions: no provider requests, real persistent SQLite transactions."""
import concurrent.futures
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from backend.billing import Ledger, LIMIT, SHARED_ACCOUNT, BUDGET_ENV, MAX_BUDGET_FEN, NANO_PER_FEN, daily_budget_from_env, BillingError
from backend.cloud import create_cloud_app
from backend.cloud_service import CloudService, Connections
from backend.provider_profiles import PROFILES

PRICE={'version':'offline-fixture','effective_at':'2026-10-23','model':PROFILES['siliconflow'][1], 'input':100_000_000,'output':0,'cache':0,'verified':True}

class DailyBudgetConfig(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'billing.sqlite3'
    def tearDown(self):self.tmp.cleanup()
    def ledger(self,amount):return Ledger(self.path,daily_budget_from_env({BUDGET_ENV:amount}),price=PRICE)
    def test_strict_exact_configuration(self):
        self.assertEqual(daily_budget_from_env({}),LIMIT)
        for value,expected in [('0',0),('0.00',0),('0.01',10_000_000),('12.34',12_340_000_000),('10.5',10_500_000_000)]:
            self.assertEqual(daily_budget_from_env({BUDGET_ENV:value}),expected)
        for value in ['', '-1', '+1', '1e2', 'NaN', 'Infinity', ' 10', '10 ', '01', '.5', '2.', '0.001', '9,99', '１２', str(MAX_BUDGET_FEN//100+1), '9'*5000]:
            with self.subTest(value=value[:25]):
                with self.assertRaisesRegex(ValueError,BUDGET_ENV):daily_budget_from_env({BUDGET_ENV:value})
        for bad in [-1,0.5,True,10_000_001]:
            with self.assertRaises(ValueError):Ledger(self.path,bad)

    def test_restart_raise_lower_pause_and_existing_settlement(self):
        old=self.ledger('10.00')
        old.reserve(SHARED_ACCOUNT,'done',{'job':1},3_000_000_000)
        old.finish(SHARED_ACCOUNT,'done',{'prompt_tokens':20,'completion_tokens':0},'already completed')
        old.reserve(SHARED_ACCOUNT,'in-flight',{'job':2},4_000_000_000)
        lower=self.ledger('5.50')
        q=lower.quota(SHARED_ACCOUNT,available=True)
        self.assertEqual((q['daily_limit_fen'],q['used_nano_cny'],q['reserved_nano_cny'],q['remaining_nano_cny']),(550,'2000000000','4000000000','0'))
        self.assertEqual(q['budget_state'],'exhausted')
        with self.assertRaises(BillingError) as blocked:lower.reserve(SHARED_ACCOUNT,'new',{},1)
        self.assertEqual(blocked.exception.error['code'],'QUOTA_EXCEEDED')
        paused=self.ledger('0')
        self.assertEqual(paused.reserve(SHARED_ACCOUNT,'done',{'job':1},3_000_000_000),'already completed')
        with self.assertRaises(BillingError) as blocked:paused.reserve(SHARED_ACCOUNT,'paused-new',{},1)
        self.assertEqual(blocked.exception.error['code'],'PLATFORM_BUDGET_PAUSED')
        paused.finish(SHARED_ACCOUNT,'in-flight',{'prompt_tokens':10,'completion_tokens':0},'sent before pause')
        q=paused.quota(SHARED_ACCOUNT,available=True)
        self.assertEqual((q['used_nano_cny'],q['reserved_nano_cny'],q['remaining_nano_cny']),('3000000000','0','0'))
        self.assertEqual(q['budget_state'],'paused');self.assertFalse(q['platform_available'])
        higher=self.ledger('7.25')
        self.assertEqual(higher.quota(SHARED_ACCOUNT)['remaining_nano_cny'],'4250000000')
        higher.reserve(SHARED_ACCOUNT,'after-raise',{},2_000_000_000)
        self.assertEqual(higher.quota(SHARED_ACCOUNT)['remaining_nano_cny'],'2250000000')
        again=self.ledger('3.10')
        again.finish(SHARED_ACCOUNT,'after-raise',{'prompt_tokens':5,'completion_tokens':0},'complete despite lower cap')
        self.assertEqual(again.quota(SHARED_ACCOUNT)['used_nano_cny'],'3500000000')
        self.assertEqual(again.quota(SHARED_ACCOUNT)['remaining_nano_cny'],'0')

    def test_transactional_shared_limit_after_restart(self):
        self.ledger('0.01')
        def reserve(i):
            try:self.ledger('0.01').reserve(SHARED_ACCOUNT,str(i),{},6_000_000);return True
            except BillingError as e:self.assertEqual(e.error['code'],'QUOTA_EXCEEDED');return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:self.assertEqual(sum(pool.map(reserve,range(12))),1)
        self.assertEqual(self.ledger('0.01').quota(SHARED_ACCOUNT)['reserved_nano_cny'],'6000000')

    def test_environment_http_contract_and_client_cannot_change_budget(self):
        with patch.dict('os.environ',{BUDGET_ENV:'12.34'}):app=create_cloud_app(self.tmp.name,origins=('http://testserver',),secure_cookie=False)
        client=TestClient(app)
        data=client.get('/api/quota?daily_limit_fen=999999').json()
        self.assertEqual(data['daily_limit_fen'],1234);self.assertEqual(data['daily_limit_nano_cny'],'12340000000')
        r=client.post('/api/quota',headers={'Origin':'http://testserver'},json={'daily_limit_fen':999999})
        self.assertEqual(r.status_code,405);self.assertEqual(client.get('/api/quota').json()['daily_limit_fen'],1234)
        with patch.dict('os.environ',{BUDGET_ENV:'bad'}):
            with self.assertRaisesRegex(ValueError,BUDGET_ENV):create_cloud_app(self.tmp.name)
        with patch.dict('os.environ',{BUDGET_ENV:'0'}):paused=create_cloud_app(self.tmp.name,origins=('http://testserver',),platform_key='test-platform-secret',verified_profile=True,price=PRICE,secure_cookie=False)
        with patch('backend.cloud_service.upstream') as upstream:
            c=TestClient(paused);q=c.get('/api/quota').json()
            r=c.post('/api/ai/text',headers={'Origin':'http://testserver'},json={'tool':'ynote','billing_mode':'platform','prompt':'test','idempotency_key':'new','daily_limit_fen':999999})
            self.assertEqual(r.status_code,503);self.assertEqual(r.json()['error']['code'],'PLATFORM_BUDGET_PAUSED');upstream.assert_not_called()
            self.assertNotIn('test-platform-secret',json.dumps(q)+r.text)
            self.assertEqual(q['daily_limit_fen'],0);self.assertEqual(q['budget_state'],'paused')

    def test_byok_remains_independent_when_platform_paused(self):
        ledger=self.ledger('0');connections=Connections()
        connections.entries['offline-id']={'user':'visitor','tool':'ynote','provider':'siliconflow','base_url':PROFILES['siliconflow'][0],'model':PROFILES['siliconflow'][1],'capability':'text_ai','key':'personal-secret','expiry':connections.clock()+900}
        service=CloudService('visitor',ledger,connections,'platform-secret',True)
        response=httpx.Response(200,json={'choices':[{'message':{'content':'offline BYOK result'},'finish_reason':'stop'}]})
        before=ledger.quota(SHARED_ACCOUNT)
        with patch('backend.cloud_service.upstream',return_value=response) as upstream:
            result,_=service.text('test',{'tool':'ynote','billing_mode':'byok','connection_id':'offline-id','idempotency_key':'personal'})
            self.assertEqual(result,'offline BYOK result');self.assertEqual(upstream.call_args.args[3],'personal-secret')
        after=ledger.quota(SHARED_ACCOUNT)
        self.assertEqual((after['used_nano_cny'],after['reserved_nano_cny']),(before['used_nano_cny'],before['reserved_nano_cny']))

    def test_already_sent_request_finishes_after_budget_paused(self):
        price={**PRICE,'input':2000,'output':8000,'cache':40}
        old=Ledger(self.path,daily_budget_from_env({BUDGET_ENV:'1.00'}),price=price)
        service=CloudService('visitor',old,Connections(),'fake-key',True)
        sent=threading.Event();release=threading.Event()
        def provider(*args,**kwargs):
            sent.set();self.assertTrue(release.wait(3))
            return httpx.Response(200,json={'choices':[{'message':{'content':'finished'},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':5}})
        with patch('backend.cloud_service.upstream',side_effect=provider) as upstream:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future=pool.submit(service.text,'test',{'tool':'ynote','billing_mode':'platform','idempotency_key':'already-sent'})
                self.assertTrue(sent.wait(3))
                paused=Ledger(self.path,0,price=price)
                self.assertGreater(int(paused.quota(SHARED_ACCOUNT)['reserved_nano_cny']),0)
                release.set();self.assertEqual(future.result(timeout=3)[0],'finished')
            self.assertEqual(upstream.call_count,1)
        q=paused.quota(SHARED_ACCOUNT)
        self.assertEqual(q['used_nano_cny'],'60000');self.assertEqual(q['reserved_nano_cny'],'0');self.assertEqual(q['remaining_nano_cny'],'0')

if __name__=='__main__':unittest.main()
