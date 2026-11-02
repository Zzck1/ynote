"""Optional first-run tool download directly from the publisher, with pinned hash."""
import hashlib,json,os,shutil,threading,zipfile
from pathlib import Path,PurePosixPath
from .model import stream

class Tools:
    def __init__(self,root):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True);self.bin=self.root/'bin'
        manifest=Path(__file__).with_name('tools.lock.json')
        self.manifest=json.loads(manifest.read_text('utf-8')) if manifest.exists() else None
        self.state='not_ready';self.error=None;self.cancel=threading.Event();self.thread=None
        self.verify()
    def verify(self):
        if not self.manifest:self.error='依赖锁定清单尚未生成';return False
        for f in self.manifest['files']:
            p=self.bin/f['name']
            if not p.is_file() or p.is_symlink() or p.stat().st_size!=f['bytes']:self.state='not_ready';return False
            with p.open('rb') as fd:valid=hashlib.file_digest(fd,'sha256').hexdigest()==f['sha256']
            if not valid:self.state='corrupt';self.error='媒体组件校验失败，请重新准备';return False
        self.state='ready';return True
    def status(self):
        m=self.manifest or {};p=self.root/'download.zip.part'
        return {'component':'ffmpeg','state':self.state,'version':m.get('version'),'source':m.get('source'),
                'downloaded_bytes':p.stat().st_size if p.exists() else m.get('bytes',0) if self.state=='ready' else 0,
                'total_bytes':m.get('bytes',0),'installed_bytes':m.get('installed_bytes',0),'free_bytes':shutil.disk_usage(self.root).free,
                'required_free_bytes':m.get('bytes',0)+2*m.get('installed_bytes',0),'error':self.error}
    def start(self):
        if not self.thread or not self.thread.is_alive():
            self.cancel.clear();self.state='downloading';self.thread=threading.Thread(target=self.download,daemon=True);self.thread.start()
    def download(self):
        m=self.manifest;part=self.root/'download.zip.part';stage=self.root/'staging'
        try:
            if not m:raise ValueError('组件清单未就绪')
            if shutil.disk_usage(self.root).free<self.status()['required_free_bytes']:raise ValueError('磁盘空间不足')
            offset=part.stat().st_size if part.exists() else 0
            if offset>m['bytes']:part.unlink();offset=0
            if offset<m['bytes']:
                client,r=stream(m['url'],offset)
                try:
                    if r.status_code==200:offset=0
                    elif r.status_code==206:
                        if not r.headers.get('content-range','').startswith(f'bytes {offset}-'):raise ValueError('断点位置不匹配')
                    else:raise ValueError('媒体组件来源暂不可用，请重试或联系发布者更新清单')
                    with part.open('ab' if offset else 'wb') as fd:
                        for chunk in r.iter_bytes(1024*1024):
                            if self.cancel.is_set():self.state='cancelled';return
                            if fd.tell()+len(chunk)>m['bytes']:raise ValueError('组件下载超出固定大小')
                            fd.write(chunk)
                        fd.flush();os.fsync(fd.fileno())
                finally:r.close();client.close()
            with part.open('rb') as fd:valid=part.stat().st_size==m['bytes'] and hashlib.file_digest(fd,'sha256').hexdigest()==m['sha256']
            if not valid:part.unlink(missing_ok=True);raise ValueError('组件校验失败，请重新下载')
            stage.mkdir(exist_ok=True)
            with zipfile.ZipFile(part) as z:
                for info in z.infolist():
                    target=(stage/info.filename).resolve()
                    if not target.is_relative_to(stage.resolve()) or (info.external_attr>>16)&0o170000==0o120000:raise ValueError('组件压缩包含不安全路径')
                for f in m['files']:
                    matches=[i for i in z.infolist() if '/bin/' in i.filename and PurePosixPath(i.filename).name==f['name']]
                    if len(matches)!=1:raise ValueError('组件文件与清单不符')
                    target=stage/f['name']
                    with z.open(matches[0]) as src,target.open('wb') as dst:shutil.copyfileobj(src,dst)
                    with target.open('rb') as fd:valid=hashlib.file_digest(fd,'sha256').hexdigest()==f['sha256']
                    if not valid:raise ValueError('解压组件校验失败')
            self.bin.mkdir(exist_ok=True)
            for f in m['files']:os.replace(stage/f['name'],self.bin/f['name'])
            self.verify()
        except Exception as exc:self.state='failed';self.error=str(exc) if isinstance(exc,ValueError) else '组件准备失败，请稍后重试'
