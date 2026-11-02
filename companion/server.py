"""Origin-bound local protocol. No cloud credentials or platform ledger live here."""
from __future__ import annotations
import ctypes,hashlib,json,os,secrets,shutil,subprocess,sys,threading,time
from pathlib import Path
from fastapi import FastAPI,Request
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from backend.app import create_app
from . import VERSION,PROTOCOL
from .model import Model
from .tools import Tools
from .cloud_relay import CloudRelay
from backend.billing import BillingError

ORIGINS=('https://yuanshengzhe.com','http://127.0.0.1:8790','http://127.0.0.1:8792')
PORT=18790

def confirm(message):
    if os.name!='nt':return False
    return ctypes.windll.user32.MessageBoxW(None,message,'Ynote 本地助手 · 请确认',0x00000004|0x00000020|0x00010000)==6

def app_root():
    if os.name=='nt':return Path(os.environ['LOCALAPPDATA'])/'YnoteCompanion'
    return Path.home()/'Library'/'Application Support'/'YnoteCompanion'

class LocalASR:
    def __init__(self,model):self.model=model;self.lane=threading.Semaphore(1)
    def __call__(self,store,material,path,job,Problem):
        while not self.lane.acquire(timeout=.2):
            if (store.get('job',job['id']) or {}).get('cancel_requested'):raise Problem('已取消转写')
        try:
            if not self.model.verify():raise Problem('medium 模型未准备或校验失败，请在设置中准备模型','MODEL_NOT_READY',409)
            if (material.get('duration') or 0)>3600:raise Problem('本地转写单次上限为 60 分钟，请分段','TRANSCRIBE_FAILED',409)
            if not (store.get('source',material['id']) or {}).get('has_audio'):raise Problem('文件没有音轨','TRANSCRIBE_FAILED',409)
            output=path.parent/('asr-'+job['id']+'.json');progress=output.with_suffix('.progress.json')
            ffmpeg=Path(os.environ.get('YNOTE_TOOLS_DIR',str(Path(__file__).resolve().parent.parent/'tools')))/'ffmpeg.exe'
            args=[sys.executable,'-m','companion.asr_worker',str(self.model.root),str(path),str(output),str(progress),str(ffmpeg)]
            begin=time.monotonic();process=subprocess.Popen(args,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            try:
                while process.poll() is None:
                    current=store.get('job',job['id'])
                    if not current or current.get('cancel_requested'):
                        raise Problem('已取消转写')
                    if time.monotonic()-begin>1800:raise Problem('本地转写达到 30 分钟运行上限，请分段重试','TRANSCRIBE_FAILED',409)
                    if progress.exists():
                        try:
                            p=json.loads(progress.read_text('utf-8'));current['asr_progress']=p;store.put('job',current)
                        except (OSError,ValueError):pass
                    time.sleep(.3)
                if process.returncode:raise Problem('medium 转写失败：请检查内存、文件音轨和模型，结果未切换远程','TRANSCRIBE_FAILED',409)
                data=json.loads(output.read_text('utf-8'));self.model.loaded=True;self.model.state='ready'
                return store.add_transcript(material,data['segments'],'local-medium')
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=10);progress.unlink(missing_ok=True)
                output.with_suffix('.wav').unlink(missing_ok=True)
                if process.returncode:output.unlink(missing_ok=True)
        finally:self.lane.release()

def create_companion(root=None,approval=confirm,origins=ORIGINS,port=PORT):
    root=Path(root or app_root()).resolve();root.mkdir(parents=True,exist_ok=True)
    tools=Tools(root/'tools');os.environ['YNOTE_TOOLS_DIR']=str(tools.bin)
    os.environ['PATH']=str(tools.bin)+os.pathsep+os.environ.get('PATH','')
    model=Model(root/'models'/'medium',verify_on_init=False);relay=CloudRelay(origins)
    core=create_app(root/'data',remote_service=relay,secure_remote=True)
    @core.post('/api/materials/{id}/notes/import')
    def import_note(id:str,body:dict):
        from backend.app import Problem,uid,now
        store=core.state.store;store.material(id);v,segments=store.transcript(id)
        text=body.get('markdown')
        if not isinstance(text,str) or not 1<=len(text)<=200000:raise Problem('笔记内容长度无效')
        note={'id':uid(),'material_id':id,'transcript_version_id':v['id'],'markdown':text,'provider':str(body.get('provider','cloud'))[:100],'model':str(body.get('model',''))[:200],'created_at':now()}
        return {'note':store.put('note',note)}
    core.router.routes.insert(0,core.router.routes.pop())
    @core.post('/api/materials/{id}/chat/import')
    def import_chat(id:str,body:dict):
        from backend.app import Problem,uid
        store=core.state.store;store.material(id);v,segments=store.transcript(id)
        question=body.get('question');text=body.get('text')
        if not isinstance(question,str) or not 1<=len(question)<=8000 or not isinstance(text,str) or not 1<=len(text)<=200000:raise Problem('对话内容长度无效')
        cid=body.get('conversation_id');conv=store.get('conversation',cid) if cid else None
        if cid and (not conv or conv['material_id']!=id):raise Problem('对话不属于当前资料')
        conv=conv or {'id':uid(),'material_id':id,'messages':[],'source_version_ids':[]}
        citations=[{'transcript_version_id':v['id'],'segment_id':s['id'],'start_ms':s['start_ms'],'end_ms':s['end_ms'],'quote':s['text']} for s in segments if '['+s['id']+']' in text]
        conv['messages'] += [{'id':uid(),'role':'user','content':question},{'id':uid(),'role':'assistant','content':text,'citations':citations}]
        conv['source_version_ids']=list(dict.fromkeys(conv['source_version_ids']+[v['id']]))
        return {'conversation':store.put('conversation',conv)}
    core.router.routes.insert(0,core.router.routes.pop())
    app=FastAPI(title='Ynote Companion',version=VERSION,docs_url=None,openapi_url=None)
    sessions={};pending={};attempts={};lock=threading.RLock()
    app.state.model=model;app.state.tools=tools;app.state.core=core;app.state.sessions=sessions;app.state.cloud_relay=relay
    def problem(code,message,status=403):return JSONResponse({'error':{'code':code,'message':message,'retryable':False}},status_code=status)
    @app.middleware('http')
    async def security(req,call_next):
        origin=req.headers.get('origin');host=req.headers.get('host')
        def deny(code,message,status=403):
            response=problem(code,message,status)
            if origin in origins:
                response.headers.update({'Access-Control-Allow-Origin':origin,'Vary':'Origin','Cache-Control':'no-store'})
            return response
        if host!=f'127.0.0.1:{port}':return deny('HOST_REJECTED','本机 Host 不匹配')
        if origin not in origins:return deny('ORIGIN_REJECTED','请求来源未获批准，或缺少 Origin')
        cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Cache-Control':'no-store','Access-Control-Expose-Headers':'Content-Length, Content-Range, Content-Disposition, Accept-Ranges'}
        if req.method=='OPTIONS':
            if req.headers.get('access-control-request-method') not in ('GET','POST','PUT','DELETE','HEAD'):return deny('INVALID_INPUT','方法不支持')
            asked={x.strip().lower() for x in req.headers.get('access-control-request-headers','').split(',') if x.strip()}
            if not asked<={'authorization','content-type','range','x-ynote-protocol'}:return deny('INVALID_INPUT','请求头不支持')
            return JSONResponse({},headers={**cors,'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, HEAD','Access-Control-Allow-Headers':'Authorization, Content-Type, Range, X-Ynote-Protocol','Access-Control-Allow-Private-Network':'true'})
        try:
            if int(req.headers.get('content-length','0'))>513*1024*1024:return deny('TOO_LARGE','素材最大 512 MiB',413)
        except ValueError:return deny('INVALID_INPUT','请求长度无效',422)
        exempt=req.url.path in ('/v1/health','/v1/pair/start','/v1/pair/claim')
        if not exempt:
            if req.headers.get('x-ynote-protocol')!='1':return deny('PROTOCOL_INCOMPATIBLE','网页与助手协议不兼容',409)
            token=req.headers.get('authorization','').removeprefix('Bearer ')
            with lock:
                sessions_copy=sessions.get(hashlib.sha256(token.encode()).hexdigest())
            if not sessions_copy or sessions_copy['origin']!=origin or sessions_copy['expiry']<time.time():return deny('PAIRING_REQUIRED','请重新配对本地助手',401)
        response=await call_next(req)
        for k,v in cors.items():response.headers[k]=v
        return response
    @app.get('/v1/health')
    def health(req:Request):
        cloud=relay.status(req.headers['origin'])
        return {'application':'YnoteCompanion','version':VERSION,'protocol':PROTOCOL,'state':'pairing_required','capabilities':['local_media','cloud_model_relay','tasks','results','export'],'online_sources':'restricted_public_cdn_allowlist','model_ready':model.loaded,'model_state':model.state,'tools_state':tools.state,'cloud':cloud,'ready':tools.state=='ready' and cloud['configured']}
    @app.post('/v1/cloud/configure')
    async def configure_cloud(req:Request):
        try:
            if int(req.headers.get('content-length','0'))>8192:return problem('INVALID_INPUT','云端连接请求过大',413)
            content=bytearray()
            async for chunk in req.stream():
                content.extend(chunk)
                if len(content)>8192:return problem('INVALID_INPUT','云端连接请求过大',413)
            body=json.loads(content)
            return relay.configure(body,req.headers['origin'])
        except BillingError as error:return JSONResponse({'error':error.error},status_code=error.status)
        except (ValueError,TypeError):return problem('INVALID_INPUT','云端连接请求格式无效',422)
    @app.get('/v1/cloud/status')
    def cloud_status(req:Request):return relay.status(req.headers['origin'])
    @app.post('/v1/pair/start')
    async def start(req:Request):
        body=await req.json();nonce=body.get('client_nonce');origin=req.headers['origin']
        if not isinstance(nonce,str) or not 32<=len(nonce)<=128:return problem('INVALID_INPUT','配对挑战不合法',422)
        with lock:
            t=time.time();attempts[origin]=[x for x in attempts.get(origin,[]) if t-x<60]
            if len(attempts[origin])>=3:return problem('RATE_LIMIT','配对请求过多，请稍后重试',429)
            attempts[origin].append(t)
            for k in list(pending):
                if pending[k]['expiry']<t:pending.pop(k,None)
            if len(pending)>=8:return problem('RATE_LIMIT','待处理配对过多',429)
            id=secrets.token_urlsafe(24);pending[id]={'origin':origin,'nonce':nonce,'expiry':t+120,'approved':None}
        def decide():
            result=approval(f'以下网站请求连接 Ynote 本地助手：\n\n{origin}\n\n允许读取助手中的本地任务、处理你选择的媒体及导出结果？\n不会授予读取任意电脑文件的权限。\n本次配对请求 2 分钟有效，会话 30 分钟有效。')
            with lock:
                if id in pending and pending[id]['expiry']>time.time():pending[id]['approved']=bool(result)
        threading.Thread(target=decide,daemon=True).start()
        return {'pairing_id':id,'expires_in':120,'state':'awaiting_local_approval'}
    @app.post('/v1/pair/claim')
    async def claim(req:Request):
        b=await req.json()
        with lock:
            p=pending.get(b.get('pairing_id'))
            if not p or p['origin']!=req.headers['origin'] or p['nonce']!=b.get('client_nonce') or p['expiry']<time.time():return problem('PAIRING_EXPIRED','配对挑战无效或已过期',401)
            if p['approved'] is None:return JSONResponse({'state':'awaiting_local_approval'},status_code=202)
            pending.pop(b['pairing_id'])
            if not p['approved']:return problem('PAIRING_DENIED','你已在本机拒绝配对',403)
            token=secrets.token_urlsafe(48);expiry=time.time()+1800
            sessions[hashlib.sha256(token.encode()).hexdigest()]={'origin':p['origin'],'expiry':expiry}
        return {'token':token,'expires_at':expiry,'protocol':PROTOCOL,'state':'connected'}
    @app.post('/v1/session/revoke')
    def revoke(req:Request):
        token=req.headers.get('authorization','').removeprefix('Bearer ')
        with lock:sessions.pop(hashlib.sha256(token.encode()).hexdigest(),None)
        relay.clear(req.headers['origin'])
        return {'revoked':True}
    @app.get('/v1/model')
    def state():return model.status()
    @app.get('/v1/tools')
    def tools_state():return tools.status()
    @app.get('/v1/storage')
    def storage():
        def size(folder):return sum(p.stat().st_size for p in folder.rglob('*') if p.is_file() and not p.is_symlink()) if folder.exists() else 0
        return {'model_bytes':size(model.root),'tools_bytes':size(tools.root),'media_and_result_bytes':size(core.state.store.files),'free_bytes':shutil.disk_usage(root).free}
    @app.post('/v1/cache/clear')
    def clear_cache():
        if (model.thread and model.thread.is_alive()) or (tools.thread and tools.thread.is_alive()) or any(t['state'] in ('queued','running') for t in core.state.store.all('task')):
            return problem('TASKS_ACTIVE','请先结束当前下载与提取任务',409)
        targets=list(model.root.glob('*.part'))+[tools.root/'download.zip.part']
        total=sum(p.stat().st_size for p in targets if p.exists() and not p.is_symlink())
        if not approval(f'清理未完成的下载与已下载的工具归档，共 {total:,} 字节。\n已安装模型、媒体、历史和导出结果会保留。是否清理？'):return problem('CLEANUP_DECLINED','已取消清理',409)
        for p in targets:
            if p.exists() and not p.is_symlink() and p.resolve().is_relative_to(root):p.unlink()
        return {'cleared_bytes':total}
    @app.post('/v1/tools/prepare')
    def tools_prepare():
        s=tools.status()
        if not tools.manifest:return problem('TOOLS_NOT_READY','媒体组件清单尚未就绪',503)
        if not approval(f"准备 FFmpeg / ffprobe {s['version']}（Windows x64，LGPL 构建）。\n\n直接下载来源：{s['source']}\n下载量：{s['total_bytes']:,} 字节\n安装占用：{s['installed_bytes']:,} 字节\n准备期间需空间：{s['required_free_bytes']:,} 字节\n可用空间：{s['free_bytes']:,} 字节\n完整性按固定 SHA-256 校验；不会执行远程脚本。\n\n是否开始 / 继续下载？"):return problem('DOWNLOAD_DECLINED','已取消媒体组件准备',409)
        tools.start();return tools.status()
    @app.post('/v1/tools/cancel')
    def tools_cancel():tools.cancel.set();return tools.status()
    @app.post('/v1/model/prepare')
    def prepare():
        s=model.status()
        if not approval(f"准备多语言 Whisper medium（CPU/int8）。\n\n来源：{s['source']}\n固定版本：{s['revision']}\n总量：{s['total_bytes']:,} 字节\n当前已下载：{s['downloaded_bytes']:,} 字节\n需要剩余空间：{s['required_free_bytes']:,} 字节（含 1 GiB 临时预留，长视频另需空间）\n可用空间：{s['free_bytes']:,} 字节\n\n是否开始或继续下载？"):return problem('DOWNLOAD_DECLINED','已取消模型准备',409)
        model.start();return model.status()
    @app.post('/v1/model/cancel')
    def cancel_model():model.cancel.set();return {'cancel_requested':True}
    @app.post('/v1/model/verify')
    def verify_model():
        if not model.verify():return model.status()
        check=root/'model-load-check.json'
        p=subprocess.run([sys.executable,'-m','companion.asr_worker',str(model.root),'--check',str(check),str(check),str(Path(__file__).parent.parent/'tools'/'ffmpeg.exe')],capture_output=True,timeout=180)
        model.loaded=p.returncode==0;model.state='ready' if model.loaded else 'failed';model.error=None if model.loaded else 'medium 加载失败，请检查模型和运行内存'
        return model.status()
    class LocalGateway:
        async def __call__(self,scope,receive,send):
            # Only operations needed by the existing local workbench are exposed.
            path=scope['path'].removeprefix('/v1/local')
            if scope['method']=='POST' and (path.endswith(('/start','/batch','/transcript')) or path=='/api/materials/import') and tools.state!='ready':
                return await problem('TOOLS_NOT_READY','请先在设置中准备并校验媒体组件',409)(scope,receive,send)
            allowed=('/api/tasks','/api/materials','/api/assets','/api/jobs','/api/exports')
            if not any(path==p or path.startswith(p+'/') for p in allowed):return await problem('CAPABILITY_DENIED','此接口不属于本机任务能力')(scope,receive,send)
            headers=Headers(raw=scope['headers']);origin=headers.get('origin','')
            receive_core=receive;rewritten=None
            if scope['method'] in ('POST','PUT') and headers.get('content-type','').split(';')[0].strip().lower()=='application/json':
                try:
                    length=int(headers.get('content-length','0'))
                    if length<0:raise ValueError()
                    if length>262144:return await problem('TOO_LARGE','任务 JSON 请求超过允许大小',413)(scope,receive,send)
                    content=bytearray()
                    while True:
                        message=await receive()
                        if message['type']!='http.request':raise ValueError()
                        content.extend(message.get('body',b''))
                        if len(content)>262144:return await problem('TOO_LARGE','任务 JSON 请求超过允许大小',413)(scope,receive,send)
                        if not message.get('more_body',False):break
                    body=json.loads(content)
                    if not isinstance(body,dict):raise ValueError()
                    if any(key in body for key in ('api_key','platform_key','key')):return await problem('CAPABILITY_DENIED','本地助手不接收 API Key，请仅在网站后端配置',422)(scope,receive,send)
                    body['_relay_origin']=origin
                    rewritten=json.dumps(body,ensure_ascii=False).encode('utf-8');del content
                    sent=False
                    async def receive_json():
                        nonlocal sent
                        if not sent:
                            sent=True;return {'type':'http.request','body':rewritten,'more_body':False}
                        return await receive()
                    receive_core=receive_json
                except (ValueError,TypeError,UnicodeError):return await problem('INVALID_INPUT','任务 JSON 请求格式无效',422)(scope,receive,send)
            scope=dict(scope);scope['headers']=[(k,v) for k,v in scope['headers'] if k not in (b'host',b'origin') and not (rewritten is not None and k==b'content-length')]+[(b'host',b'127.0.0.1')]
            if rewritten is not None:scope['headers'].append((b'content-length',str(len(rewritten)).encode()))
            scope['path']=path;scope['root_path']='';scope['raw_path']=path.encode()
            await core(scope,receive_core,send)
    app.mount('/v1/local',LocalGateway())
    return app
