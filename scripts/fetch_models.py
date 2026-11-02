"""Download only explicitly approved, pinned public model resources. No inference or uploads."""
import hashlib, json, urllib.request, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
models = json.loads((ROOT/'scripts/models.lock.json').read_text('utf-8'))
for model in models:
    for item in model['files']:
        target = ROOT/'frontend/public/models'/model['id']/'resolve'/model['revision']/item['name']
        def valid(path):
            if not path.exists() or path.stat().st_size != item['bytes']: return False
            data = path.read_bytes()
            return (hashlib.sha256(data).hexdigest() == item['sha256']) if item['sha256'] else hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest() == item['gitBlob']
        if valid(target):
            print('VERIFIED', model['kind'], item['name'], flush=True); continue
        target.parent.mkdir(parents=True,exist_ok=True)
        part = target.with_name(target.name+'.part')
        url = model['source']+'/resolve/'+model['revision']+'/'+item['name']
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=90) as response, part.open('wb') as output:
                    size=0; last=0
                    while chunk := response.read(1024*1024):
                        output.write(chunk); size+=len(chunk)
                        if size-last >= 32*1024*1024:
                            print('DOWNLOAD',model['kind'],item['name'],size,item['bytes'],flush=True);last=size
                if not valid(part): raise RuntimeError('Model hash/size mismatch')
                part.replace(target);print('VERIFIED',model['kind'],item['name'],size,flush=True); break
            except Exception:
                if attempt==2: raise
                time.sleep(1)
