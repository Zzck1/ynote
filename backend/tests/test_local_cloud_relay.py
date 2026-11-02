"""Local companion integration. Remote transport is replaced; media work is real."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from backend.billing import BillingError
from companion.cloud_relay import CloudRelay,DEV_ORIGIN
from companion.server import create_companion
from companion.model import Model

A='https://ynote.example'
B='https://other.example'
TOKEN_A='a'*43
TOKEN_B='b'*43


class LocalCloudRelayTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)

    def tearDown(self):self.temp.cleanup()

    def relay(self):
        relay=CloudRelay((A,B,DEV_ORIGIN),clock=lambda:1000)
        relay.configure({'token':TOKEN_A,'origin':A,'expires_at':2000},A)
        relay.configure({'token':TOKEN_B,'origin':B,'expires_at':2000},B)
        return relay

    def body(self,origin=A):return {'tool':'ynote','billing_mode':'platform','idempotency_key':'offline-request','_relay_origin':origin}

    def video(self):
        path=self.root/'source.mp4'
        subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-f','lavfi','-i','color=s=160x90:r=12:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac','-shortest',str(path)],check=True)
        return path

    def pair(self,client,origin):
        started=client.post('/v1/pair/start',headers={'Origin':origin},json={'client_nonce':'x'*40}).json()
        for _ in range(100):
            response=client.post('/v1/pair/claim',headers={'Origin':origin},json={'pairing_id':started['pairing_id'],'client_nonce':'x'*40})
            if response.status_code!=202:break
            time.sleep(.01)
        self.assertEqual(response.status_code,200,response.text)
        return {'Origin':origin,'Authorization':'Bearer '+response.json()['token'],'X-Ynote-Protocol':'1'}

    def test_lease_origin_isolation_strict_configuration_expiry_and_no_token_status(self):
        relay=self.relay()
        self.assertEqual(set(relay.status(A)),{'configured','origin','expires_at'})
        self.assertNotIn(TOKEN_A,json.dumps(relay.status(A)))
        self.assertNotIn(TOKEN_B,json.dumps(relay.status(B)))
        invalid=[{'token':TOKEN_A,'origin':B,'expires_at':2000},{'token':'short','origin':A,'expires_at':2000},{'token':'x'*32+'\n','origin':A,'expires_at':2000},{'token':TOKEN_A,'origin':A,'expires_at':999},{'token':TOKEN_A,'origin':A,'expires_at':5000},{'token':TOKEN_A,'origin':A,'expires_at':True},{'token':TOKEN_A,'origin':A,'expires_at':2000,'api_key':'not-accepted'}]
        for body in invalid:
            with self.subTest(fields=set(body)):
                with self.assertRaises(BillingError):relay.configure(body,A)
        bad=CloudRelay(('http://127.0.0.1:8790',),clock=lambda:1000)
        with self.assertRaises(BillingError):bad.configure({'token':TOKEN_A,'origin':'http://127.0.0.1:8790','expires_at':2000},'http://127.0.0.1:8790')
        calls=[]
        with patch.object(relay,'_post',side_effect=lambda origin,path,**kwargs:(calls.append((origin,path,kwargs)) or {'text':'text','provider':'gateway','model':'test'})):
            relay.text('A prompt',self.body(A));relay.text('B prompt',self.body(B))
        self.assertEqual([call[0] for call in calls],[A,B])
        self.assertTrue(all(set(call[2]['json'])=={'tool','billing_mode','idempotency_key','prompt'} for call in calls))
        relay.clear(B);self.assertTrue(relay.status(A)['configured']);self.assertFalse(relay.status(B)['configured'])
        relay.clock=lambda:2000
        with self.assertRaises(BillingError):relay.text('expired',self.body(A))
        self.assertFalse(relay.status(A)['configured'])

    def test_https_transport_pins_public_ip_sni_host_and_never_retries_or_uses_proxy_env(self):
        relay=self.relay()
        result=httpx.Response(200,json={'text':'response','provider':'gateway','model':'test'})
        with patch('companion.cloud_relay.public_addresses',return_value=['8.8.8.8']),patch('companion.cloud_relay.httpx.Client') as factory:
            client=factory.return_value.__enter__.return_value
            client.build_request.side_effect=lambda method,url,**kwargs:httpx.Request(method,url,**kwargs)
            client.send.return_value=result
            relay.text('prompt',self.body(A))
            request=client.send.call_args.args[0]
            self.assertEqual(request.url.host,'8.8.8.8')
            self.assertEqual(request.url.path,'/api/relay/text')
            self.assertEqual(request.headers['Host'],'ynote.example')
            self.assertEqual(request.headers['Origin'],A)
            self.assertEqual(request.headers['Authorization'],'Bearer '+TOKEN_A)
            self.assertEqual(request.extensions['sni_hostname'],'ynote.example')
            self.assertFalse(factory.call_args.kwargs['trust_env']);self.assertFalse(factory.call_args.kwargs['follow_redirects'])
            client.send.reset_mock();client.send.return_value=httpx.Response(302,headers={'location':'http://127.0.0.1/private'})
            with self.assertRaises(BillingError):relay.text('prompt',self.body(A))
            self.assertEqual(client.send.call_count,1)

    def test_video_uploads_only_real_normalized_mp3_and_cleans_local_temporary_audio(self):
        relay=self.relay();video=self.video();original=hashlib.sha256(video.read_bytes()).hexdigest();paths=[]
        def post(origin,path,**kwargs):
            self.assertEqual(origin,A);self.assertEqual(path,'/api/relay/transcribe')
            self.assertEqual(set(kwargs),{'data','files'})
            self.assertEqual(set(kwargs['files']),{'file'});filename,audio,mime=kwargs['files']['file']
            self.assertEqual((filename,mime),('prepared-audio.mp3','audio/mpeg'))
            paths.append(Path(audio.name));self.assertNotEqual(Path(audio.name),video)
            metadata=json.loads(subprocess.run(['ffprobe','-v','error','-show_entries','format=format_name:stream=codec_type,channels,sample_rate','-of','json',audio.name],capture_output=True,check=True).stdout)
            self.assertEqual(metadata['format']['format_name'],'mp3')
            self.assertEqual(metadata['streams'],[{'codec_type':'audio','sample_rate':'16000','channels':1}])
            body=json.loads(kwargs['data']['body']);self.assertEqual(body,{key:value for key,value in self.body().items() if key!='_relay_origin'})
            return {'text':'offline ASR','segments':[]}
        with patch.object(relay,'_post',side_effect=post):self.assertEqual(relay.transcribe(video,self.body())['text'],'offline ASR')
        self.assertEqual(hashlib.sha256(video.read_bytes()).hexdigest(),original)
        self.assertTrue(paths);self.assertTrue(all(not path.exists() for path in paths))

    def test_local_pair_configure_status_and_revoke_are_origin_bound(self):
        app=create_companion(self.root/'helper',approval=lambda message:True,origins=(A,B))
        client=TestClient(app,base_url='http://127.0.0.1:18790')
        try:
            first=self.pair(client,A);second=self.pair(client,B)
            expiry=time.time()+1800
            for origin,headers,token in [(A,first,TOKEN_A),(B,second,TOKEN_B)]:
                response=client.post('/v1/cloud/configure',headers=headers,json={'token':token,'origin':origin,'expires_at':expiry})
                self.assertEqual(response.status_code,200,response.text);self.assertTrue(response.json()['configured'])
                self.assertNotIn(token,response.text)
            wrong=client.post('/v1/cloud/configure',headers=first,json={'token':TOKEN_A,'origin':B,'expires_at':expiry})
            self.assertEqual(wrong.status_code,422)
            raw_key=client.post('/v1/cloud/configure',headers=first,json={'token':TOKEN_A,'origin':A,'expires_at':expiry,'api_key':'not-accepted'})
            self.assertEqual(raw_key.status_code,422)
            health=client.get('/v1/health',headers={'Origin':A}).json()
            self.assertIn('cloud_model_relay',health['capabilities']);self.assertFalse(health['model_ready'])
            app.state.tools.state='ready'
            self.assertTrue(client.get('/v1/health',headers={'Origin':A}).json()['ready'])
            client.post('/v1/session/revoke',headers=second)
            self.assertTrue(client.get('/v1/cloud/status',headers=first).json()['configured'])
            self.assertFalse(app.state.cloud_relay.status(B)['configured'])
        finally:app.state.core.state.store.db.close()

    def test_real_small_video_full_task_keeps_assets_local_and_only_sends_audio_text(self):
        app=create_companion(self.root/'helper',approval=lambda message:True,origins=(A,B));app.state.tools.state='ready'
        client=TestClient(app,base_url='http://127.0.0.1:18790');video=self.video();calls=[]
        try:
            headers=self.pair(client,A)
            app.state.cloud_relay.configure({'token':TOKEN_A,'origin':A,'expires_at':time.time()+1800},A)
            app.state.cloud_relay.configure({'token':TOKEN_B,'origin':B,'expires_at':time.time()+1800},B)
            def post(origin,path,**kwargs):
                calls.append((origin,path,kwargs))
                self.assertEqual(origin,A)
                if path=='/api/relay/transcribe':
                    filename,audio,mime=kwargs['files']['file'];self.assertEqual(filename,'prepared-audio.mp3');self.assertEqual(mime,'audio/mpeg')
                    self.assertNotEqual(Path(audio.name),video)
                    metadata=json.loads(subprocess.run(['ffprobe','-v','error','-show_entries','format=format_name:stream=codec_type','-of','json',audio.name],capture_output=True,check=True).stdout)
                    self.assertEqual(metadata['format']['format_name'],'mp3');self.assertTrue(all(s['codec_type']=='audio' for s in metadata['streams']))
                    return {'text':'只用于离线链路验证的原文。','segments':[]}
                self.assertEqual(path,'/api/relay/text')
                body=kwargs['json'];self.assertNotIn('_relay_origin',body)
                segment=re.findall(r'\[([a-f0-9]{32})\]',body['prompt'])[0]
                return {'text':'# 离线笔记\n\n## 核心要点\n- 依据原文。 ['+segment+']','provider':'gateway','model':'offline-model'}
            with patch.object(app.state.cloud_relay,'_post',side_effect=post):
                imported=client.post('/v1/local/api/materials/import',headers=headers,files={'file':('source.mp4',video.read_bytes(),'video/mp4')})
                self.assertEqual(imported.status_code,200,imported.text);self.assertEqual(calls,[])
                mid=imported.json()['material']['id']
                task=client.post('/v1/local/api/tasks',headers=headers,json={'source_id':mid}).json()
                response=client.post('/v1/local/api/tasks/'+task['id']+'/start',headers=headers,json={'tool':'ynote','billing_mode':'platform','_relay_origin':B})
                self.assertEqual(response.status_code,200,response.text)
                for _ in range(400):
                    detail=client.get('/v1/local/api/tasks/'+task['id'],headers=headers).json()
                    if detail['task']['state'] not in ('queued','running'):break
                    time.sleep(.03)
                self.assertEqual(detail['task']['state'],'succeeded',detail['task'])
            self.assertEqual([call[1] for call in calls],['/api/relay/transcribe','/api/relay/text'])
            self.assertTrue({'video','audio','cover'}.issubset({a['kind'] for a in detail['assets']}))
            self.assertFalse(any(a['kind']=='image' for a in detail['assets']))
            self.assertIsNotNone(detail['transcript']);self.assertIsNotNone(detail['note'])
            for asset in detail['assets']:
                self.assertTrue(app.state.core.state.store.path(asset['relative_path']).is_file())
            stored=json.dumps(app.state.core.state.store.all('task')+app.state.core.state.store.all('job_request'))
            self.assertIn(A,stored);self.assertNotIn(TOKEN_A,stored);self.assertNotIn(TOKEN_B,stored)
        finally:app.state.core.state.store.db.close()

    def test_gateway_json_limit_and_invalid_body_do_not_create_tasks(self):
        app=create_companion(self.root/'helper',approval=lambda message:True,origins=(A,));app.state.tools.state='ready'
        client=TestClient(app,base_url='http://127.0.0.1:18790')
        try:
            headers=self.pair(client,A)
            for content,status in [(b'[]',422),(b'{bad',422),(b'{"raw_input":"'+b'x'*262144+b'"}',413)]:
                response=client.post('/v1/local/api/tasks',headers={**headers,'Content-Type':'application/json'},content=content)
                self.assertEqual(response.status_code,status,response.text)
            response=client.post('/v1/local/api/tasks',headers=headers,json={'api_key':'not-accepted'})
            self.assertEqual(response.status_code,422)
            self.assertEqual(app.state.core.state.store.all('task'),[])
        finally:app.state.core.state.store.db.close()

    def test_default_cloud_companion_does_not_hash_optional_medium_model(self):
        with patch.object(Model,'verify',return_value=False) as verify:
            app=create_companion(self.root/'helper',approval=lambda message:True,origins=(A,))
            try:
                verify.assert_not_called()
                self.assertFalse(app.state.model.loaded)
                Model(self.root/'explicit-medium')
                verify.assert_called_once()
            finally:app.state.core.state.store.db.close()

    def test_helper_forwards_only_valid_mode_enum_for_text_and_audio(self):
        relay=self.relay();video=self.video();calls=[]
        def post(origin,path,**kwargs):
            body=kwargs['json'] if path.endswith('/text') else json.loads(kwargs['data']['body'])
            calls.append((path,body))
            return {'text':'offline','provider':'gateway','model':'server-selected','segments':[]}
        with patch.object(relay,'_post',side_effect=post) as transport:
            for mode in ('quick','precise'):
                body={**self.body(),'extraction_mode':mode}
                relay.text('prompt',body);relay.transcribe(video,body)
                self.assertEqual(calls[-1][1]['extraction_mode'],mode)
                self.assertEqual(calls[-2][1]['extraction_mode'],mode)
                self.assertNotIn('model',calls[-1][1]);self.assertNotIn('base_url',calls[-1][1])
            before=transport.call_count
            for mode in ('bad',None,True,{},[]):
                with self.assertRaises(BillingError):relay.text('prompt',{**self.body(),'extraction_mode':mode})
            for field in ('model','base_url'):
                with self.assertRaises(BillingError):relay.text('prompt',{**self.body(),'extraction_mode':'quick',field:'not-client-controlled'})
            self.assertEqual(transport.call_count,before)


if __name__=='__main__':unittest.main()
