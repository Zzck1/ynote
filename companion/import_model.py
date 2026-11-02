"""Import only a user-selected offline medium pack matching the built-in lock."""
import hashlib,json,os,shutil,sys,uuid,zipfile
from pathlib import Path
from .model import LOCK
from .server import app_root

def import_pack(pack,root):
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    needed=sum(f['bytes'] for f in LOCK['files'])
    if shutil.disk_usage(root).free<needed+1024*1024*1024:raise ValueError('磁盘空间不足')
    stage=root/('medium-import-'+uuid.uuid4().hex);stage.mkdir()
    try:
        with zipfile.ZipFile(pack) as z:
            names=z.namelist()
            if len(names)!=len(set(names)):raise ValueError('模型包含重复条目')
            for f in LOCK['files']:
                info=z.getinfo(f['name'])
                if info.file_size!=f['bytes']:raise ValueError('模型文件大小不符')
                target=stage/f['name']
                with z.open(info) as source,target.open('wb') as dst:shutil.copyfileobj(source,dst,1024*1024)
                with target.open('rb') as fd:valid=hashlib.file_digest(fd,'sha256').hexdigest()==f['sha256']
                if not valid:raise ValueError('模型校验失败，不安装')
        target=root/'medium';backup=root/('medium-backup-'+uuid.uuid4().hex)
        if target.exists():os.replace(target,backup)
        try:os.replace(stage,target)
        except BaseException:
            if backup.exists():os.replace(backup,target)
            raise
        # Keep old model backup. Removing it is a separate, user-confirmed action.
        return target
    finally:
        if stage.exists():shutil.rmtree(stage)

if __name__=='__main__':
    import ctypes
    try:
        import_pack(sys.argv[1],app_root()/'models')
        ctypes.windll.user32.MessageBoxW(None,'medium 模型已按固定 SHA-256 清单导入。请重新启动助手，再在网页点击“校验并加载模型”。','Ynote',0x40)
    except Exception as exc:
        ctypes.windll.user32.MessageBoxW(None,'模型导入失败：'+(str(exc) if isinstance(exc,ValueError) else '无法读取模型包或目标目录，请检查文件与空间。'),'Ynote',0x10)
        sys.exit(1)
