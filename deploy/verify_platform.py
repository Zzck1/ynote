import sys,os,json,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.platform_config import load_platform
from backend.cloud_service import upstream
from backend.provider_profiles import PROFILES
root=Path(os.environ.get('YNOTE_CLOUD_DATA','/data'));root.mkdir(parents=True,exist_ok=True)
config=load_platform(root);key=config['platform_key'];price=config['price']
if not key or not price:raise SystemExit('Server Key or platform price is missing; nothing was enabled.')
try:
 response=upstream('GET',PROFILES['siliconflow'][0],'/models',key)
 if not response.is_success:raise ValueError()
 models={x['id'] for x in response.json()['data']}
 asr={price['asr']['model'],price['asr_quick']['model']}
 if not ({price['model']}|asr).issubset(models):raise ValueError()
 proof={'success':True,'key_sha256':hashlib.sha256(key.encode()).hexdigest(),'model':price['model'],'asr_model':price['asr']['model'],'asr_models':sorted(asr),'price_version':price['version'],'verification':'authenticated-model-list-and-official-api-contract'}
 path=root/'platform-verification.json';temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(proof),encoding='utf-8');temporary.replace(path)
except Exception:raise SystemExit('Provider authentication/model-list verification failed. No paid model call was made; check server Key and network.')
print('Text and both ASR model permissions verified. No paid generation/transcription was executed.')
