import tempfile,unittest,time,subprocess
from pathlib import Path
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from backend.app import create_app

class Providers(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.app=create_app(self.tmp.name);self.client=TestClient(self.app)
        self.mid=self.client.post('/api/materials/import',files={'file':('source.txt',b'The shipment departs on Friday.\nThe cost is 42 dollars.')}).json()['material']['id']
        tr=self.client.get('/api/materials/'+self.mid+'/transcript').json();self.vid=tr['version']['id'];self.sid=tr['segments'][0]['id']
        self.client.put('/api/settings/providers',json={'text_ai':{'base_url':'https://model.example/v1','api_key':'fake-provider-secret','model':'test'}})
    def tearDown(self):self.app.state.store.db.close();self.tmp.cleanup()
    def response(self,content):return httpx.Response(200,json={'choices':[{'message':{'content':content}}]},request=httpx.Request('POST','https://model.example/v1/chat/completions'))
    def test_notes_verified_and_unverified(self):
        with patch('backend.app.httpx.Client') as factory:
            request=factory.return_value.__enter__.return_value.post
            request.return_value=self.response('Friday departure ['+self.sid+']')
            r=self.client.post('/api/materials/'+self.mid+'/notes',json={'transcript_version_id':self.vid});self.assertEqual(r.status_code,200,r.text);self.assertIn(self.sid,r.json()['note']['markdown']);self.assertNotIn('fake-provider-secret',r.text)
            request.return_value=self.response('Claim ['+'0'*32+']')
            r=self.client.post('/api/materials/'+self.mid+'/notes',json={});self.assertIn('未验证引用',r.json()['note']['markdown']);self.assertNotIn('0'*32,r.text)
    def test_chat_history_and_unknown_citation(self):
        with patch('backend.app.httpx.Client') as factory:
            request=factory.return_value.__enter__.return_value.post;request.return_value=self.response('Friday ['+self.sid+']')
            c=self.client.post('/api/materials/'+self.mid+'/chat',json={'question':'When does it depart?'}).json()['conversation']
            request.return_value=self.response('Unsupported ['+'0'*32+']')
            r=self.client.post('/api/materials/'+self.mid+'/chat',json={'question':'What about the cost?','conversation_id':c['id']})
            self.assertEqual(r.status_code,200,r.text);self.assertIn('When does it depart?',request.call_args.kwargs['json']['messages'][-1]['content'])
            answer=r.json()['conversation']['messages'][-1];self.assertEqual(answer['citations'],[]);self.assertIn('可验证',answer['content'])
    def test_failed_http_and_timeout_no_secret(self):
        with patch('backend.app.httpx.Client') as factory:
            request=factory.return_value.__enter__.return_value.post
            request.return_value=httpx.Response(401,text='fake-provider-secret',request=httpx.Request('POST','https://model.example/v1/chat/completions'))
            r=self.client.post('/api/materials/'+self.mid+'/notes',json={});self.assertEqual(r.status_code,502);self.assertNotIn('fake-provider-secret',r.text)
            request.side_effect=httpx.ReadTimeout('fake-provider-secret')
            r=self.client.post('/api/materials/'+self.mid+'/chat',json={'question':'When?'});self.assertEqual(r.status_code,502);self.assertNotIn('fake-provider-secret',r.text)
    def test_asr_text_has_no_fabricated_timestamps(self):
        audio=Path(self.tmp.name)/'sample.wav';subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=duration=0.1',str(audio)],check=True)
        mid=self.client.post('/api/materials/import',files={'file':('sample.wav',audio.read_bytes())}).json()['material']['id']
        self.client.put('/api/settings/providers',json={'transcription':{'engine':'remote','base_url':'https://asr.example/v1','model':'test','api_key':'fake-asr-key'}})
        with patch('backend.app.httpx.Client') as factory:
            factory.return_value.__enter__.return_value.post.return_value=httpx.Response(200,json={'text':'Plain provider text'},request=httpx.Request('POST','https://asr.example/v1/audio/transcriptions'))
            j=self.client.post('/api/materials/'+mid+'/jobs',json={'operations':['transcript'],'idempotency_key':'asr-text'}).json()['job']
            for _ in range(100):
                state=self.client.get('/api/jobs/'+j['id']).json()['job']['state']
                if state in ('succeeded','failed','needs_action'):break
                time.sleep(.02)
            self.assertEqual(state,'succeeded')
        t=self.client.get('/api/materials/'+mid+'/transcript').json();self.assertIsNone(t['segments'][0]['start_ms']);self.assertIsNone(t['segments'][0]['end_ms'])
        r=self.client.post('/api/materials/'+mid+'/exports',json={'scope':'transcript','format':'srt'});self.assertEqual(r.status_code,400)

if __name__=='__main__':unittest.main()
