"""Offline relay contracts: real MP3 validation, no provider requests or keys."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from backend.billing import BillingError
from backend.cloud import create_cloud_app
from backend.cloud_service import CloudService
from backend.companion_relay import MAX_MULTIPART,MAX_JSON

ORIGIN='https://ynote.example'
OTHER='https://other.example'
PRICE=json.loads((Path(__file__).parents[1]/'platform-price.json').read_text('utf-8'))


class CompanionRelayTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.app=create_cloud_app(self.root/'gateway',origins=(ORIGIN,OTHER),price=PRICE,platform_key='offline-platform-only',verified_profile=True,require_companion=True)
        self.web=TestClient(self.app,base_url=ORIGIN,headers={'Origin':ORIGIN})
        self.helper=TestClient(self.app,base_url=ORIGIN)
        response=self.web.post('/api/companion/lease');self.assertEqual(response.status_code,200,response.text)
        self.lease=response.json();self.headers={'Origin':ORIGIN,'Authorization':'Bearer '+self.lease['token']}
        self.audio=self.root/'fixture.mp3'
        subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-ac','1','-ar','16000','-b:a','64k',str(self.audio)],check=True)

    def tearDown(self):
        for inner in self.app.state.private_apps.values():inner.state.store.db.close()
        self.temp.cleanup()

    def body(self,key='one'):return {'tool':'ynote','billing_mode':'platform','idempotency_key':key}

    def post_audio(self,body=None,file=None,headers=None):
        return self.helper.post('/api/relay/transcribe',headers=headers or self.headers,data={'body':json.dumps(body or self.body())},files={'file':file or ('prepared.mp3',self.audio.read_bytes(),'audio/mpeg')})

    def test_memory_lease_binds_visitor_origin_and_does_not_use_helper_cookies(self):
        self.assertEqual(self.lease['origin'],ORIGIN)
        self.assertIsInstance(self.lease['expires_at'],int)
        self.assertLessEqual(self.lease['expires_at']-__import__('time').time(),1800)
        visitor=hashlib.sha256(self.web.cookies.get('ynote_visitor_v1').encode()).hexdigest()
        with patch.object(CloudService,'text',autospec=True,return_value=('test',{'provider':'siliconflow','model':'offline','key':'must-not-leak'})) as model:
            response=self.helper.post('/api/relay/text',headers=self.headers,json={**self.body(),'prompt':'test'})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(model.call_args.args[0].user,visitor)
            self.assertNotIn('must-not-leak',response.text)
        self.assertNotIn('set-cookie',response.headers)
        self.assertEqual(dict(self.helper.cookies),{})
        self.assertEqual(self.app.state.private_apps,{})
        self.assertFalse((self.root/'gateway'/'visitors').exists())

    def test_token_expiry_missing_token_wrong_origin_and_methods(self):
        request={**self.body(),'prompt':'test'}
        with patch.object(CloudService,'text') as model:
            for headers,status in [({'Origin':ORIGIN},401),({**self.headers,'Authorization':'Bearer invalid'},401),({**self.headers,'Origin':OTHER},403),({**self.headers,'Origin':'null'},403)]:
                response=self.helper.post('/api/relay/text',headers=headers,json=request)
                self.assertEqual(response.status_code,status,response.text)
            self.assertEqual(self.helper.get('/api/relay/text',headers=self.headers).status_code,405)
            self.assertEqual(self.helper.post('/api/companion/lease').status_code,403)
            self.app.state.companion_relay.leases.clock=lambda:self.lease['expires_at']
            self.assertEqual(self.helper.post('/api/relay/text',headers=self.headers,json=request).status_code,401)
            model.assert_not_called()

    def test_arbitrary_provider_key_model_fields_and_nested_connection_controls_rejected(self):
        with patch.object(CloudService,'text') as text,patch.object(CloudService,'transcribe') as asr:
            for field in ['base_url','api_key','key','provider','model','url']:
                body={**self.body(),field:'forbidden'}
                self.assertEqual(self.helper.post('/api/relay/text',headers=self.headers,json={**body,'prompt':'test'}).status_code,422)
                self.assertEqual(self.post_audio(body).status_code,422)
            response=self.helper.post('/api/relay/text',headers=self.headers,json={**self.body(),'prompt':'test','connections':{'base_url':'https://evil.example'}})
            self.assertEqual(response.status_code,422)
            text.assert_not_called();asr.assert_not_called()

    def test_text_same_account_budget_settlement_and_idempotency(self):
        result=httpx.Response(200,json={'choices':[{'message':{'content':'offline output'},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':10}})
        request={**self.body('same-request'),'prompt':'test prompt'}
        with patch('backend.cloud_service.upstream',return_value=result) as model:
            for _ in range(2):
                response=self.helper.post('/api/relay/text',headers=self.headers,json=request)
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(response.json()['text'],'offline output')
            self.assertEqual(model.call_count,1)
        quota=self.web.get('/api/quota').json()
        self.assertGreater(int(quota['used_nano_cny']),0)
        self.assertEqual(quota['reserved_nano_cny'],'0')
        other=TestClient(self.app,base_url=ORIGIN)
        self.assertEqual(other.get('/api/quota').json()['used_nano_cny'],quota['used_nano_cny'])
        self.assertEqual(quota['processing'],{'media':'companion','models':'gateway'})
        self.assertEqual(self.app.state.private_apps,{})

    def test_real_prepared_mp3_only_and_temporary_file_deleted_on_success_or_failure(self):
        paths=[]
        def asr(service,path,body):
            paths.append(path);self.assertTrue(path.is_file());self.assertEqual(path.read_bytes(),self.audio.read_bytes())
            if body['idempotency_key']=='fail':raise BillingError('PROVIDER_UNAVAILABLE','offline request failed',503)
            return {'text':'offline transcript','segments':[]}
        with patch.object(CloudService,'transcribe',autospec=True,side_effect=asr):
            response=self.post_audio();self.assertEqual(response.status_code,200,response.text)
            failure=self.post_audio(self.body('fail'));self.assertEqual(failure.status_code,503,failure.text)
        self.assertTrue(all(not path.exists() and not path.parent.exists() for path in paths))
        self.assertEqual(self.app.state.private_apps,{})
        self.assertFalse((self.root/'gateway'/'visitors').exists())

    def test_video_renamed_mp3_and_audio_wrong_mime_rejected_without_transcoding(self):
        video=self.root/'video.mp4'
        subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-f','lavfi','-i','color=s=160x90:r=12:d=1','-an',str(video)],check=True)
        original_run=subprocess.run;commands=[]
        def probe(command,*args,**kwargs):
            commands.append(command);return original_run(command,*args,**kwargs)
        with patch('backend.companion_relay.subprocess.run',side_effect=probe),patch.object(CloudService,'transcribe') as asr:
            response=self.post_audio(file=('disguised.mp3',video.read_bytes(),'audio/mpeg'))
            self.assertEqual(response.status_code,422,response.text)
            self.assertEqual(self.post_audio(file=('prepared.mp3',self.audio.read_bytes(),'video/mp4')).status_code,422)
            self.assertTrue(commands);self.assertTrue(all(command[0]=='ffprobe' for command in commands))
            asr.assert_not_called()

    def test_request_lengths_and_stream_limits_apply_before_provider(self):
        with patch.object(CloudService,'text') as text,patch.object(CloudService,'transcribe') as asr:
            too_large={**self.headers,'Content-Length':str(MAX_JSON+1)}
            self.assertEqual(self.helper.post('/api/relay/text',headers=too_large,content=b'{}').status_code,413)
            self.assertEqual(self.helper.post('/api/relay/transcribe',headers={**self.headers,'Content-Length':str(MAX_MULTIPART+1)},content=b'x').status_code,413)
            with patch('backend.companion_relay.MAX_JSON',256):
                response=self.helper.post('/api/relay/text',headers=self.headers,content=iter([b'{"prompt":"',b'x'*300,b'"}']))
                self.assertEqual(response.status_code,413,response.text)
            with patch('backend.companion_relay.MAX_MULTIPART',256):
                response=self.post_audio(headers={**self.headers,'Content-Length':'1'})
                self.assertEqual(response.status_code,413,response.text)
            text.assert_not_called();asr.assert_not_called()

    def test_two_request_concurrency_limit_is_shared_between_relay_calls(self):
        entered=threading.Event();release=threading.Event();counter=[0];lock=threading.Lock()
        def model(service,prompt,body):
            with lock:
                counter[0]+=1
                if counter[0]==2:entered.set()
            release.wait(5)
            return 'test',{'provider':'siliconflow','model':'offline'}
        def request(index):
            client=TestClient(self.app,base_url=ORIGIN)
            return client.post('/api/relay/text',headers=self.headers,json={**self.body(str(index)),'prompt':'test'})
        with patch.object(CloudService,'text',autospec=True,side_effect=model),concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            first=pool.submit(request,1);second=pool.submit(request,2)
            try:
                self.assertTrue(entered.wait(5))
                blocked=request(3);self.assertEqual(blocked.status_code,429,blocked.text)
            finally:release.set()
            self.assertEqual(first.result().status_code,200);self.assertEqual(second.result().status_code,200)

    def test_heavy_api_rejected_and_static_routes_do_not_create_private_databases(self):
        site=self.root/'site';dist=site/'frontend'/'dist';(dist/'assets').mkdir(parents=True)
        (dist/'index.html').write_text('<h1>static fixture</h1>',encoding='utf-8')
        (dist/'assets'/'test.wasm').write_bytes(b'wasm-fixture')
        with patch('backend.cloud.__file__',str(site/'backend'/'cloud.py')):
            for path in ['/','/workspace','/settings','/notes']:
                response=self.helper.get(path);self.assertEqual(response.status_code,200,response.text)
                self.assertIn('static fixture',response.text);self.assertNotIn('set-cookie',response.headers)
            wasm=self.helper.get('/assets/test.wasm');self.assertEqual(wasm.headers['content-type'],'application/wasm')
            for path in ['/assets/missing.js','/models/missing.onnx','/missing.png','/unknown-route']:
                self.assertEqual(self.helper.get(path).status_code,404)
        for path in ['/api/tasks','/api/materials','/api/media','/api/jobs','/api/assets','/api/exports','/api/settings']:
            response=self.web.post(path,json={})
            self.assertEqual(response.status_code,409,response.text)
            self.assertEqual(response.json()['error']['code'],'LOCAL_COMPANION_REQUIRED')
        self.assertEqual(self.app.state.private_apps,{})
        self.assertFalse((self.root/'gateway'/'visitors').exists())

    def test_gateway_mode_enum_reaches_service_without_client_model_selection(self):
        with patch.object(CloudService,'text',autospec=True,return_value=('text',{'provider':'gateway','model':'server-selected'})) as text,patch.object(CloudService,'transcribe',autospec=True,return_value={'text':'offline','segments':[]}) as asr:
            for mode in ('quick','precise'):
                body={**self.body(mode),'extraction_mode':mode}
                response=self.helper.post('/api/relay/text',headers=self.headers,json={**body,'prompt':'test'})
                self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(text.call_args.args[2]['extraction_mode'],mode)
                response=self.post_audio(body);self.assertEqual(response.status_code,200,response.text)
                self.assertEqual(asr.call_args.args[2]['extraction_mode'],mode)
            before=(text.call_count,asr.call_count)
            for mode in ('raw-model',None,{},True):
                body={**self.body(),'extraction_mode':mode}
                self.assertEqual(self.helper.post('/api/relay/text',headers=self.headers,json={**body,'prompt':'test'}).status_code,422)
                self.assertEqual(self.post_audio(body).status_code,422)
            self.assertEqual((text.call_count,asr.call_count),before)


if __name__=='__main__':unittest.main()
