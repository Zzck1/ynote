"""Trusted cloud server factory; platform key stays outside deliverable code."""
import json,os
from pathlib import Path
from backend.cloud import create_cloud_app
from backend.platform_config import load_platform,PlatformRuntime

def app_factory():
    root=Path(os.environ.get('YNOTE_CLOUD_DATA','./ynote-cloud-data'))
    config=load_platform(root)
    runtime=PlatformRuntime(root,config['price'],config['platform_key'],config['verified_profile'])
    return create_cloud_app(root=root,**config,platform_runtime=runtime,require_companion=True,
                            origins=tuple(os.environ.get('YNOTE_ALLOWED_ORIGINS','https://yuanshengzhe.com').split(',')))
