"""Trusted configuration only. Never expose this object through website APIs."""
import hashlib
import json
import os
import threading
from pathlib import Path
from .provider_profiles import PROFILES

def load_platform(root, use_windows_keystore=False):
    root=Path(root)
    key=os.environ.get('YNOTE_SILICONFLOW_API_KEY','').strip()
    if not key and os.name=='nt' and (use_windows_keystore or os.environ.get('YNOTE_USE_WINDOWS_KEYSTORE')=='1'):
        from .admin_config import read_key
        key=read_key().strip()
    price_path=Path(os.environ.get('YNOTE_PLATFORM_PRICE_FILE',str(root/'platform-price.json')))
    price=json.loads(price_path.read_text('utf-8')) if price_path.exists() else None
    if price:
        if price.get('model')!=PROFILES['siliconflow'][1] or any(type(price.get(k)) is not int or price[k]<0 for k in ('input','output','cache')) or not price.get('version') or not price.get('effective_at'):
            raise RuntimeError('平台价格配置无效，未启用调用')
        off=price.get('off_peak')
        if off and any(type(off.get(k)) is not int or off[k]<0 or off[k]>price[k] for k in ('input','output','cache')):
            raise RuntimeError('平台分时价格配置无效')
        asr=price.get('asr')
        if asr and (asr.get('model')!='Qwen/Qwen3-ASR-1.7B' or asr.get('verified') is not True or type(asr.get('audio_nano_cny_per_second')) is not int or asr['audio_nano_cny_per_second']!=220000 or asr.get('billing_unit')!='input_audio_second' or asr.get('max_bytes')!=50000000 or asr.get('max_seconds')!=3600 or not asr.get('version')):
            raise RuntimeError('平台转写价格或规格配置无效，拒绝启用未经适配的计费模型')
        quick=price.get('asr_quick')
        if quick and (quick.get('model')!='FunAudioLLM/SenseVoiceSmall' or quick.get('verified') is not True or type(quick.get('audio_nano_cny_per_second')) is not int or quick['audio_nano_cny_per_second']!=0 or any(type(quick.get(k)) is not int or quick[k]!=0 for k in ('input','output','cache')) or quick.get('max_bytes')!=50000000 or quick.get('max_seconds')!=3600 or not quick.get('version')):
            raise RuntimeError('快速提取价格或规格配置无效')
    verified=os.environ.get('YNOTE_PLATFORM_PROFILE_VERIFIED')=='1'
    proof_path=root/'platform-verification.json'
    if not verified and key and price and proof_path.exists():
        proof=json.loads(proof_path.read_text('utf-8'))
        verified=(proof.get('success') is True and proof.get('key_sha256')==hashlib.sha256(key.encode()).hexdigest()
                  and proof.get('model')==PROFILES['siliconflow'][1] and proof.get('price_version')==price['version'])
    return {'platform_key':key,'price':price,'verified_profile':verified}


class PlatformRuntime:
    """Shared server-only credentials. Existing visitor apps see validated updates."""
    def __init__(self,root,price,key='',verified=False):
        self.root=Path(root);self.price=price or {};self.lock=threading.RLock()
        self._key=key;self._verified=verified
        proof=self.root/'platform-verification.json'
        self._asr_verified=False
        if verified and key and proof.exists():
            data=json.loads(proof.read_text('utf-8'))
            required={item.get('model') for item in (self.price.get('asr') or {},self.price.get('asr_quick') or {}) if item.get('model')}
            self._asr_verified=(data.get('key_sha256')==hashlib.sha256(key.encode()).hexdigest() and data.get('asr_model')==(self.price.get('asr') or {}).get('model') and required.issubset(set(data.get('asr_models',[]))))
        if verified and os.environ.get('YNOTE_PLATFORM_ASR_VERIFIED')=='1':self._asr_verified=True

    def snapshot(self):
        with self.lock:return self._key,self._verified,self._asr_verified

    def verify_and_save(self,key):
        from .admin_config import save_key
        from .billing import BillingError
        from .cloud_service import upstream
        import httpx
        if not isinstance(key,str) or not key or len(key)>4096 or any(not 33<=ord(c)<=126 for c in key):
            raise BillingError('INVALID_INPUT','请输入有效的硅基流动 API Key')
        try:response=upstream('GET',PROFILES['siliconflow'][0],'/models',key)
        except httpx.HTTPError:raise BillingError('PROVIDER_UNAVAILABLE','无法连接硅基流动，配置未修改',503)
        if not response.is_success:raise BillingError('BYOK_INVALID','平台 Key 验证失败，请确认 Key 有效且有模型权限',422)
        try:models={entry['id'] for entry in response.json()['data']}
        except (KeyError,TypeError,ValueError):raise BillingError('PROVIDER_UNAVAILABLE','服务商返回的模型列表无效',503)
        asr_models={item.get('model') for item in (self.price.get('asr') or {},self.price.get('asr_quick') or {}) if item.get('model')}
        required={self.price.get('model')}|asr_models
        if None in required or not required.issubset(models):raise BillingError('BYOK_INVALID','该 Key 未列出所需的文本模型和转写模型权限')
        # Serialize encrypted credential + proof writes and in-memory activation;
        # simultaneous admin submissions must not leave mismatched files.
        with self.lock:
            save_key(key)
            self.root.mkdir(parents=True,exist_ok=True)
            proof={'success':True,'key_sha256':hashlib.sha256(key.encode()).hexdigest(),'model':self.price['model'],'asr_model':self.price['asr']['model'],'asr_models':sorted(asr_models),'price_version':self.price['version'],'verification':'authenticated-model-list-and-official-api-contract'}
            path=self.root/'platform-verification.json';tmp=path.with_suffix('.tmp')
            tmp.write_text(json.dumps(proof),encoding='utf-8');tmp.replace(path)
            self._key=key;self._verified=True;self._asr_verified=True
        return {'ok':True,'message':'平台 Key 已加密保存，文本与两种转写模式已启用。验证未执行付费生成。','text_model':self.price['model'],'asr_model':self.price['asr']['model'],'asr_models':sorted(asr_models)}
