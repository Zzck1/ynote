"""Short-lived companion capabilities; cloud accepts only prompts/prepared MP3."""
import asyncio
from decimal import Decimal,InvalidOperation
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
import tempfile
import threading
import time

from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartParser,MultiPartException
from .billing import BillingError

MAX_AUDIO=50_000_000
MAX_MULTIPART=MAX_AUDIO+65_536
MAX_JSON=262_144
BILLING_FIELDS={'tool','billing_mode','idempotency_key','connection_id','connections','extraction_mode'}


class RelayLeases:
    def __init__(self,ttl=1800,clock=time.time):
        self.ttl=ttl;self.clock=clock;self.lock=threading.RLock();self.entries={}

    def issue(self,visitor,origin):
        now=self.clock();token=secrets.token_urlsafe(32);expiry=int(now+self.ttl)
        with self.lock:
            self.entries={key:value for key,value in self.entries.items() if value['expires_at']>now}
            own=[key for key,value in self.entries.items() if value['visitor']==visitor and value['origin']==origin]
            for key in own[:-3]:self.entries.pop(key,None)
            if len(self.entries)>=4096:raise BillingError('CONCURRENCY_LIMIT','本地助手连接数量已达上限，请稍后重试',429)
            self.entries[hashlib.sha256(token.encode()).hexdigest()]={'visitor':visitor,'origin':origin,'expires_at':expiry}
        return {'token':token,'expires_at':expiry,'origin':origin}

    def authorize(self,request):
        header=request.headers.get('authorization','')
        if not header.startswith('Bearer ') or not 1<=len(header[7:])<=256:raise BillingError('RELAY_UNAUTHORIZED','请重新连接本地助手',401)
        digest=hashlib.sha256(header[7:].encode()).hexdigest()
        with self.lock:
            lease=self.entries.get(digest)
            if not lease or lease['expires_at']<=self.clock():
                self.entries.pop(digest,None);raise BillingError('RELAY_EXPIRED','本地助手云端连接已过期，请重新连接',401)
            if request.headers.get('origin')!=lease['origin']:raise BillingError('ORIGIN_REJECTED','助手请求来源与连接不匹配',403)
            return dict(lease)


def check_length(request,limit):
    value=request.headers.get('content-length')
    if value is not None:
        try:length=int(value)
        except ValueError:raise BillingError('INVALID_INPUT','请求长度无效')
        if length<0:raise BillingError('INVALID_INPUT','请求长度无效')
        if length>limit:raise BillingError('PAYLOAD_TOO_LARGE','请求超过允许大小',413)


def validate_body(body,text=False):
    allowed=BILLING_FIELDS|({'prompt'} if text else set())
    if not isinstance(body,dict) or set(body)-allowed:raise BillingError('INVALID_INPUT','助手请求只能包含内容和计费标识，不能指定服务地址或密钥')
    if body.get('tool')!='ynote' or body.get('billing_mode') not in ('platform','byok'):raise BillingError('INVALID_INPUT','请明确选择 Ynote 计费方式')
    if body.get('extraction_mode','precise') not in ('quick','precise'):raise BillingError('INVALID_INPUT','提取模式仅支持 quick 或 precise')
    key=body.get('idempotency_key')
    if not isinstance(key,str) or not 1<=len(key)<=200:raise BillingError('INVALID_INPUT','助手请求需要幂等标识')
    if 'connection_id' in body and (not isinstance(body['connection_id'],str) or not 1<=len(body['connection_id'])<=512):raise BillingError('INVALID_INPUT','连接标识无效')
    if 'connections' in body:
        entries=body['connections']
        if not isinstance(entries,dict) or set(entries)-{'text_ai','transcription'} or any(not isinstance(value,str) or not 1<=len(value)<=512 for value in entries.values()):raise BillingError('INVALID_INPUT','连接标识无效')
    if text:
        prompt=body.get('prompt')
        if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>100000 or len(prompt.encode('utf-8'))>200000:raise BillingError('INVALID_INPUT','文字长度无效或超过限制')
    return body


class CompanionRelay:
    def __init__(self,service_factory):
        self.service_factory=service_factory;self.leases=RelayLeases();self.slots=threading.BoundedSemaphore(2)

    async def dispatch(self,request):
        lease=self.leases.authorize(request)
        if request.method!='POST':raise BillingError('METHOD_NOT_ALLOWED','助手转发接口仅支持 POST',405)
        if not self.slots.acquire(blocking=False):raise BillingError('CONCURRENCY_LIMIT','已有两个模型请求正在处理，请稍后重试',429)
        try:
            service=self.service_factory(lease['visitor'])
            if request.url.path=='/api/relay/text':return await self.text(request,service)
            if request.url.path=='/api/relay/transcribe':return await self.transcribe(request,service)
            raise BillingError('INVALID_INPUT','未知助手转发接口',404)
        finally:self.slots.release()

    async def text(self,request,service):
        check_length(request,MAX_JSON)
        content=bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content)>MAX_JSON:raise BillingError('PAYLOAD_TOO_LARGE','文字请求超过允许大小',413)
        try:body=validate_body(json.loads(content),text=True)
        except (ValueError,UnicodeError):raise BillingError('INVALID_INPUT','文字请求 JSON 无效')
        text,config=await asyncio.to_thread(service.text,body['prompt'],body)
        return JSONResponse({'text':text,'provider':config['provider'],'model':config['model']},headers={'Cache-Control':'no-store'})

    async def transcribe(self,request,service):
        check_length(request,MAX_MULTIPART)
        if not request.headers.get('content-type','').lower().startswith('multipart/form-data'):raise BillingError('INVALID_INPUT','请上传 multipart 格式的已准备音频')
        total=0;overflow=False
        async def limited_stream():
            nonlocal total,overflow
            async for chunk in request.stream():
                total+=len(chunk)
                if total>MAX_MULTIPART:
                    overflow=True;raise MultiPartException('Upload exceeds limit')
                yield chunk
        parser=MultiPartParser(request.headers,limited_stream(),max_files=1,max_fields=1,max_part_size=16384)
        form=None
        try:
            try:form=await parser.parse()
            except MultiPartException:raise BillingError('PAYLOAD_TOO_LARGE' if overflow else 'INVALID_INPUT','音频上传过大或 multipart 格式无效',413 if overflow else 422)
            if len(form.multi_items())!=2 or set(form.keys())!={'body','file'}:raise BillingError('INVALID_INPUT','上传必须仅包含 body 和 file')
            upload=form['file'];raw=form['body']
            if not isinstance(upload,UploadFile) or not isinstance(raw,str) or len(raw.encode('utf-8'))>16384:raise BillingError('INVALID_INPUT','音频或计费标识格式无效')
            try:body=validate_body(json.loads(raw))
            except (ValueError,UnicodeError):raise BillingError('INVALID_INPUT','音频计费标识 JSON 无效')
            if not (upload.filename or '').lower().endswith('.mp3') or upload.content_type not in ('audio/mpeg','audio/mp3'):raise BillingError('INVALID_INPUT','云端仅接受本地助手准备的 MP3，不接收视频')
            if upload.size is not None and not 0<upload.size<=MAX_AUDIO:raise BillingError('PAYLOAD_TOO_LARGE','音频不得超过 50 MB',413)
            with tempfile.TemporaryDirectory(prefix='ynote-relay-audio-') as temporary:
                path=Path(temporary)/'prepared-audio.mp3';size=0
                with path.open('wb') as output:
                    while True:
                        chunk=await upload.read(1024*1024)
                        if not chunk:break
                        size+=len(chunk)
                        if size>MAX_AUDIO:raise BillingError('PAYLOAD_TOO_LARGE','音频不得超过 50 MB',413)
                        output.write(chunk)
                if not size:raise BillingError('INVALID_INPUT','上传音频为空')
                await asyncio.to_thread(validate_mp3,path)
                result=await asyncio.to_thread(service.transcribe,path,body)
                return JSONResponse(result,headers={'Cache-Control':'no-store'})
        finally:
            if form is not None:await form.close()
            else:
                for file in parser._files_to_close_on_error:file.close()


def validate_mp3(path):
    try:
        probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration,format_name:stream=codec_type,codec_name','-of','json',str(path)],capture_output=True,timeout=25,check=True)
        metadata=json.loads(probe.stdout);duration=Decimal(str(metadata['format']['duration']));streams=metadata.get('streams') or []
        if metadata['format'].get('format_name')!='mp3' or not duration.is_finite() or not 0<duration<=3600 or not streams or any(stream.get('codec_type')!='audio' or stream.get('codec_name')!='mp3' for stream in streams):raise ValueError()
    except (OSError,subprocess.SubprocessError,KeyError,TypeError,ValueError,InvalidOperation):raise BillingError('INVALID_INPUT','音频必须是真实 MP3、仅含音轨且时长不超过 1 小时；云端不会转码')
