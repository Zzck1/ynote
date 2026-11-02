"""Contract tests plus real FFmpeg conversion; no live-platform dependency."""
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend.app import create_app

INFO = {'id': 'sample', 'title': '中文示例视频', 'uploader': 'Ynote QA', 'duration': 2,
        'formats': [{'format_id': '18', 'url': 'https://cdn.example/video.mp4',
                     'vcodec': 'h264', 'acodec': 'aac', 'height': 360, 'ext': 'mp4'},
                    {'format_id': '140', 'url': 'https://cdn.example/audio.m4a',
                     'vcodec': 'none', 'acodec': 'aac', 'ext': 'm4a'}]}


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(self.temp.name)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.app.state.store.db.close()
        self.temp.cleanup()

    def resolve(self, route='/api/media/resolve'):
        with patch('backend.app.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443))]), patch('backend.media.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(INFO).encode())) as run:
            response = self.client.post(route, json={'raw_input': '分享 https://www.youtube.com/watch?v=example'})
        self.assertEqual(response.status_code, 200, response.text)
        command = run.call_args.args[0]
        self.assertIn('--skip-download', command)
        self.assertIn('--dump-single-json', command)
        self.assertNotIn('-o', command)
        self.assertNotIn('--write-info-json', command)
        self.assertEqual(list(self.app.state.store.files.iterdir()), [])
        self.assertEqual(self.app.state.store.all('asset'), [])
        self.assertEqual(self.app.state.store.all('media_job'), [])
        return response.json()

    def test_resolution_never_downloads_media(self):
        result = self.resolve()
        self.assertEqual(result['title'], '中文示例视频')
        self.assertNotIn('url', result['formats'][0])
        self.client.get('/api/media')
        self.assertEqual(self.app.state.store.all('media_job'), [])

    def test_workspace_resolution_also_metadata_only(self):
        result = self.resolve('/api/materials/resolve')
        self.assertEqual(result['status'], 'resolved')
        self.assertFalse(result['capabilities']['video']['available'])
        self.assertFalse(result['capabilities']['audio']['available'])

    def test_input_and_format_validation(self):
        for text in ['', '纯文字', 'file:///tmp/x', 'http://localhost/test.mp4', 'https://127.0.0.1/x', 'https://youtube.com/x https://youtube.com/y']:
            self.assertEqual(self.client.post('/api/media/resolve', json={'raw_input': text}).status_code, 400)
        result = self.resolve()
        bad = self.client.post(f"/api/media/{result['id']}/prepare", json={'kind': 'video', 'format_id': '--exec dangerous'})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.app.state.store.all('media_job'), [])

    def test_metadata_delete_and_restore(self):
        media = self.resolve()
        mid = media['id']
        self.assertEqual(self.client.delete('/api/materials/' + mid).status_code, 200)
        self.assertEqual(self.client.get('/api/media').json()['items'], [])
        self.assertEqual(self.client.post('/api/trash/' + mid + '/restore').status_code, 200)
        self.assertEqual(self.client.get('/api/media').json()['items'][0]['id'], mid)

    def wait(self, id):
        for _ in range(300):
            job = self.client.get('/api/media/jobs/' + id).json()
            if job['state'] in ('succeeded', 'failed', 'cancelled'):
                self.assertEqual(job['state'], 'succeeded', job)
                return job
            time.sleep(.03)
        self.fail('media job did not finish')

    def test_actual_manual_video_and_mp3_download(self):
        sample = Path(self.temp.name) / 'fixture.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x1765e8:s=320x180:r=12:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(sample)], check=True)
        uploaded = self.client.post('/api/materials/import', files={'file': ('中文示例.mp4', sample.read_bytes())})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        mid = uploaded.json()['material']['id']
        self.assertEqual(self.client.post('/api/media/local/' + mid).status_code, 200)
        # Nothing gets converted merely by importing/resolving.
        self.assertEqual(list(self.app.state.store.files.rglob('*.mp3')), [])
        for kind in ('video', 'mp3'):
            started = self.client.post(f'/api/media/{mid}/prepare', json={'kind': kind})
            self.assertEqual(started.status_code, 200, started.text)
            job = self.wait(started.json()['id'])
            response = self.client.get(job['download_url'])
            self.assertEqual(response.status_code, 200)
            self.assertIn('attachment;', response.headers['content-disposition'])
            self.assertIn("filename*=UTF-8''%E4%B8%AD", response.headers['content-disposition'])
            self.assertGreater(len(response.content), 1000)
            partial = self.client.get(job['download_url'], headers={'Range': 'bytes=0-19'})
            self.assertEqual(partial.status_code, 206)
            self.assertEqual(len(partial.content), 20)
            self.assertIn('inline;', self.client.get(job['download_url'] + '?inline=1').headers['content-disposition'])
            saved = Path(self.temp.name) / ('saved' + ('.mp3' if kind == 'mp3' else '.mp4'))
            saved.write_bytes(response.content)
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(saved), '-f', 'null', '-'], check=True)
            if kind == 'mp3':
                info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(saved)]))
                self.assertEqual(info['streams'][0]['codec_name'], 'mp3')

    def test_parallel_preparation_keeps_video_as_primary_source(self):
        sample = Path(self.temp.name) / 'remote.mp4'
        audio = Path(self.temp.name) / 'remote.mp3'
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:d=1', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(sample)], check=True)
        subprocess.run(['ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', str(sample), '-vn', str(audio)], check=True)
        media = self.resolve()
        real_popen = subprocess.Popen
        def fake_downloader(command, **kwargs):
            if 'yt_dlp' not in command:
                return real_popen(command, **kwargs)
            mp3 = '--audio-format' in command
            template = command[command.index('-o') + 1]
            output = template.replace('%(ext)s', 'mp3' if mp3 else 'mp4')
            script = 'import shutil,time;time.sleep(%s);shutil.copyfile(%r,%r)' % (.5 if mp3 else 0, str(audio if mp3 else sample), output)
            import sys
            return real_popen([sys.executable, '-c', script], **kwargs)
        with patch('backend.app.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443))]), patch('backend.media.subprocess.Popen', side_effect=fake_downloader):
            a = self.client.post('/api/media/' + media['id'] + '/prepare', json={'kind': 'video'}).json()
            b = self.client.post('/api/media/' + media['id'] + '/prepare', json={'kind': 'mp3'}).json()
            self.wait(a['id']); self.wait(b['id'])
        source = self.app.state.store.get('source', media['id'])
        self.assertEqual(source['type'], 'video')
        self.assertEqual({a['kind'] for a in self.app.state.store.assets(media['id'])}, {'video', 'audio'})


if __name__ == '__main__':
    unittest.main()
