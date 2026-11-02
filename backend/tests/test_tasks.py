import subprocess
import re
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from fastapi.testclient import TestClient
from backend.app import create_app
from backend.billing import BillingError


class OfflineModels:
    """Replace only provider inference; media decoding and persistence stay real."""
    def __init__(self):self.asr_calls=0;self.text_calls=0
    def transcribe(self,path,body):
        self.asr_calls+=1
        return {'text':'离线服务替身返回的测试原文。','segments':[]}
    def text(self,prompt,body):
        self.text_calls+=1
        segment=re.findall(r'\[([a-f0-9]{32})\]',prompt)[0]
        return '# 测试笔记\n\n## 要点\n- 根据测试原文整理。 ['+segment+']',{'model':'offline-model'}


class TaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.models=OfflineModels()
        self.app = create_app(self.temp.name,remote_service=self.models,secure_remote=True)
        self.client = TestClient(self.app)
        self.client.put('/api/tasks/preferences', json={'transcribe': False,'auto_note':False, 'image_count': 2})
        self.sample = Path(self.temp.name) / 'sample.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=320x180:r=12:d=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(self.sample)], check=True)

    def tearDown(self):
        self.app.state.store.db.close()
        self.temp.cleanup()

    def upload(self):
        response = self.client.post('/api/materials/import', files={'file': ('本地示例.mp4', self.sample.read_bytes())})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['material']['id']

    def wait(self, id,expected='succeeded'):
        for _ in range(400):
            detail = self.client.get('/api/tasks/' + id).json()
            if detail['task']['state'] not in ('queued', 'running'):
                self.assertEqual(detail['task']['state'], expected, detail['task'])
                return detail
            time.sleep(.03)
        self.fail('task timed out')

    def test_blank_tasks_and_import_do_not_extract(self):
        a = self.client.post('/api/tasks', json={}).json()
        b = self.client.post('/api/tasks', json={}).json()
        self.assertNotEqual(a['id'], b['id'])
        self.assertEqual(a['raw_input'], '')
        source = self.upload()
        self.client.put('/api/tasks/' + a['id'] + '/input', json={'source_id': source, 'raw_input': '本地示例.mp4'})
        self.assertEqual(self.app.state.store.all('media_job'), [])
        self.assertEqual(self.app.state.store.all('job'), [])
        self.assertEqual(self.client.get('/api/tasks/' + b['id']).json()['assets'], [])
        self.assertEqual(self.client.get('/api/tasks/' + a['id']).json()['task']['state'], 'draft')

    def test_unknown_task_start_is_typed_and_does_not_create_or_run_any_job(self):
        before=len(self.app.state.store.all('task'))
        with patch('backend.tasks.launch_task') as launch:
            response=self.client.post('/api/tasks/unknown-task-id/start',json={'raw_input':'https://www.bilibili.com/video/BVunknown/','extraction_mode':'quick'})
            self.assertEqual(response.status_code,404,response.text)
            self.assertEqual(response.json()['error']['code'],'TASK_NOT_FOUND')
            self.assertEqual(response.json()['error']['message'],'任务不存在')
            launch.assert_not_called()
        self.assertEqual(len(self.app.state.store.all('task')),before)
        self.assertEqual(self.app.state.store.all('media_job'),[])

    def test_real_single_task_and_durable_results(self):
        source = self.upload()
        task = self.client.post('/api/tasks', json={'source_id': source, 'raw_input': '本地示例.mp4'}).json()
        self.assertEqual(self.client.post('/api/tasks/' + task['id'] + '/start', json={}).status_code, 200)
        result = self.wait(task['id'])
        kinds = [a['kind'] for a in result['assets']]
        self.assertIn('video', kinds); self.assertIn('audio', kinds); self.assertIn('cover', kinds)
        self.assertEqual(kinds.count('image'), 0)
        self.assertIsNotNone(result['transcript'])
        self.assertIn('## 要点',result['note']['markdown'])
        self.assertTrue(result['task']['preferences']['transcribe'])
        self.assertTrue(result['task']['preferences']['auto_note'])
        self.assertEqual((self.models.asr_calls,self.models.text_calls),(1,1))
        self.assertEqual(self.client.put('/api/tasks/' + task['id'] + '/input', json={'raw_input': 'other'}).status_code, 409)
        second = create_app(self.temp.name)
        try:
            restored = TestClient(second).get('/api/tasks/' + task['id']).json()
            self.assertEqual(len(restored['assets']), len(result['assets']))
        finally:
            second.state.store.db.close()

    def test_real_three_row_batch_produces_separate_results(self):
        entries = [{'source_id': self.upload(), 'raw_input': f'视频{i}.mp4'} for i in range(3)]
        result = self.client.post('/api/tasks/batch', json={'entries': entries})
        self.assertEqual(result.status_code, 200, result.text)
        result = result.json()
        details = [self.wait(task['id']) for task in result['tasks']]
        self.assertEqual({d['task']['batch_index'] for d in details}, {1, 2, 3})
        self.assertEqual(len({d['material']['id'] for d in details}), 3)
        self.assertTrue(all(d['task']['batch_id'] == result['batch_id'] for d in details))
        self.assertTrue(all(any(a['kind'] == 'audio' for a in d['assets']) for d in details))
        self.assertTrue(all(sum(a['kind']=='image' for a in d['assets'])==0 and sum(a['kind']=='cover' for a in d['assets'])==1 for d in details))
        self.assertTrue(all(d['transcript'] and d['note'] for d in details))
        self.assertEqual((self.models.asr_calls,self.models.text_calls),(3,3))

    def test_mixed_batch_validation_and_append(self):
        source = self.upload()
        with patch('backend.tasks.launch_task'):
            result = self.client.post('/api/tasks/batch', json={'entries': [{'source_id': source}, {'raw_input': 'https://www.bilibili.com/video/BV1GJ411x7h7'}]})
            self.assertEqual(result.status_code, 200, result.text)
            group = result.json()['batch_id']
            appended = self.client.post('/api/tasks/batch', json={'batch_id': group, 'entries': [{'source_id': source}]}).json()
            self.assertEqual(appended['tasks'][0]['batch_index'], 3)
        previous = len(self.app.state.store.all('task'))
        invalid = self.client.post('/api/tasks/batch', json={'entries': [{'source_id': source}, {'raw_input': 'not a link'}]})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(len(self.app.state.store.all('task')), previous)

    def test_preferences_validation(self):
        for values in [{'image_count': 0}, {'quality': 'malicious'}, {'audio_bitrate': 'bad'}, {'transcribe': 'yes'}]:
            self.assertEqual(self.client.put('/api/tasks/preferences', json=values).status_code, 400)
        self.client.put('/api/tasks/preferences', json={'image_count': 4, 'note_style': 'detailed', 'audio_bitrate': '320'})
        config = self.client.get('/api/tasks/preferences').json()
        self.assertEqual(config['image_count'], 4)
        self.assertEqual(config['note_style'], 'detailed')

    def test_start_snapshot_forces_full_workflow_and_keeps_valid_frame_count(self):
        source=self.upload()
        self.client.put('/api/tasks/preferences',json={'transcribe':False,'auto_note':False,'image_count':4})
        with patch('backend.tasks.launch_task'):
            task=self.client.post('/api/tasks',json={'source_id':source}).json()
            started=self.client.post('/api/tasks/'+task['id']+'/start',json={}).json()
            self.assertTrue(started['preferences']['transcribe'])
            self.assertTrue(started['preferences']['auto_note'])
            self.assertEqual(started['preferences']['image_count'],4)
            self.app.state.store.put('settings',{'id':'extraction','image_count':'invalid-old-value','auto_note':False})
            other=self.client.post('/api/tasks',json={'source_id':source}).json()
            sanitized=self.client.post('/api/tasks/'+other['id']+'/start',json={}).json()
            self.assertEqual(sanitized['preferences']['image_count'],3)

    def test_cancelled_queue_cannot_restart_an_old_run(self):
        task = self.client.post('/api/tasks', json={'source_id': self.upload()}).json()
        with patch('backend.tasks.launch_task') as launch:
            first = self.client.post('/api/tasks/' + task['id'] + '/start', json={}).json()
            runner = launch.call_args.args[1]
            cancelled = self.client.post('/api/tasks/' + task['id'] + '/cancel').json()
            self.assertEqual(cancelled['state'], 'cancelled')
            second = self.client.post('/api/tasks/' + task['id'] + '/start', json={}).json()
            self.assertNotEqual(first['run_id'], second['run_id'])
            runner(task['id'], first['run_id'])
            self.assertEqual(self.app.state.store.get('task', task['id'])['run_id'], second['run_id'])
            self.assertEqual(self.app.state.store.all('media_job'), [])
            self.assertEqual(self.client.post('/api/tasks/' + task['id'] + '/start', json={}).status_code, 409)
            runner(task['id'], second['run_id'])
        self.assertEqual(self.client.get('/api/tasks/' + task['id']).json()['task']['state'], 'succeeded')

    def repair_fixture(self,state='partial',media_failure=False,cover_failure=False,extraction_mode='precise'):
        task=self.client.post('/api/tasks',json={'source_id':self.upload()}).json()
        self.client.post('/api/tasks/'+task['id']+'/start',json={'extraction_mode':extraction_mode})
        detail=self.wait(task['id']);store=self.app.state.store
        task=detail['task'];task.update(state=state,stage='文案未获取')
        store.put('task',task)
        original=store.get('job',task['result_job_id'])
        original['state']='partial'
        if cover_failure:original['operations'][0].update(state='failed',error_code='MEDIA_FAILED')
        next(op for op in original['operations'] if op['kind']=='transcript').update(state='needs_action',error_code='TRANSCRIBE_FAILED')
        store.put('job',original)
        for version in store.all('transcript'):
            if version['material_id']==task['material_id']:
                for segment in store.all('segment'):
                    if segment['transcript_version_id']==version['id']:store.remove('segment',segment['id'])
                store.remove('transcript',version['id'])
        for note in store.all('note'):
            if note['material_id']==task['material_id']:store.remove('note',note['id'])
        if media_failure:
            media=store.get('media_job',task['media_job_ids'][-1]);media['state']='failed';store.put('media_job',media)
        return task

    def finish_text_repair(self,task,body=None):
        response=self.client.post('/api/tasks/'+task['id']+'/transcript',json=body or {})
        self.assertEqual(response.status_code,200,response.text);jid=response.json()['job']['id']
        for _ in range(100):
            result=self.client.get('/api/jobs/'+jid).json()['job']
            if result['state'] not in ('queued','running'):break
            time.sleep(.02)
        self.assertEqual(result['state'],'succeeded',result)
        return jid

    def test_repaired_transcript_updates_task_history_and_repeated_requests_reuse_result(self):
        task=self.repair_fixture(state='failed')
        with patch.object(self.models,'transcribe',return_value={'text':'原文已恢复。'}) as provider:
            jid=self.finish_text_repair(task)
            detail=self.client.get('/api/tasks/'+task['id']).json()
            self.assertEqual(detail['task']['state'],'succeeded')
            self.assertEqual(detail['task']['stage'],'提取完成')
            self.assertEqual(detail['transcript']['segments'][0]['text'],'原文已恢复。')
            history=self.client.get('/api/tasks').json()['tasks']
            self.assertEqual(next(t for t in history if t['id']==task['id'])['state'],'succeeded')
            for _ in range(3):
                again=self.client.post('/api/tasks/'+task['id']+'/transcript',json={})
                self.assertEqual(again.status_code,200,again.text)
                self.assertEqual(again.json()['job']['id'],jid)
            self.assertEqual(provider.call_count,1)
        self.assertEqual(self.app.state.store.get('task',task['id'])['state'],'succeeded')

    def test_transcript_repair_does_not_hide_failed_media_or_cover(self):
        for media_failure,cover_failure in [(True,False),(False,True)]:
            with self.subTest(media_failure=media_failure,cover_failure=cover_failure):
                task=self.repair_fixture(media_failure=media_failure,cover_failure=cover_failure)
                with patch.object(self.models,'transcribe',return_value={'text':'文案成功，其他媒体仍有失败。'}):
                    self.finish_text_repair(task)
                detail=self.client.get('/api/tasks/'+task['id']).json()
                self.assertEqual(detail['task']['state'],'partial')
                self.assertIsNotNone(detail['transcript'])
                history=self.client.get('/api/tasks').json()['tasks']
                self.assertEqual(next(t for t in history if t['id']==task['id'])['state'],'partial')

    def test_running_text_repair_is_reused_and_uncertain_remote_result_is_not_resent(self):
        task=self.repair_fixture();store=self.app.state.store
        job={'id':'existing-repair','material_id':task['material_id'],'state':'running','operations':[{'kind':'transcript','state':'running'}]}
        store.put('job',job);task['text_job_id']=job['id'];store.put('task',task)
        with patch('backend.app.httpx.Client') as provider:
            response=self.client.post('/api/tasks/'+task['id']+'/transcript',json={})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()['job']['id'],job['id'])
            provider.assert_not_called()
            job['state']='needs_action';job['operations'][0].update(state='needs_action',error_code='ACCOUNTING_REVIEW');store.put('job',job)
            blocked=self.client.post('/api/tasks/'+task['id']+'/transcript',json={})
            self.assertEqual(blocked.status_code,503,blocked.text)
            self.assertEqual(blocked.json()['error']['code'],'ACCOUNTING_REVIEW')
            provider.assert_not_called()

    def test_audio_only_input_creates_audio_transcript_and_note_without_video_or_images(self):
        audio=Path(self.temp.name)/'audio.wav'
        subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-f','lavfi','-i','sine=duration=1',str(audio)],check=True)
        uploaded=self.client.post('/api/materials/import',files={'file':('audio.wav',audio.read_bytes())}).json()
        task=self.client.post('/api/tasks',json={'source_id':uploaded['material']['id']}).json()
        self.client.post('/api/tasks/'+task['id']+'/start',json={})
        detail=self.wait(task['id']);kinds={asset['kind'] for asset in detail['assets']}
        self.assertIn('audio',kinds)
        self.assertTrue(kinds.isdisjoint({'video','image','cover'}))
        self.assertIsNotNone(detail['transcript']);self.assertIsNotNone(detail['note'])
        self.assertEqual((self.models.asr_calls,self.models.text_calls),(1,1))

    def test_video_without_audio_remains_partial_with_cover_and_no_fake_text(self):
        video=Path(self.temp.name)/'without-audio.mp4'
        subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-f','lavfi','-i','color=s=160x90:r=12:d=1','-an',str(video)],check=True)
        uploaded=self.client.post('/api/materials/import',files={'file':('without-audio.mp4',video.read_bytes())}).json()
        task=self.client.post('/api/tasks',json={'source_id':uploaded['material']['id']}).json()
        self.client.post('/api/tasks/'+task['id']+'/start',json={})
        detail=self.wait(task['id'],expected='partial')
        self.assertIn('未检测到音轨',detail['task']['stage'])
        kinds={asset['kind'] for asset in detail['assets']}
        self.assertTrue({'video','cover'}.issubset(kinds));self.assertNotIn('audio',kinds)
        self.assertIsNone(detail['transcript']);self.assertIsNone(detail['note'])
        self.assertEqual((self.models.asr_calls,self.models.text_calls),(0,0))

    def test_empty_asr_or_failed_notes_preserve_media_and_do_not_report_success(self):
        for failure in ('empty-asr','note-service'):
            with self.subTest(failure=failure):
                task=self.client.post('/api/tasks',json={'source_id':self.upload()}).json()
                context=patch.object(self.models,'transcribe',return_value={'text':'','segments':[]}) if failure=='empty-asr' else patch.object(self.models,'text',side_effect=BillingError('PROVIDER_UNAVAILABLE','离线文本服务失败',503))
                with context:
                    self.client.post('/api/tasks/'+task['id']+'/start',json={})
                    detail=self.wait(task['id'],expected='partial')
                kinds={asset['kind'] for asset in detail['assets']}
                self.assertTrue({'video','audio','cover'}.issubset(kinds))
                self.assertIsNone(detail['note'])
                if failure=='empty-asr':self.assertIsNone(detail['transcript'])
                else:self.assertIsNotNone(detail['transcript'])

    def test_remote_video_pipeline_extracts_one_cover_like_local_video(self):
        # Network metadata/downloads and model inference are replaced; registered
        # video, MP3, frames and cover are decoded/produced by real FFmpeg.
        actual_run=subprocess.run;actual_popen=subprocess.Popen;downloads=[]
        metadata={'id':'offline-remote','title':'远程视频离线链路','uploader':'test','duration':2,'formats':[{'format_id':'combined','url':'https://cdn.example/offline.mp4','ext':'mp4','vcodec':'h264','acodec':'aac','height':180}]}
        def run(command,*args,**kwargs):
            if isinstance(command,list) and 'yt_dlp' in command:
                return subprocess.CompletedProcess(command,0,stdout=json.dumps(metadata).encode() if '--dump-single-json' in command else b'',stderr=b'')
            return actual_run(command,*args,**kwargs)
        def popen(command,*args,**kwargs):
            if isinstance(command,list) and 'yt_dlp' in command:
                audio='--audio-format' in command;downloads.append('mp3' if audio else 'video')
                output=command[command.index('-o')+1].replace('%(ext)s','mp3' if audio else 'mp4')
                command=['ffmpeg','-nostdin','-y','-v','error','-i',str(self.sample)]+(['-vn','-b:a','128k'] if audio else ['-c','copy'])+[output]
            return actual_popen(command,*args,**kwargs)
        with patch('backend.network_dns.public_source_host',return_value=True),patch('backend.tasks.subprocess.run',side_effect=run),patch('backend.media.subprocess.Popen',side_effect=popen),patch('backend.covers.download_cover',return_value=None):
            task=self.client.post('/api/tasks',json={'raw_input':'https://www.bilibili.com/video/BV1offline/'}).json()
            response=self.client.post('/api/tasks/'+task['id']+'/start',json={})
            self.assertEqual(response.status_code,200,response.text)
            detail=self.wait(task['id'])
        self.assertCountEqual(downloads,['video','mp3'])
        self.assertEqual(detail['material']['platform'],'bilibili')
        self.assertTrue({'video','audio','cover'}.issubset({asset['kind'] for asset in detail['assets']}))
        self.assertIsNotNone(detail['transcript']);self.assertIsNotNone(detail['note'])

    def test_modes_validate_before_start_default_precise_and_batch_propagates_quick(self):
        source=self.upload()
        with patch('backend.tasks.launch_task'):
            for mode in ('quick','precise',None):
                task=self.client.post('/api/tasks',json={'source_id':source}).json()
                response=self.client.post('/api/tasks/'+task['id']+'/start',json={} if mode is None else {'extraction_mode':mode})
                self.assertEqual(response.status_code,200,response.text)
                expected=mode or 'precise';started=response.json()
                self.assertEqual(started['extraction_mode'],expected)
                self.assertEqual(started['billing']['extraction_mode'],expected)
            task=self.client.post('/api/tasks',json={'source_id':source}).json()
            invalid=self.client.post('/api/tasks/'+task['id']+'/start',json={'extraction_mode':'raw-model'})
            self.assertEqual(invalid.status_code,422)
            self.assertEqual(self.app.state.store.get('task',task['id'])['state'],'draft')
            before=len(self.app.state.store.all('task'))
            self.assertEqual(self.client.post('/api/tasks/batch',json={'entries':[{'source_id':source}],'extraction_mode':'bad'}).status_code,422)
            self.assertEqual(len(self.app.state.store.all('task')),before)
            batch=self.client.post('/api/tasks/batch',json={'entries':[{'source_id':source},{'source_id':source}],'extraction_mode':'quick'})
            self.assertEqual(batch.status_code,200,batch.text)
            self.assertTrue(all(task['extraction_mode']=='quick' and task['billing']['extraction_mode']=='quick' for task in batch.json()['tasks']))

    def test_quick_task_jobs_and_text_retry_keep_original_mode(self):
        task=self.repair_fixture(extraction_mode='quick')
        self.assertEqual(task['extraction_mode'],'quick')
        original=self.app.state.store.get('job_request',task['result_job_id'])['body']
        self.assertEqual(original['extraction_mode'],'quick')
        with patch.object(self.models,'transcribe',wraps=self.models.transcribe) as asr:
            jid=self.finish_text_repair(task,{'extraction_mode':'precise'})
            self.assertEqual(asr.call_args.args[1]['extraction_mode'],'quick')
        retry=self.app.state.store.get('job_request',jid)['body']
        self.assertEqual(retry['extraction_mode'],'quick')
        self.assertEqual(self.app.state.store.get('task',task['id'])['extraction_mode'],'quick')


if __name__ == '__main__':
    unittest.main()
