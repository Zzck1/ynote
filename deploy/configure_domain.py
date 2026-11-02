import argparse,json,re,zipfile,hashlib,os
from pathlib import Path
from urllib.parse import urlsplit
parser=argparse.ArgumentParser();parser.add_argument('--origin',required=True);a=parser.parse_args()
p=urlsplit(a.origin)
if p.scheme!='https' or not p.hostname or p.username or p.password or p.path or p.query or p.fragment or p.port not in (None,443):raise SystemExit('Use an HTTPS origin, e.g. https://notes.example.com, without trailing slash')
root=Path(__file__).resolve().parents[1]
archive=root/'frontend/dist/downloads/YnoteCompanion-0.5.1-media-relay-Windows-x64.zip'
temporary=archive.with_suffix('.tmp')
with zipfile.ZipFile(archive) as source,zipfile.ZipFile(temporary,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as target:
 for entry in source.infolist():
  if entry.filename!='YnoteCompanion/allowed-origins.json':target.writestr(entry,source.read(entry.filename))
 target.writestr('YnoteCompanion/allowed-origins.json',json.dumps({'allowed_origins':[a.origin]},ensure_ascii=False,indent=2))
os.replace(temporary,archive)
with archive.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
for name in ['frontend/dist/companion-releases.json','frontend/public/companion-releases.json']:
 path=root/name;data=json.loads(path.read_text(encoding='utf-8'))
 for release in data['releases']:
  if release['platform']=='windows':release.update(bytes=archive.stat().st_size,sha256=digest,download_url='/downloads/'+archive.name,release_channel='testing',release_authorized=True)
 path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
env=root/'.env'
text=env.read_text(encoding='utf-8') if env.exists() else (root/'.env.example').read_text(encoding='utf-8')
text=re.sub(r'^YNOTE_ALLOWED_ORIGINS=.*$',lambda _: 'YNOTE_ALLOWED_ORIGINS='+a.origin,text,flags=re.M)
env.write_text(text,encoding='utf-8')
nginx=(root/'nginx-https.conf.example').read_text(encoding='utf-8').replace('ynote.example.com',p.hostname)
(root/'site.nginx.conf').write_text(nginx,encoding='utf-8')
print('Configured website and helper allowed origin:',a.origin)
print('Next: edit .env on the server and fill YNOTE_SILICONFLOW_API_KEY. Never put that key into frontend or helper.')
