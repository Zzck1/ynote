"""Local media preparation and origin-bound calls to the website model gateway."""
from decimal import Decimal,InvalidOperation
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
import httpx
from backend.billing import BillingError
from backend.provider_profiles import public_addresses

BILLING_FIELDS=('tool','billing_mode','idempotency_key','connection_id','connections','extraction_mode')
DEV_ORIGIN='http://127.0.0.1:8792'
MAX_AUDIO=50_000_000


class CloudRelay:
    def __init__(self,origins,clock=time.time):
        self.origins=tuple(origins);self.clock=clock;self.lock=threading.RLock();self.leases={}

    def valid_origin(self,origin):
        if not isinstance(origin,str) or origin not in self.origins:return False
        try:
            parsed=urlsplit(origin)
            if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:return False
            return origin==DEV_ORIGIN or (parsed.scheme=='https' and parsed.hostname and parsed.port in (None,443))
        except ValueError:return False

    def configure(self,body,origin):
        if not isinstance(body,dict) or set(body)!={'token','expires_at','origin'} or body.get('origin')!=origin or not self.valid_origin(origin):raise BillingError('INVALID_INPUT','云端连接必须来自当前已配对网站，且仅包含临时连接凭据')
        token=body['token'];expiry=body['expires_at'];now=self.clock()
        if not isinstance(token,str) or not 32<=len(token)<=512 or any(not 33<=ord(character)<=126 for character in token):raise BillingError('INVALID_INPUT','云端临时连接凭据无效')
        if isinstance(expiry,bool) or not isinstance(expiry,(int,float)) or not now<expiry<=now+3605:raise BillingError('INVALID_INPUT','云端临时连接已过期或有效期过长')
        with self.lock:self.leases[origin]={'token':token,'expires_at':expiry}
        return self.status(origin)

    def status(self,origin):
        with self.lock:
            lease=self.leases.get(origin)
            if lease and lease['expires_at']<=self.clock():self.leases.pop(origin,None);lease=None
            return {'configured':bool(lease),'origin':origin,'expires_at':lease['expires_at'] if lease else None}

    def clear(self,origin,expected_token=None):
        with self.lock:
            current=self.leases.get(origin)
            if current and (expected_token is None or current['token']==expected_token):self.leases.pop(origin,None)

    def _lease(self,origin):
        if not self.valid_origin(origin):raise BillingError('RELAY_UNAUTHORIZED','模型请求缺少可信网站来源，请重新配对助手',401)
        with self.lock:
            lease=self.leases.get(origin)
            if not lease or lease['expires_at']<=self.clock():
                self.leases.pop(origin,None);raise BillingError('RELAY_EXPIRED','网站模型连接已过期，请在网页重新连接助手',401)
            return dict(lease)

    def _post(self,origin,path,**kwargs):
        if path not in ('/api/relay/text','/api/relay/transcribe'):raise BillingError('INVALID_INPUT','模型转发接口无效')
        lease=self._lease(origin);parsed=urlsplit(origin)
        extensions={};headers={'Origin':origin,'Authorization':'Bearer '+lease['token']}
        if parsed.scheme=='https':
            addresses=public_addresses(origin);address=addresses[0]
            target='https://'+('['+address+']' if ':' in address else address)+path
            headers['Host']=parsed.hostname;extensions['sni_hostname']=parsed.hostname
        else:target=DEV_ORIGIN+path
        try:
            with httpx.Client(timeout=180,trust_env=False,follow_redirects=False) as client:
                request=client.build_request('POST',target,headers=headers,**kwargs)
                request.extensions.update(extensions)
                response=client.send(request)
            if not response.is_success:
                if response.status_code==401:self.clear(origin,lease['token'])
                try:error=response.json().get('error',{})
                except (ValueError,AttributeError):error={}
                code=error.get('code');message=error.get('message')
                if not isinstance(code,str) or not code.isascii() or len(code)>80:code='PROVIDER_UNAVAILABLE'
                if not isinstance(message,str) or not message.strip() or len(message)>500:message='网站模型网关请求失败，未自动重试'
                raise BillingError(code,message,response.status_code if response.status_code>=400 else 502)
            result=response.json()
            if not isinstance(result,dict):raise ValueError()
            return result
        except (httpx.HTTPError,OSError,ValueError):raise BillingError('PROVIDER_UNAVAILABLE','无法连接网站模型网关，未自动重试',503)

    def _context(self,body):
        if not isinstance(body,dict):raise BillingError('INVALID_INPUT','模型请求格式无效')
        if any(key in body for key in ('model','base_url','api_key','platform_key','key')):raise BillingError('INVALID_INPUT','助手只接受提取模式和计费标识，模型、服务地址与 Key 由网站后端管理')
        origin=body.get('_relay_origin');self._lease(origin)
        context={key:body[key] for key in BILLING_FIELDS if key in body}
        if context.get('tool')!='ynote' or context.get('billing_mode') not in ('platform','byok'):raise BillingError('INVALID_INPUT','模型请求需要明确的 Ynote 计费方式')
        if context.get('extraction_mode','precise') not in ('quick','precise'):raise BillingError('INVALID_INPUT','提取模式仅支持 quick 或 precise')
        key=context.get('idempotency_key')
        if not isinstance(key,str) or not 1<=len(key)<=200:raise BillingError('INVALID_INPUT','模型请求需要幂等标识')
        return origin,context

    def text(self,prompt,body):
        origin,context=self._context(body)
        if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>100000 or len(prompt.encode('utf-8'))>200000:raise BillingError('INVALID_INPUT','文字长度无效或超过限制')
        result=self._post(origin,'/api/relay/text',json={**context,'prompt':prompt})
        text=result.get('text')
        if not isinstance(text,str) or not text.strip():raise BillingError('PROVIDER_UNAVAILABLE','网站文本模型返回空内容，未自动重试',503)
        return text,{'provider':str(result.get('provider','gateway'))[:100],'model':str(result.get('model',''))[:200]}

    def transcribe(self,path,body):
        origin,context=self._context(body);path=Path(path)
        metadata=probe_audio(path);streams=metadata['streams']
        ready=(metadata['format'].get('format_name')=='mp3' and len(streams)==1 and streams[0].get('codec_name')=='mp3' and streams[0].get('channels')==1 and streams[0].get('sample_rate')=='16000' and str(streams[0].get('bit_rate','')).isdigit() and int(streams[0]['bit_rate'])<=64000 and path.stat().st_size<=MAX_AUDIO)
        if ready:return self._send_audio(origin,path,context)
        with tempfile.TemporaryDirectory(prefix='ynote-companion-asr-') as temporary:
            audio=Path(temporary)/'prepared-audio.mp3'
            try:
                subprocess.run(['ffmpeg','-nostdin','-y','-v','error','-i',str(path),'-map','0:a:0','-vn','-ac','1','-ar','16000','-b:a','64k',str(audio)],capture_output=True,timeout=180,check=True)
            except (OSError,subprocess.SubprocessError):raise BillingError('TRANSCRIBE_FAILED','本机音轨准备失败或超时；原视频未上传',422)
            probe_audio(audio)
            return self._send_audio(origin,audio,context)

    def _send_audio(self,origin,path,context):
        if not 0<path.stat().st_size<=MAX_AUDIO:raise BillingError('INVALID_INPUT','转写音频不得超过 50 MB；原视频未上传')
        with path.open('rb') as audio:
            result=self._post(origin,'/api/relay/transcribe',data={'body':json.dumps(context)},files={'file':('prepared-audio.mp3',audio,'audio/mpeg')})
        text=result.get('text');segments=result.get('segments')
        if not (isinstance(text,str) and text.strip()) and not (isinstance(segments,list) and segments):raise BillingError('TRANSCRIBE_FAILED','网站转写返回空内容；未生成笔记',422)
        return result


def probe_audio(path):
    try:
        if not path.is_file() or not path.stat().st_size:raise ValueError()
        response=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration,format_name:stream=codec_type,codec_name,channels,sample_rate,bit_rate','-of','json',str(path)],capture_output=True,timeout=25,check=True)
        metadata=json.loads(response.stdout);duration=Decimal(str(metadata['format']['duration']))
        streams=metadata.get('streams') or []
        if not duration.is_finite() or not 0<duration<=3600 or not any(stream.get('codec_type')=='audio' for stream in streams):raise ValueError()
        return metadata
    except (OSError,subprocess.SubprocessError,KeyError,ValueError,TypeError,InvalidOperation):raise BillingError('TRANSCRIBE_FAILED','本机文件无可用音轨、不可解码或超过 1 小时限制；原视频未上传',422)
