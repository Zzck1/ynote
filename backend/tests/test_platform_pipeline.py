"""Offline platform integration. No real credentials or provider calls."""
import copy
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from backend.billing import Ledger,SHARED_ACCOUNT,BillingError,cost
from backend.cloud_service import CloudService,Connections
from backend.cloud import create_cloud_app
from backend.platform_config import PlatformRuntime

PRICE=json.loads((Path(__file__).parents[1]/'platform-price.json').read_text('utf-8'))
SECRET='offline-platform-test-key'


class PlatformPipeline(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.runtime=PlatformRuntime(self.root,copy.deepcopy(PRICE),SECRET,True)
        self.runtime._asr_verified=True
        self.ledger=Ledger(self.root/'ledger.db',10_000_000_000,price=PRICE)
        self.service=CloudService('visitor-a',self.ledger,Connections(),platform_runtime=self.runtime)
        self.audio=self.root/'speech.mp3';self.audio.write_bytes(b'fixture-only')

    def tearDown(self):self.temp.cleanup()

    def probe(self):return subprocess.CompletedProcess([],0,stdout=b'{"format":{"duration":"2.0","format_name":"mp3"},"streams":[{"codec_type":"audio"}]}')

    def body(self,key='asr-one'):return {'tool':'ynote','billing_mode':'platform','idempotency_key':key}

    def test_asr_uses_server_key_documented_form_and_exact_duration_settlement(self):
        response=httpx.Response(200,json={'text':'这是真实格式的离线服务替身。'})
        with patch('backend.cloud_service.subprocess.run',return_value=self.probe()),patch('backend.cloud_service.upstream',return_value=response) as provider:
            result=self.service.transcribe(self.audio,self.body())
            self.assertEqual(result['segments'],[])
            self.assertEqual(self.service.transcribe(self.audio,self.body()),result)
            self.assertEqual(provider.call_count,1)
            self.assertEqual(provider.call_args.args[3],SECRET)
            self.assertEqual(provider.call_args.kwargs['data'],{'model':PRICE['asr']['model']})
            self.assertNotIn('response_format',provider.call_args.kwargs['data'])
        q=self.ledger.quota(SHARED_ACCOUNT)
        self.assertEqual((q['used_nano_cny'],q['reserved_nano_cny']),(str(2*PRICE['asr']['audio_nano_cny_per_second']),'0'))
        with self.ledger.tx() as db:
            state,amount,price=db.execute('SELECT state,cost,price FROM yn_calls').fetchone()
            self.assertEqual((state,amount),('settled',2*PRICE['asr']['audio_nano_cny_per_second']));self.assertEqual(json.loads(price)['kind'],'asr')

    def test_asr_idempotency_conflict_timeout_pause_and_scope(self):
        with patch('backend.cloud_service.subprocess.run',return_value=self.probe()),patch('backend.cloud_service.upstream',return_value=httpx.Response(200,json={'text':'one'})) as provider:
            self.service.transcribe(self.audio,self.body())
            self.audio.write_bytes(b'changed-file')
            with self.assertRaises(BillingError) as e:self.service.transcribe(self.audio,self.body())
            self.assertEqual(e.exception.error['code'],'IDEMPOTENCY_CONFLICT')
            self.assertEqual(provider.call_count,1)
        self.ledger.global_daily=0
        with patch('backend.cloud_service.subprocess.run',return_value=self.probe()),patch('backend.cloud_service.upstream') as provider:
            with self.assertRaises(BillingError) as e:self.service.transcribe(self.audio,self.body('paused'))
            self.assertEqual(e.exception.error['code'],'PLATFORM_BUDGET_PAUSED');provider.assert_not_called()
        self.ledger.global_daily=10_000_000_000
        with patch('backend.cloud_service.subprocess.run',return_value=self.probe()),patch('backend.cloud_service.upstream',side_effect=httpx.ReadTimeout('offline')) as provider:
            with self.assertRaises(BillingError):self.service.transcribe(self.audio,self.body('timeout'))
            with self.assertRaises(BillingError):self.service.transcribe(self.audio,self.body('timeout'))
            self.assertEqual(provider.call_count,1)
        with self.assertRaises(BillingError):self.service.transcribe(self.audio,{'billing_mode':'platform'})

    def test_unknown_tariff_invalid_duration_and_no_unauthorized_key(self):
        self.runtime.price['asr']['audio_nano_cny_per_second']=1
        self.ledger.price['asr']=self.runtime.price['asr']
        with patch('backend.cloud_service.upstream') as provider:
            with self.assertRaises(BillingError):self.service.transcribe(self.audio,self.body())
            provider.assert_not_called()
        self.ledger.price['asr']=copy.deepcopy(PRICE['asr'])
        bad=subprocess.CompletedProcess([],0,stdout=b'{"format":{"duration":"4000"}}')
        with patch('backend.cloud_service.subprocess.run',return_value=bad),patch('backend.cloud_service.upstream') as provider:
            with self.assertRaises(BillingError):self.service.transcribe(self.audio,self.body())
            provider.assert_not_called()

    def test_gateway_real_job_to_transcript_to_note_and_shared_accounting(self):
        # Real FFmpeg input, job execution, transcript storage and note endpoint;
        # only the remote provider transport is replaced.
        subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-b:a','64k',str(self.audio)],check=True)
        app=create_cloud_app(self.root/'gateway',origins=('http://127.0.0.1',),price=PRICE,secure_cookie=False,platform_runtime=self.runtime)
        client=TestClient(app,base_url='http://127.0.0.1',headers={'Origin':'http://127.0.0.1'})
        def respond(method,base,endpoint,key,**kwargs):
            self.assertEqual(key,SECRET)
            if endpoint=='/audio/transcriptions':return httpx.Response(200,json={'text':'这是原文证据。'})
            self.assertEqual(endpoint,'/chat/completions')
            segment=re.findall(r'\[([a-f0-9]{32})\]',kwargs['json']['messages'][-1]['content'])[0]
            return httpx.Response(200,json={'choices':[{'message':{'content':'## 要点\n- 这是原文证据。 ['+segment+']'},'finish_reason':'stop'}],'usage':{'prompt_tokens':30,'completion_tokens':20}})
        try:
            quota=client.get('/api/quota').json()
            self.assertTrue(quota['capabilities']['transcription']['available'])
            self.assertNotIn(SECRET,json.dumps(quota))
            with patch('backend.cloud_service.upstream',side_effect=respond) as provider:
                mid=client.post('/api/materials/import',files={'file':('speech.mp3',self.audio.read_bytes(),'audio/mpeg')}).json()['material']['id']
                r=client.post(f'/api/materials/{mid}/jobs',json={**self.body('job-one'),'operations':['transcript'],'generate_note':True})
                self.assertEqual(r.status_code,200,r.text);jid=r.json()['job']['id']
                for _ in range(150):
                    job=client.get('/api/jobs/'+jid).json()['job']
                    if job['state'] not in ('queued','running'):break
                    time.sleep(.02)
                self.assertEqual(job['state'],'succeeded',job)
                transcript=client.get(f'/api/materials/{mid}/transcript').json()
                self.assertEqual(transcript['segments'][0]['text'],'这是原文证据。')
                self.assertIsNone(transcript['segments'][0]['start_ms'])
                notes=client.get(f'/api/materials/{mid}/notes').json()['notes']
                self.assertIn('## 要点',notes[0]['markdown']);self.assertEqual(provider.call_count,2)
            other=TestClient(app,base_url='http://127.0.0.1')
            q=client.get('/api/quota').json();self.assertNotEqual(q['used_nano_cny'],'0')
            self.assertEqual(q['used_nano_cny'],other.get('/api/quota').json()['used_nano_cny'])
            self.assertEqual(other.get(f'/api/materials/{mid}').status_code,404)
        finally:
            for inner in app.state.private_apps.values():inner.state.store.db.close()

    def test_admin_rejects_remote_and_cross_site_and_persists_without_key_response(self):
        app=create_cloud_app(self.root/'admin',origins=('http://127.0.0.1',),price=PRICE,secure_cookie=False,platform_runtime=self.runtime,local_admin=True)
        client=TestClient(app,base_url='http://127.0.0.1',client=('127.0.0.1',12345))
        page=client.get('/admin/platform');self.assertEqual(page.status_code,200)
        token=re.search('nonce="([^"]+)"',page.text)[1]
        self.assertNotIn(SECRET,page.text)
        self.assertEqual(client.post('/api/admin/platform',json={'api_key':SECRET}).status_code,403)
        headers={'Origin':'http://127.0.0.1','X-Ynote-Admin':token}
        models={'data':[{'id':PRICE['model']},{'id':PRICE['asr']['model']},{'id':PRICE['asr_quick']['model']}]}
        with patch('backend.cloud_service.upstream',return_value=httpx.Response(200,json=models)),patch('backend.admin_config.save_key') as save:
            response=client.post('/api/admin/platform',headers=headers,json={'api_key':SECRET})
            self.assertEqual(response.status_code,200,response.text);save.assert_called_once_with(SECRET)
            self.assertNotIn(SECRET,response.text)
        loaded=PlatformRuntime(self.runtime.root,PRICE,SECRET,True)
        self.assertTrue(loaded.snapshot()[2])
        remote=TestClient(app,base_url='http://127.0.0.1',client=('10.0.0.2',12345))
        self.assertEqual(remote.get('/admin/platform').status_code,403)
        disabled=create_cloud_app(self.root/'no-admin')
        self.assertEqual(TestClient(disabled).get('/admin/platform').status_code,403)

    def test_provider_auth_failure_does_not_overwrite_active_key(self):
        with patch('backend.cloud_service.upstream',return_value=httpx.Response(401)),patch('backend.admin_config.save_key') as save:
            with self.assertRaises(BillingError):self.runtime.verify_and_save('invalid-new-key')
            save.assert_not_called();self.assertEqual(self.runtime.snapshot()[0],SECRET)

    def admin_client(self,root_name='admin-errors'):
        app=create_cloud_app(self.root/root_name,origins=('http://127.0.0.1',),price=PRICE,secure_cookie=False,platform_runtime=self.runtime,local_admin=True)
        client=TestClient(app,base_url='http://127.0.0.1',client=('127.0.0.1',12345))
        page=client.get('/admin/platform');self.assertEqual(page.status_code,200)
        token=re.search('nonce="([^"]+)"',page.text)[1]
        return client,{'Origin':'http://127.0.0.1','X-Ynote-Admin':token}

    def test_admin_storage_failure_is_sanitized_json_503_and_does_not_activate(self):
        self.runtime=PlatformRuntime(self.root/'unconfigured',copy.deepcopy(PRICE))
        client,headers=self.admin_client()
        models={'data':[{'id':PRICE['model']},{'id':PRICE['asr']['model']},{'id':PRICE['asr_quick']['model']}]}
        for failure in [RuntimeError('DPAPI test failure '+SECRET),OSError('Storage test failure '+SECRET)]:
            with self.subTest(failure=type(failure).__name__),patch('backend.cloud_service.upstream',return_value=httpx.Response(200,json=models)) as provider,patch('backend.admin_config.save_key',side_effect=failure):
                response=client.post('/api/admin/platform',headers=headers,json={'api_key':SECRET})
                self.assertEqual(response.status_code,503,response.text)
                self.assertTrue(response.headers['content-type'].startswith('application/json'))
                self.assertEqual(response.json()['error']['code'],'CREDENTIAL_STORAGE_FAILED')
                self.assertNotIn(SECRET,response.text)
                self.assertNotIn('Traceback',response.text)
                self.assertEqual(self.runtime.snapshot(),('',False,False))
                self.assertFalse((self.runtime.root/'platform-verification.json').exists())
                self.assertEqual(provider.call_count,1)

    def test_admin_non_object_or_invalid_json_body_returns_422_before_provider(self):
        client,headers=self.admin_client()
        with patch('backend.cloud_service.upstream') as provider,patch('backend.admin_config.save_key') as save:
            for body in [None,[],[{'api_key':SECRET}],SECRET,42,True]:
                with self.subTest(body_type=type(body).__name__):
                    response=client.post('/api/admin/platform',headers={**headers,'Content-Type':'application/json'},content=json.dumps(body))
                    self.assertEqual(response.status_code,422,response.text)
                    self.assertEqual(response.json()['error']['code'],'INVALID_INPUT')
                    self.assertNotIn(SECRET,response.text)
            response=client.post('/api/admin/platform',headers={**headers,'Content-Type':'application/json'},content='{invalid-json')
            self.assertEqual(response.status_code,422)
            self.assertEqual(response.json()['error']['code'],'INVALID_INPUT')
            provider.assert_not_called();save.assert_not_called()

    def test_admin_invalid_csrf_and_cross_site_return_403_without_provider(self):
        client,headers=self.admin_client()
        attempts=[
            {'Origin':'http://127.0.0.1'},
            {**headers,'X-Ynote-Admin':'incorrect-csrf-token'},
            {**headers,'Origin':'https://untrusted.example'},
            {**headers,'Origin':'null'},
        ]
        with patch('backend.cloud_service.upstream') as provider,patch('backend.admin_config.save_key') as save:
            for attempt in attempts:
                with self.subTest(origin=attempt.get('Origin'),has_csrf='X-Ynote-Admin' in attempt):
                    response=client.post('/api/admin/platform',headers=attempt,json={'api_key':SECRET})
                    self.assertEqual(response.status_code,403,response.text)
                    self.assertIn(response.json()['error']['code'],('ORIGIN_REJECTED','ADMIN_FORBIDDEN'))
                    self.assertNotIn(SECRET,response.text)
            provider.assert_not_called();save.assert_not_called()

    def test_text_malformed_response_marks_review_without_retry(self):
        with patch('backend.cloud_service.upstream',return_value=httpx.Response(200,json={'choices':None})) as provider:
            with self.assertRaises(BillingError) as error:self.service.text('sample',self.body('malformed-text'))
            self.assertEqual(error.exception.error['code'],'ACCOUNTING_REVIEW')
            with self.assertRaises(BillingError):self.service.text('sample',self.body('malformed-text'))
            self.assertEqual(provider.call_count,1)
        with self.ledger.tx() as db:self.assertEqual(db.execute('SELECT state FROM yn_calls').fetchone()[0],'review')

    def test_truncated_text_is_settled_atomically_and_never_returned_from_cache(self):
        response=httpx.Response(200,json={'choices':[{'message':{'content':'incomplete'},'finish_reason':'length'}],'usage':{'prompt_tokens':10,'completion_tokens':10,'prompt_tokens_details':None}})
        with patch('backend.cloud_service.upstream',return_value=response) as provider:
            with self.assertRaises(BillingError) as error:self.service.text('sample',self.body('truncated-text'))
            self.assertEqual(error.exception.error['code'],'OUTPUT_TRUNCATED')
            with self.assertRaises(BillingError):self.service.text('sample',self.body('truncated-text'))
            self.assertEqual(provider.call_count,1)
        with self.ledger.tx() as db:
            state,response=db.execute('SELECT state,response FROM yn_calls').fetchone()
            self.assertEqual(state,'truncated');self.assertIsNone(json.loads(response))
        self.assertEqual(self.ledger.quota(SHARED_ACCOUNT)['reserved_nano_cny'],'0')
        with self.assertRaises(BillingError):cost({'prompt_tokens':1,'completion_tokens':1,'prompt_tokens_details':'invalid'})

    def test_admin_rejects_non_header_key_characters_before_upstream(self):
        with patch('backend.cloud_service.upstream') as provider:
            for value in ['bad\x00key','bad\nkey','bad\x7fkey','密钥']:
                with self.assertRaises(BillingError):self.runtime.verify_and_save(value)
            provider.assert_not_called()

    def test_source_video_is_converted_to_real_audio_and_temporary_file_removed(self):
        video=self.root/'source.mp4'
        subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-f','lavfi','-i','color=s=160x90:r=12:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',str(video)],check=True)
        original=hashlib.sha256(video.read_bytes()).hexdigest();sent=[]
        def respond(method,base,endpoint,key,**kwargs):
            filename,audio,mime=kwargs['files']['file'];sent.append(Path(audio.name))
            result=subprocess.run(['ffprobe','-v','error','-show_entries','format=format_name:stream=codec_type','-of','json',audio.name],capture_output=True,check=True)
            data=json.loads(result.stdout)
            self.assertEqual(data['format']['format_name'],'mp3')
            self.assertEqual([s['codec_type'] for s in data['streams']],['audio'])
            self.assertEqual(mime,'audio/mpeg');self.assertEqual(filename,'audio.mp3')
            return httpx.Response(200,json={'text':'video audio fixture'})
        with patch('backend.cloud_service.upstream',side_effect=respond) as provider:
            self.assertEqual(self.service.transcribe(video,self.body('video'))['text'],'video audio fixture')
            self.assertEqual(provider.call_count,1)
        self.assertEqual(hashlib.sha256(video.read_bytes()).hexdigest(),original)
        self.assertFalse(sent[0].exists())

    def test_failed_audio_conversion_never_calls_provider_or_reserves_budget(self):
        metadata=subprocess.CompletedProcess([],0,stdout=b'{"format":{"duration":"2.0","format_name":"mov,mp4"},"streams":[{"codec_type":"audio"},{"codec_type":"video"}]}')
        with patch('backend.cloud_service.subprocess.run',side_effect=[metadata,subprocess.TimeoutExpired('ffmpeg',180)]),patch('backend.cloud_service.upstream') as provider:
            with self.assertRaises(BillingError):self.service.transcribe(self.audio,self.body('convert-timeout'))
            provider.assert_not_called()
        with self.ledger.tx() as db:self.assertEqual(db.execute('SELECT count(*) FROM yn_calls').fetchone()[0],0)

    def test_video_without_audio_never_calls_provider(self):
        metadata=subprocess.CompletedProcess([],0,stdout=b'{"format":{"duration":"2.0","format_name":"mov,mp4"},"streams":[{"codec_type":"video"}]}')
        with patch('backend.cloud_service.subprocess.run',return_value=metadata),patch('backend.cloud_service.upstream') as provider:
            with self.assertRaises(BillingError):self.service.transcribe(self.audio,self.body('no-audio'))
            provider.assert_not_called()


if __name__=='__main__':unittest.main()
