import io,json,os,subprocess,tempfile,time,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend.app import create_app,parse_text,safe_source_url,Problem

class API(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.app=create_app(self.tmp.name);self.client=TestClient(self.app)
    def tearDown(self):
        self.app.state.store.db.close();self.tmp.cleanup()
    def upload(self,name='lesson.txt',text=b'Alpha project ships Friday.\nBudget is 42 dollars.'):
        r=self.client.post('/api/materials/import',files={'file':(name,text)})
        self.assertEqual(r.status_code,200,r.text);return r.json()['material']
    def job(self,id,operations,key='test',**kwargs):
        r=self.client.post(f'/api/materials/{id}/jobs',json={'operations':operations,'idempotency_key':key,**kwargs});self.assertEqual(r.status_code,200,r.text);jid=r.json()['job']['id']
        for _ in range(200):
            j=self.client.get('/api/jobs/'+jid).json()['job']
            if j['state'] in ('succeeded','failed','partial','needs_action','cancelled'):return j
            time.sleep(.03)
        self.fail('job did not finish')
    def test_persistent_text_workflow(self):
        m=self.upload();mid=m['id'];tr=self.client.get(f'/api/materials/{mid}/transcript').json();self.assertEqual(tr['total_segments'],2);self.assertIsNone(tr['segments'][0]['start_ms'])
        j=self.job(mid,['transcript']);self.assertEqual(j['state'],'succeeded')
        n=self.client.post(f'/api/materials/{mid}/notes',json={'transcript_version_id':tr['version']['id'],'provider':'extractive'});self.assertEqual(n.status_code,200);self.assertIn('非 AI',n.json()['note']['markdown'])
        c=self.client.post(f'/api/materials/{mid}/chat',json={'question':'Budget','provider':'extractive'}).json()['conversation'];self.assertEqual(c['messages'][-1]['citations'][0]['quote'],'Budget is 42 dollars.')
        d=self.client.get('/api/materials/'+mid).json();self.assertIsNotNone(d['note']);self.assertIsNotNone(d['conversation']);self.assertEqual(len(d['jobs']),1)
        self.assertEqual(self.client.post(f'/api/materials/{mid}/notes',json={}).status_code,409)
        self.assertEqual(self.client.post(f'/api/materials/{mid}/exports',json={'scope':'transcript','format':'srt'}).status_code,400)
        exp=self.client.post(f'/api/materials/{mid}/exports',json={'scope':'full_package','format':'zip'}).json();z=zipfile.ZipFile(io.BytesIO(self.client.get(exp['download_url']).content));self.assertIn('note.md',z.namelist());self.assertNotIn('settings',str(z.namelist()))
        second=create_app(self.tmp.name);self.assertEqual(len(TestClient(second).get('/api/materials').json()['materials']),1);second.state.store.db.close()
    def test_srt_range_and_events(self):
        m=self.upload('lesson.srt',b'1\n00:00:01,200 --> 00:00:03,500\nA real caption.\n');mid=m['id'];tr=self.client.get(f'/api/materials/{mid}/transcript').json();self.assertEqual(tr['segments'][0]['start_ms'],1200)
        asset=self.client.get(f'/api/materials/{mid}/assets').json()['assets'][0]
        r=self.client.get('/api/assets/'+asset['id']+'/download',headers={'Range':'bytes=0-3'});self.assertEqual(r.status_code,206);self.assertEqual(len(r.content),4)
        r=self.client.get('/api/assets/'+asset['id']+'/download',headers={'Range':'bytes=999999-'});self.assertEqual(r.status_code,416)
        j=self.job(mid,['transcript']);events=self.client.get('/api/jobs/'+j['id']+'/events').text;self.assertIn('job_done',events)
        last=max(int(x[4:]) for x in events.splitlines() if x.startswith('id: '));self.assertEqual(self.client.get('/api/jobs/'+j['id']+'/events?last_event_id='+str(last)).text,'')
        r=self.client.post(f'/api/materials/{mid}/jobs',json={'operations':['transcript'],'idempotency_key':'test'});self.assertEqual(r.json()['job']['id'],j['id'])
        r=self.client.post(f'/api/materials/{mid}/jobs',json={'operations':['audio'],'idempotency_key':'test'});self.assertEqual(r.status_code,409)
    def test_secret_mask_and_validation(self):
        cfg={'text_ai':{'base_url':'https://example.com/v1','api_key':'fake-test-secret-12345','model':'test-model'}}
        r=self.client.put('/api/settings/providers',json=cfg);self.assertNotIn('fake-test-secret',r.text);mask=r.json()['text_ai']['api_key_masked']
        cfg['text_ai']['api_key']=mask;self.client.put('/api/settings/providers',json=cfg);self.assertEqual(self.app.state.store.get('settings','providers')['text_ai']['api_key'],'fake-test-secret-12345')
        self.assertEqual(self.client.get('/api/health',headers={'Host':'evil.example'}).status_code,403)
        self.assertEqual(self.client.post('/api/materials/import',headers={'Origin':'https://evil.example'},files={'file':('x.txt',b'x')}).status_code,403)
        m=self.upload();self.assertEqual(self.client.post(f"/api/materials/{m['id']}/jobs",json={'operations':[{}],'idempotency_key':'x'}).status_code,400)
        with self.assertRaises(Problem):safe_source_url('http://127.0.0.1/a')
        with self.assertRaises(Problem):safe_source_url('http://youtube.com:bad/a')
    def test_media_actual_extraction(self):
        path=Path(self.tmp.name)/'fixture.mp4'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=320x240:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',str(path)],check=True)
        m=self.upload('test.mp4',path.read_bytes());j=self.job(m['id'],['cover','audio','images','video']);self.assertEqual(j['state'],'succeeded',j)
        assets=self.client.get(f"/api/materials/{m['id']}/assets").json()['assets'];self.assertTrue({'cover','audio','image','video'} <= {a['kind'] for a in assets})
        blocked=self.job(m['id'],['video'],key='watermark',variant_policy='no_watermark_only');self.assertEqual(blocked['state'],'needs_action');self.assertEqual(blocked['error_code'],'NO_CLEAN_SOURCE')
        missing=self.job(m['id'],['transcript'],key='noasr');self.assertEqual(missing['state'],'needs_action')
        import httpx
        self.client.put('/api/settings/providers',json={'transcription':{'engine':'remote','base_url':'https://asr.example/v1','api_key':'fake-test-only','model':'test'}})
        response=httpx.Response(200,json={'segments':[{'start':0.1,'end':0.8,'text':'Real mocked ASR segment'}]},request=httpx.Request('POST','https://asr.example/v1/audio/transcriptions'))
        with patch('backend.app.httpx.Client') as factory:
            factory.return_value.__enter__.return_value.post.return_value=response
            r=self.client.post('/api/jobs/'+missing['id']+'/retry',json={});self.assertEqual(r.status_code,200,r.text)
            for _ in range(100):
                state=self.client.get('/api/jobs/'+missing['id']).json()['job']['state']
                if state in ('succeeded','failed','needs_action'):break
                time.sleep(.02)
            self.assertEqual(state,'succeeded')
        transcript=self.client.get(f"/api/materials/{m['id']}/transcript").json()
        self.assertEqual(transcript['segments'][0]['start_ms'],100)

    def test_mocked_provider_and_restore(self):
        import httpx
        m=self.upload();mid=m['id'];tr=self.client.get(f'/api/materials/{mid}/transcript').json();sid=tr['segments'][0]['id']
        self.client.put('/api/settings/providers',json={'text_ai':{'base_url':'https://one.example/v1','api_key':'fake-secret-one','model':'test'}})
        response=httpx.Response(200,json={'choices':[{'message':{'content':'A grounded answer ['+sid+']'}}]},request=httpx.Request('POST','https://one.example/v1/chat/completions'))
        with patch('backend.app.httpx.Client') as factory:
            fake=factory.return_value.__enter__.return_value.post;fake.return_value=response
            r=self.client.post(f'/api/materials/{mid}/chat',json={'question':'When?'})
            self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['conversation']['messages'][-1]['citations'][0]['segment_id'],sid)
            self.assertEqual(fake.call_count,1)
        self.client.put('/api/settings/providers',json={'text_ai':{'base_url':'https://two.example/v1','model':'test'}})
        self.assertEqual(self.app.state.store.get('settings','providers')['text_ai']['api_key'],'')
        self.client.delete('/api/materials/'+mid);r=self.client.post('/api/trash/'+mid+'/restore');self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(self.client.get('/api/materials/'+mid+'/transcript').json()['segments'][0]['id'],sid)

    def test_delete_is_recoverable(self):
        m=self.upload();self.assertEqual(self.client.delete('/api/materials/'+m['id']).status_code,200);self.assertEqual(self.client.get('/api/materials/'+m['id']).status_code,404);self.assertTrue(list((Path(self.tmp.name)/'trash').iterdir()))

if __name__=='__main__':unittest.main()
