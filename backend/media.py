"""Metadata-only resolution and explicitly requested media preparation."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time

from fastapi import APIRouter, Request


def media_router(store, Problem, uid, now, safe_url, import_path, download, max_bytes):
    router = APIRouter(prefix='/api/media')
    slots = threading.BoundedSemaphore(2)
    running = {}
    threads = set()

    def terminate(process):
        if process.poll() is None:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=10)
                if process.poll() is None:process.kill()
            else:
                process.kill()
        process.wait(timeout=10)

    @router.on_event('shutdown')
    def shutdown():
        for job in store.all('media_job'):
            if job['state'] in ('queued', 'running'):
                job['cancel_requested'] = True
                store.put('media_job', job)
        for process in list(running.values()):
            try: terminate(process)
            except (OSError, subprocess.SubprocessError): pass
        for thread in list(threads):
            thread.join(timeout=3)
    for job in store.all('media_job'):
        if job['state'] in ('queued', 'running'):
            job.update(state='failed', stage='服务已重启，请重新准备文件')
            store.put('media_job', job)

    def require(kind, id):
        row = store.get(kind, id)
        if not row:
            raise Problem('记录不存在', status=404)
        return row

    def parse(raw, force_new=False):
        urls = list(dict.fromkeys(u.rstrip('，。、；：！？）】」』,.;:!?)') for u in re.findall(r'https?://[^\s<>"\']+', str(raw))))
        if len(urls) != 1:
            raise Problem('请粘贴一条完整的视频链接，也可以包含分享文字')
        url = urls[0]
        platform = safe_url(url)
        # This command never requests a media download, subtitles or thumbnails.
        args = [os.sys.executable, '-m', ('companion.downloader' if os.environ.get('YNOTE_COMPANION_MODE') else 'yt_dlp'), '--ignore-config', '--no-playlist',
                '--skip-download', '--dump-single-json', '--no-warnings',
                '--socket-timeout', '15', '--retries', '1', '--', url]
        try:
            result = subprocess.run(args, capture_output=True, timeout=65)
            if result.returncode:
                raise Problem('解析未成功。链接可能需要登录、已失效，或平台限制了访问。可以重试或导入本地文件。', 'LINK_EXPIRED', 409, True)
            info = json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            raise Problem('平台响应超时，请稍后重试', 'LINK_EXPIRED', 408, True)
        except (ValueError, OSError):
            raise Problem('解析组件无法读取此链接，请检查 yt-dlp 安装与网络', status=409)
        if info.get('_type') in ('playlist', 'multi_video') or info.get('is_live'):
            raise Problem('请使用单个已发布视频的链接，暂不处理直播或播放列表')
        formats = []
        for f in info.get('formats') or [info]:
            if not f.get('url') or f.get('has_drm'):
                continue
            video = f.get('vcodec') not in (None, 'none')
            audio = f.get('acodec') not in (None, 'none')
            if not video and not audio:
                continue
            formats.append({'id': str(f.get('format_id', 'best')), 'ext': f.get('ext', ''),
                            'height': f.get('height'), 'video': video, 'audio': audio,
                            'bytes': f.get('filesize') or f.get('filesize_approx')})
        if not formats:
            raise Problem('没有找到可用的视频或音频格式', status=409)
        existing = None if force_new else next((m for m in store.all('material') if m.get('source_url') == url), None)
        mid = existing['id'] if existing else uid()
        material = existing or {'id': mid, 'platform': platform, 'external_id': str(info.get('id', '')),
                               'part_id': None, 'source_url': url, 'title': info.get('title') or '未命名视频',
                               'author': info.get('uploader') or '', 'duration': info.get('duration'),
                               'content_type': 'video', 'cover_url': None, 'created_at': now()}
        store.put('material', material)
        if not existing:
            store.put('source', {'id': mid, 'type': 'remote', 'path': None, 'has_audio': False})
        row = {'id': mid, 'title': material['title'], 'author': material['author'],
               'duration': material['duration'], 'platform': platform, 'url': url,
               'formats': formats, 'created_at': now(), 'local': False, 'description': str(info.get('description') or '')[:50000]}
        store.put('media', row)
        return row

    @router.get('')
    def history():
        return {'items': store.all('media'), 'jobs': store.all('media_job'),
                'ffmpeg': bool(shutil.which('ffmpeg')), 'ffprobe': bool(shutil.which('ffprobe'))}

    @router.post('/resolve')
    def resolve(body: dict):
        return parse(body.get('raw_input', ''))

    @router.post('/local/{id}')
    def local(id: str):
        m = store.material(id)
        source = require('source', id)
        if source['type'] not in ('video', 'audio'):
            raise Problem('请选择视频或音频文件')
        row = {'id': id, 'title': m['title'], 'author': '本地文件', 'duration': m['duration'],
               'platform': 'local', 'url': '', 'local': True, 'created_at': now(),
               'formats': [{'id': 'original', 'ext': Path(source['path']).suffix[1:],
                            'height': None, 'video': source['type'] == 'video',
                            'audio': source['type'] == 'audio' or source.get('has_audio', False), 'bytes': None}]}
        return store.put('media', row)

    def worker(job, media):
        jid = job['id']
        folder = store.files / media['id']
        folder.mkdir(exist_ok=True)
        log = folder / (jid + '.log')
        original = store.get('source', media['id'])
        output = None
        try:
            if media['local']:
                path = store.path(original['path'])
                if job['kind'] == 'video':
                    output = path
                    command = None
                else:
                    output = folder / (jid + '.mp3')
                    command = ['ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', str(path), '-vn', '-b:a', job.get('audio_bitrate','192')+'k', str(output)]
            else:
                safe_url(media['url'])
                template = str(folder / (jid + '.%(ext)s'))
                command = [os.sys.executable, '-m', ('companion.downloader' if os.environ.get('YNOTE_COMPANION_MODE') else 'yt_dlp'), '--ignore-config', '--no-playlist',
                           '--max-filesize', str(max_bytes), '--socket-timeout', '15', '--retries', '1',
                           '--no-progress', '--no-warnings', '--restrict-filenames', '-o', template]
                if job['kind'] == 'mp3':
                    command += ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', job.get('audio_bitrate','192')+'K']
                else:
                    fmt = job['format_id']
                    selector = 'bestvideo+bestaudio/best' if fmt == 'best' else fmt + '+bestaudio/' + fmt
                    selected = next((f for f in media['formats'] if f['id'] == fmt), None)
                    if selected and selected['audio']:
                        selector = fmt
                    command += ['-f', selector, '--merge-output-format', 'mp4', '--remux-video', 'mp4']
                command += ['--', media['url']]
            if require('media_job', jid).get('cancel_requested'):raise Problem('已取消')
            job.update(state='running', stage='正在提取与转换，完成后可手动保存')
            store.put('media_job', job)
            if command:
                with log.open('wb') as errors:
                    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=errors)
                    running[jid] = process
                    started = time.monotonic()
                    while process.poll() is None:
                        current = require('media_job', jid)
                        if current.get('cancel_requested'):
                            raise Problem('已取消')
                        if time.monotonic() - started > 600:
                            raise Problem('处理超时，请选择更小的视频或稍后重试')
                        files = list(folder.glob(jid + '.*'))
                        if sum(p.stat().st_size for p in files if p.is_file()) > max_bytes * 2:
                            raise Problem('媒体超过本地处理大小限制')
                        time.sleep(.25)
                    if process.returncode:
                        raise Problem('文件准备失败。请检查平台访问权限、网络和 FFmpeg；你可以选择其他格式后重试。')
            if not output:
                candidates = [p for p in folder.glob(jid + '.*') if p.suffix in ('.mp4', '.mkv', '.webm', '.mp3', '.m4a', '.opus')]
                output = next((p for p in candidates if p.suffix == ('.mp3' if job['kind'] == 'mp3' else '.mp4')), None)
                output = output or (candidates[0] if len(candidates) == 1 else None)
            if not output or not output.exists() or not output.stat().st_size:
                raise Problem('没有生成可用的媒体文件')
            if output.stat().st_size > max_bytes:
                raise Problem('文件超过 500 MB，请选择更低清晰度')
            # Register the prepared file for use in the BiliNote-style workspace.
            if not media['local']:
                with store.lock:
                    previous = store.material(media['id'])
                    if job['kind'] == 'video' or (store.get('source', media['id']) or {}).get('type') == 'remote':
                        imported = import_path(output, output.name, media['platform'], media['url'], media['title'], media['author'])
                        imported['material']['created_at'] = previous['created_at']
                        store.put('material', imported['material'])
                    else:
                        store.add_asset(previous, output, 'audio', duration=media['duration'])
            elif job['kind'] == 'mp3':
                store.add_asset(store.material(media['id']), output, 'audio', duration=media['duration'])
            job.update(state='succeeded', stage='文件已就绪，点击下载保存',
                       relative_path=str(output.relative_to(store.files)), bytes=output.stat().st_size,
                       extension=output.suffix, download_url=f'/api/media/jobs/{jid}/download')
        except Exception as exc:
            current = store.get('media_job', jid) or {}
            cancelled = current.get('cancel_requested', False)
            job.update(state='cancelled' if cancelled else 'failed', stage='已取消' if cancelled else (exc.message if isinstance(exc, Problem) else '处理失败，请重试或检查本机依赖'))
        finally:
            process = running.pop(jid, None)
            if process:
                terminate(process)
            if job['state'] != 'succeeded':
                for path in folder.glob(jid + '.*'):
                    path.unlink(missing_ok=True)
            log.unlink(missing_ok=True)
            store.put('media_job', job)
            slots.release()
            threads.discard(threading.current_thread())

    @router.post('/{id}/prepare')
    def prepare(id: str, body: dict):
        media = require('media', id)
        kind = body.get('kind')
        fmt = str(body.get('format_id', 'best'))
        if kind not in ('video', 'mp3'):
            raise Problem('请选择视频或 MP3')
        if fmt != 'best' and fmt not in [f['id'] for f in media['formats'] if f['video']]:
            raise Problem('清晰度已失效，请重新解析')
        if not any(f['video' if kind == 'video' else 'audio'] for f in media['formats']):
            raise Problem('此素材没有对应的媒体轨道')
        if (kind == 'mp3' or not media['local']) and not all(shutil.which(x) for x in ('ffmpeg', 'ffprobe')):
            raise Problem('需要安装 FFmpeg 和 ffprobe 才能准备媒体文件', status=409)
        if not slots.acquire(blocking=False):
            raise Problem('当前已有两个任务在处理，请完成后再试', status=409)
        job = {'id': uid(), 'media_id': id, 'title': media['title'], 'kind': kind, 'format_id': fmt,
               'state': 'queued', 'stage': '等待处理', 'created_at': now(), 'audio_bitrate': str(body.get('audio_bitrate','192'))}
        if job['audio_bitrate'] not in ('128','192','320'):
            slots.release(); raise Problem('音频码率无效')
        store.put('media_job', job)
        thread = threading.Thread(target=worker, args=(job, media), daemon=True)
        threads.add(thread)
        thread.start()
        return job

    @router.get('/jobs/{id}')
    def job_detail(id: str):
        return require('media_job', id)

    @router.post('/jobs/{id}/cancel')
    def cancel(id: str):
        job = require('media_job', id)
        if job['state'] in ('queued', 'running'):
            job['cancel_requested'] = True
            store.put('media_job', job)
        return job

    @router.get('/jobs/{id}/download')
    def save(id: str, request: Request):
        job = require('media_job', id)
        if job['state'] != 'succeeded':
            raise Problem('文件尚未就绪', status=409)
        path = store.path(job['relative_path'])
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', job['title'])[:100] + path.suffix
        return download(path, 'audio/mpeg' if path.suffix == '.mp3' else 'video/mp4' if path.suffix == '.mp4' else 'application/octet-stream', request, None if request.query_params.get('inline') == '1' else name)

    router.prepare_media = prepare
    router.register_local = local
    router.parse_metadata = parse
    return router
