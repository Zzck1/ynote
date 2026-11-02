"""Durable user tasks. Importing/typing is separate from explicitly starting extraction."""
import os
from pathlib import Path
import subprocess
import threading
import time

from fastapi import APIRouter

DEFAULTS = {'quality': '720', 'audio_bitrate': '192', 'image_count': 3,
            'subtitle_first': True, 'transcribe': True, 'auto_note': True,
            'note_style': 'structured', 'subtitle_language': 'zh'}
ACTIVE = ('queued', 'running')
DONE = ('succeeded', 'failed', 'partial', 'cancelled', 'needs_action')


def launch_task(threads, pipeline, id, run_id):
    thread = threading.Thread(target=pipeline, args=(id, run_id), daemon=True)
    threads.add(thread)
    thread.start()


def tasks_router(store, Problem, uid, now, media_api, create_jobs, parse_text):
    router = APIRouter(prefix='/api/tasks')
    lane = threading.Semaphore(1)
    threads = set()
    for task in store.all('task'):
        if task['state'] in ACTIVE:
            task.update(state='interrupted', stage='服务已重启，请重新提取')
            store.put('task', task)

    def require(id):
        task = store.get('task', id)
        if not task:
            raise Problem('任务不存在','TASK_NOT_FOUND',status=404)
        return task

    def preferences():
        return {**DEFAULTS, **(store.get('settings', 'extraction') or {})}

    @router.get('/preferences')
    def get_preferences():
        return preferences()

    @router.put('/preferences')
    def put_preferences(body: dict):
        cfg = preferences()
        for key in DEFAULTS:
            if key in body:
                cfg[key] = body[key]
        if cfg['quality'] not in ('best', '1080', '720', '480', '360') or cfg['audio_bitrate'] not in ('128', '192', '320'):
            raise Problem('清晰度或音频码率无效')
        if type(cfg['image_count']) is not int or not 1 <= cfg['image_count'] <= 9:
            raise Problem('截图数量应为 1–9 张')
        if any(type(cfg[k]) is not bool for k in ('subtitle_first', 'transcribe', 'auto_note')):
            raise Problem('提取开关无效')
        if cfg['note_style'] not in ('brief', 'structured', 'detailed') or cfg['subtitle_language'] not in ('zh', 'en'):
            raise Problem('笔记风格或字幕语言无效')
        cfg['id'] = 'extraction'
        store.put('settings', cfg)
        return cfg

    @router.get('')
    def history():
        return {'tasks': sorted((reconcile_text_result(task) for task in store.all('task')), key=lambda t: t['created_at'], reverse=True)}

    def new_task(body):
        task = {'id': uid(), 'title': '新任务', 'raw_input': '', 'source_id': None,
                'material_id': None, 'state': 'draft', 'stage': '等待开始提取',
                'created_at': now(), 'media_job_ids': [], 'result_job_id': None,
                'cancel_requested': False}
        apply_input(task, body)
        return store.put('task', task)

    def apply_input(task, body):
        text = str(body.get('raw_input', task['raw_input']))
        if len(text) > 20000:
            raise Problem('输入内容过长')
        source_id = body.get('source_id', task.get('source_id'))
        if source_id:
            material = store.material(str(source_id))
            source = store.get('source', material['id']) or {}
            if material['platform'] != 'local' or source.get('type') not in ('video', 'audio'):
                raise Problem('请选择有效的本地音视频文件')
            task['title'] = material['title']
        elif text.strip():
            task['title'] = '待提取链接'
        else:
            task['title'] = '新任务'
        task.update(raw_input=text, source_id=source_id)

    @router.post('')
    def create(body: dict):
        return new_task(body)

    @router.put('/{id}/input')
    def save_input(id: str, body: dict):
        task = require(id)
        if task['state'] in ACTIVE:
            raise Problem('正在提取的任务不能修改输入', status=409)
        if task['state'] != 'draft':
            raise Problem('请新建任务处理其他内容', status=409)
        apply_input(task, body)
        return store.put('task', task)

    def update(id, **fields):
        with store.lock:
            task = require(id)
            task.update(fields)
            store.put('task', task)
        return task

    def reconcile_text_result(task):
        """A repaired transcript can complete a task only when all other work succeeded."""
        with store.lock:
            task=require(task['id'])
            if task['state'] not in ('partial','failed') or task.get('cancel_requested'):
                return task
            mid=task.get('material_id');text_id=task.get('text_job_id')
            text=store.get('job',text_id) if text_id else None
            if not mid or not text or text.get('material_id')!=mid or text.get('state')!='succeeded':
                return task
            media_ids=task.get('media_job_ids') or []
            media_jobs=[store.get('media_job',jid) for jid in media_ids]
            if not media_jobs or any(not job or job.get('media_id')!=mid or job.get('state')!='succeeded' for job in media_jobs):
                return task
            original_id=task.get('result_job_id')
            original=store.get('job',original_id) if original_id else None
            if original_id and not original:
                return task
            if original and original.get('state')!='succeeded':
                operations=original.get('operations') or []
                if not operations or any(op.get('kind')!='transcript' and op.get('state')!='succeeded' for op in operations):
                    return task
            try:
                version,segments=store.transcript(mid)
                if not any(segment.get('text','').strip() for segment in segments):return task
            except Problem:
                return task
            if (task.get('preferences') or {}).get('auto_note') and not any(note.get('material_id')==mid and note.get('transcript_version_id')==version['id'] and note.get('markdown','').strip() for note in store.all('note')):
                return task
            return update(task['id'],state='succeeded',stage='提取完成')

    def check_cancel(id):
        if require(id).get('cancel_requested'):
            raise Problem('已取消提取')

    def wait_media(id, jid):
        start = time.monotonic()
        while True:
            check_cancel(id)
            job = store.get('media_job', jid)
            if job and job['state'] not in ACTIVE:
                return job
            if time.monotonic() - start > 650:
                raise Problem('媒体准备超时，请重试')
            time.sleep(.2)

    def subtitles(task, media, cfg):
        if media.get('local') or not cfg['subtitle_first']:
            return
        folder = store.files / media['id']
        folder.mkdir(exist_ok=True)
        languages = 'zh.*,en.*' if cfg['subtitle_language'] == 'zh' else 'en.*,zh.*'
        command = [os.sys.executable, '-m', ('companion.downloader' if os.environ.get('YNOTE_COMPANION_MODE') else 'yt_dlp'), '--ignore-config', '--no-playlist',
                   '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', languages,
                   '--sub-format', 'vtt', '--no-warnings', '--socket-timeout', '10', '--retries', '0',
                   '-o', str(folder / 'captions.%(ext)s'), '--', media['url']]
        try:
            subprocess.run(command, capture_output=True, timeout=45)
            check_cancel(task['id'])
            files = sorted(folder.glob('captions*.vtt'), key=lambda p: (cfg['subtitle_language'] not in p.name, p.name))
            for path in files:
                if path.stat().st_size > 10 * 1024 * 1024:
                    continue
                try:
                    segments = parse_text(path.read_text('utf-8-sig'), '.vtt')
                    if segments:
                        material = store.material(media['id'])
                        store.add_transcript(material, segments, 'subtitle')
                        store.add_asset(material, path, 'subtitle')
                        return
                except (Problem, UnicodeError):
                    continue
        except subprocess.SubprocessError:
            pass

    def pipeline(id, run_id):
        with lane:
            if require(id).get('run_id') != run_id:
                threads.discard(threading.current_thread())
                return
            try:
                check_cancel(id)
                task = update(id, state='running', stage='正在识别内容…')
                cfg = task['preferences']
                media = media_api.register_local(task['source_id']) if task.get('source_id') else media_api.parse_metadata(task['raw_input'], force_new=True)
                update(id, material_id=media['id'], title=media['title'], stage='正在提取视频和音频…')
                check_cancel(id)
                jobs = []
                video = any(f['video'] for f in media['formats'])
                audio = any(f['audio'] for f in media['formats'])
                fmt = 'best'
                if cfg['quality'] != 'best' and not media.get('local'):
                    available = sorted([f for f in media['formats'] if f['video'] and f.get('height') and f['height'] <= int(cfg['quality'])], key=lambda f: (f['height'], f['audio']), reverse=True)
                    if available:
                        fmt = available[0]['id']
                for kind, enabled in [('video', video), ('mp3', audio)]:
                    if enabled:
                        job = media_api.prepare_media(media['id'], {'kind': kind, 'format_id': fmt, 'audio_bitrate': cfg['audio_bitrate']})
                        jobs.append(job['id'])
                        update(id, media_job_ids=list(jobs))
                results = [wait_media(id, jid) for jid in jobs]
                if not any(j['state'] == 'succeeded' for j in results):
                    raise Problem('媒体提取失败，请检查网络或文件后重试')
                source = store.get('source', media['id']) or {}
                if source.get('type') == 'remote':
                    raise Problem('没有生成可读取的媒体文件，请重试')
                update(id, stage='正在整理图片与文案…')
                if cfg['transcribe']:
                    subtitles(require(id), media, cfg)
                check_cancel(id)
                if not media.get('local') and source.get('type')=='video':
                    from .covers import download_cover
                    try:
                        cover_path = download_cover(media['url'], store.files / media['id'])
                        if cover_path:
                            material = store.material(media['id'])
                            cover_asset = store.add_asset(material, cover_path, 'cover', origin='platform')
                            material['cover_url'] = f"/api/assets/{cover_asset['id']}/download"
                            store.put('material', material)
                    except (OSError, subprocess.SubprocessError):
                        pass
                source_video=source.get('type')=='video'
                has_cover=any(asset['kind']=='cover' for asset in store.assets(media['id']))
                operations = (['cover'] if source_video and not has_cover else []) + (['transcript'] if cfg['transcribe'] and audio else [])
                if operations:
                    result = create_jobs(media['id'], {'operations': operations, 'idempotency_key': uid(),
                                                       'image_count': cfg['image_count'], 'audio_bitrate': cfg['audio_bitrate'],
                                                       'generate_note': cfg['auto_note'], **task.get('billing',{})})
                    jid = result['job']['id']
                    update(id, result_job_id=jid)
                    start = time.monotonic()
                    while (store.get('job', jid) or {}).get('state') not in DONE:
                        check_cancel(id)
                        if time.monotonic() - start > int(os.environ.get('YNOTE_TASK_TIMEOUT','2100')):
                            raise Problem('文案处理超时，可稍后单独重试')
                        time.sleep(.2)
                    job = store.get('job', jid)
                    partial = job['state'] != 'succeeded' or any(j['state'] != 'succeeded' for j in results) or not audio
                    if cfg['transcribe'] and audio:
                        try:
                            version,segments=store.transcript(media['id'])
                            actual_text=any(segment.get('text','').strip() for segment in segments)
                        except Problem:
                            actual_text=False;version=None
                        actual_note=bool(version and any(note.get('material_id')==media['id'] and note.get('transcript_version_id')==version['id'] and note.get('markdown','').strip() for note in store.all('note')))
                        partial=partial or not actual_text or (cfg['auto_note'] and not actual_note)
                else:
                    partial = any(j['state'] != 'succeeded' for j in results) or not audio
                stage='素材已提取，部分项目需要处理' if partial else '提取完成'
                if not audio:stage='媒体已提取，但未检测到音轨，无法生成文案与 AI 笔记'
                update(id, state='partial' if partial else 'succeeded', stage=stage)
            except Exception as exc:
                task = require(id)
                cancelled = task.get('cancel_requested')
                prepared=any((store.get('media_job',jid) or {}).get('state')=='succeeded' for jid in task.get('media_job_ids',[]))
                message=exc.message if isinstance(exc,Problem) else (getattr(exc,'error',{}) or {}).get('message') or ('素材已保留，自动整理未完成，请检查服务或重试' if prepared else '提取失败，请重试')
                update(id, state='cancelled' if cancelled else 'partial' if prepared else 'failed', stage='已取消提取' if cancelled else message)
            finally:
                threads.discard(threading.current_thread())

    @router.post('/{id}/start')
    def start(id: str, body: dict):
        with store.lock:
            return start_locked(id,body)

    def start_locked(id,body):
        task = require(id)
        extraction_mode=body.get('extraction_mode','precise')
        if extraction_mode not in ('quick','precise'):raise Problem('提取模式仅支持 quick 或 precise',status=422)
        if task['state'] in ACTIVE:
            raise Problem('任务已经在提取中', status=409)
        if sum(t['state'] in ACTIVE for t in store.all('task'))>=20:
            raise Problem('待处理任务已达 20 个，请稍后再开始',status=429)
        if task['state'] == 'draft':
            apply_input(task, body)
        if not task.get('source_id') and not task['raw_input'].strip():
            raise Problem('请粘贴链接或导入本地视频')
        cfg=preferences()
        # Starting a task requests the full workflow, including old installations
        # whose saved preferences disabled transcription or automatic notes.
        cfg.update(transcribe=True,auto_note=True)
        if type(cfg.get('image_count')) is not int or not 1<=cfg['image_count']<=9:cfg['image_count']=DEFAULTS['image_count']
        task.update(state='queued', stage='等待提取', cancel_requested=False, preferences=cfg, run_id=uid(),extraction_mode=extraction_mode,
                    media_job_ids=[], result_job_id=None, text_job_id=None, material_id=None,
                    billing={**{k:body[k] for k in ('tool','billing_mode','connection_id','connections','_relay_origin') if k in body},'extraction_mode':extraction_mode})
        store.put('task', task)
        launch_task(threads, pipeline, id, task['run_id'])
        return task

    @router.post('/batch')
    def batch(body: dict):
        import re
        extraction_mode=body.get('extraction_mode','precise')
        if extraction_mode not in ('quick','precise'):raise Problem('提取模式仅支持 quick 或 precise',status=422)
        entries = body.get('entries')
        if entries is None:
            entries = [{'raw_input': line.strip()} for line in str(body.get('text','')).splitlines() if line.strip()]
        if not isinstance(entries,list) or not 1 <= len(entries) <= 10:
            raise Problem('一次支持 1–10 个任务')
        for entry in entries:
            if not isinstance(entry,dict):raise Problem('批量任务格式无效')
            if len(str(entry.get('raw_input','')))>20000:raise Problem('输入内容过长')
            if entry.get('source_id'):
                material=store.material(str(entry['source_id']))
                source=store.get('source',material['id']) or {}
                if material['platform']!='local' or source.get('type') not in ('video','audio'):raise Problem('本地文件无效')
            elif len(re.findall(r'https?://[^\s<>]+',str(entry.get('raw_input',''))))!=1:
                raise Problem('每个栏需要一条视频链接或一个本地视频')
        batch_id=body.get('batch_id')
        existing=[t for t in store.all('task') if t.get('batch_id')==batch_id] if batch_id else []
        if batch_id and not existing:raise Problem('批量任务不存在')
        batch_id=batch_id or uid()
        if len(existing)+len(entries)>10:raise Problem('每组最多 10 个任务，请新建一组批量任务')
        items=[]
        for index,entry in enumerate(entries,len(existing)+1):
            task=new_task(entry)
            task=update(task['id'],batch_id=batch_id,batch_index=index)
            items.append(start(task['id'],{**{k:body[k] for k in ('tool','billing_mode','connection_id','connections','_relay_origin') if k in body},'extraction_mode':extraction_mode}))
        return {'batch_id':batch_id,'tasks':items}

    @router.post('/{id}/cancel')
    def cancel(id: str):
        task = update(id, cancel_requested=True)
        if task['state'] == 'queued':
            task = update(id, state='cancelled', stage='已取消提取')
        for jid in task.get('media_job_ids', []):
            job = store.get('media_job', jid)
            if job and job['state'] in ACTIVE:
                job['cancel_requested'] = True
                store.put('media_job', job)
        for jid in [task.get('result_job_id'), task.get('text_job_id')]:
            job = store.get('job', jid) if jid else None
            if job and job['state'] not in DONE:
                job['cancel_requested'] = True
                store.put('job', job)
        return task

    @router.post('/{id}/transcript')
    def retry_text(id: str, body: dict = {}):
        with store.lock:
            task = reconcile_text_result(require(id))
            if task['state'] in ACTIVE or not task.get('material_id'):
                raise Problem('请等待媒体提取完成', status=409)
            previous_id=task.get('text_job_id') or task.get('result_job_id')
            previous=store.get('job',previous_id) if previous_id else None
            if previous and previous.get('material_id')==task['material_id']:
                if previous['state'] not in DONE:
                    return {'job':previous}
                if previous['state']=='succeeded':
                    try:
                        _,segments=store.transcript(task['material_id'])
                        if segments:return {'job':previous}
                    except Problem:
                        pass
                if any(op.get('error_code') in ('ACCOUNTING_REVIEW','PROVIDER_UNAVAILABLE','PROVIDER_RATE_LIMIT') for op in previous.get('operations',[])):
                    raise Problem('此前远程调用结果尚待确认，请先对账；没有重新发送或重复扣费','ACCOUNTING_REVIEW',503)
            generate_note=(task.get('preferences') or preferences()).get('auto_note',True)
            extraction_mode=task.get('extraction_mode',(task.get('billing') or {}).get('extraction_mode','precise'))
            if extraction_mode not in ('quick','precise'):extraction_mode='precise'
            result = create_jobs(task['material_id'], {'operations': ['transcript'], 'idempotency_key': uid(), 'generate_note': generate_note, **{k:body[k] for k in ('tool','billing_mode','connection_id','connections','_relay_origin') if k in body},'extraction_mode':extraction_mode})
            update(id, text_job_id=result['job']['id'])
            return result

    @router.get('/{id}')
    def detail(id: str):
        task = reconcile_text_result(require(id))
        mid = task.get('material_id')
        material = store.get('material', mid) if mid else None
        transcript = None
        if mid:
            try:
                version, segments = store.transcript(mid)
                transcript = {'version': version, 'segments': segments}
            except Problem:
                pass
        notes = [n for n in store.all('note') if n['material_id'] == mid] if mid else []
        return {'task': task, 'material': material, 'media': store.get('media', mid) if mid else None,
                'assets': store.assets(mid) if mid else [], 'transcript': transcript, 'note': notes[0] if notes else None,
                'media_jobs': [store.get('media_job', j) for j in task.get('media_job_ids', [])],
                'result_job': store.get('job', task.get('text_job_id') or task.get('result_job_id'))}

    return router
