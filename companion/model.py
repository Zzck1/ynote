"""Pinned multilingual medium model, atomic verified download and resumable bytes."""
import hashlib,json,os,shutil,threading,time
from pathlib import Path
from urllib.parse import urlsplit,urljoin
import httpx
from backend.provider_profiles import public_addresses

LOCK=json.loads(Path(__file__).with_name('model.lock.json').read_text('utf-8'))
HOSTS=('huggingface.co','hf.co','xethub.hf.co','cas-bridge.xethub.hf.co','cdn-lfs.huggingface.co','cdn-lfs.hf.co','us.aws.cdn.hf.co','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')

def stream(url,offset):
    for _ in range(8):
        p=urlsplit(url)
        if p.scheme!='https' or not any(p.hostname==h or p.hostname.endswith('.'+h) for h in HOSTS):raise ValueError('模型下载重定向到未批准来源')
        ip=public_addresses(url,allow_query=True)[0];netloc='['+ip+']' if ':' in ip else ip
        client=httpx.Client(timeout=httpx.Timeout(30,read=45),trust_env=False,follow_redirects=False)
        req=client.build_request('GET','https://'+netloc+p.path+('?' +p.query if p.query else ''),headers={'Host':p.hostname,**({'Range':f'bytes={offset}-'} if offset else {})})
        req.extensions['sni_hostname']=p.hostname
        r=client.send(req,stream=True)
        if r.status_code in (301,302,303,307,308):
            nxt=urljoin(url,r.headers['location']);r.close();client.close();url=nxt;continue
        return client,r
    raise ValueError('模型下载重定向过多')

class Model:
    def __init__(self,root,verify_on_init=True):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True);self.lock=threading.RLock();self.cancel=threading.Event();self.thread=None
        self.state='not_ready';self.error=None;self.loaded=False;self.verified_signature=None
        if verify_on_init:self.verify()
    def verify(self):
        signature=[]
        for f in LOCK['files']:
            p=self.root/f['name']
            if not p.is_file() or p.is_symlink() or p.stat().st_size!=f['bytes']:self.state='not_ready';return False
            signature.append((p.stat().st_size,p.stat().st_mtime_ns))
        if signature==self.verified_signature:return True
        for f in LOCK['files']:
            p=self.root/f['name']
            with p.open('rb') as fd:digest=hashlib.file_digest(fd,'sha256').hexdigest()
            if digest!=f['sha256']:self.state='corrupt';self.error='模型校验失败，请重新下载';self.loaded=False;return False
        self.verified_signature=signature;self.state='verified';return True
    def status(self):
        with self.lock:
            total=sum(f['bytes'] for f in LOCK['files']);done=0
            for f in LOCK['files']:
                p=self.root/f['name'];part=p.with_suffix(p.suffix+'.part')
                done+=min(f['bytes'],p.stat().st_size if p.exists() else part.stat().st_size if part.exists() else 0)
            return {'model':'medium','engine':'faster-whisper','engine_version':LOCK['engine_version'],'compute_type':'int8','device':'cpu',
                    'state':self.state,'load_verified':self.loaded,'downloaded_bytes':done,'total_bytes':total,'free_bytes':shutil.disk_usage(self.root).free,
                    'required_free_bytes':max(0,total-done)+1024*1024*1024,'error':self.error,'source':f"https://huggingface.co/{LOCK['repository']}/tree/{LOCK['revision']}",
                    'revision':LOCK['revision'],'gpu_supported':False}
    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():return
            self.cancel.clear();self.state='downloading';self.error=None;self.loaded=False
            self.thread=threading.Thread(target=self.download,daemon=True);self.thread.start()
    def download(self):
        try:
            if shutil.disk_usage(self.root).free<self.status()['required_free_bytes']:raise ValueError('磁盘空间不足，请先腾出空间')
            for f in LOCK['files']:
                p=self.root/f['name'];part=p.with_suffix(p.suffix+'.part')
                if p.exists():
                    with p.open('rb') as fd:ok=p.stat().st_size==f['bytes'] and hashlib.file_digest(fd,'sha256').hexdigest()==f['sha256']
                    if ok:continue
                offset=part.stat().st_size if part.exists() else 0
                if offset>f['bytes']:part.unlink();offset=0
                if offset<f['bytes']:
                    url=f"https://huggingface.co/{LOCK['repository']}/resolve/{LOCK['revision']}/{f['name']}"
                    client,r=stream(url,offset)
                    try:
                        if r.status_code==200:offset=0
                        elif r.status_code==206:
                            if not r.headers.get('content-range','').startswith(f'bytes {offset}-'):raise ValueError('断点响应不匹配，请重试')
                        else:raise ValueError(f'模型下载服务返回 HTTP {r.status_code}，请稍后重试')
                        with part.open('ab' if offset else 'wb') as fd:
                            for chunk in r.iter_bytes(1024*1024):
                                if self.cancel.is_set():self.state='cancelled';return
                                if fd.tell()+len(chunk)>f['bytes']:raise ValueError('模型下载大小超过固定清单')
                                fd.write(chunk)
                            fd.flush();os.fsync(fd.fileno())
                    finally:r.close();client.close()
                with part.open('rb') as fd:digest=hashlib.file_digest(fd,'sha256').hexdigest()
                if part.stat().st_size!=f['bytes'] or digest!=f['sha256']:
                    part.unlink(missing_ok=True);raise ValueError('模型校验失败，已丢弃损坏临时文件，请重试')
                os.replace(part,p)
            self.verified_signature=None;self.verify()
        except Exception as exc:
            self.state='failed';self.error=str(exc) if isinstance(exc,ValueError) else '模型下载失败，可重试并继续已下载的部分'
