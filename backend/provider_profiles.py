"""Exact approved endpoints; no caller-controlled upstream options or redirects."""
import ipaddress,socket
from urllib.parse import urlsplit
from .billing import BillingError

PROFILES={
 'siliconflow':('https://api.siliconflow.cn/v1','deepseek-ai/DeepSeek-V4.1-Flash'),
 'deepseek':('https://api.deepseek.com','deepseek-flash'),
 'kimi':('https://api.moonshot.cn/v1','kimi-k2.6'),
 'openai':('https://api.openai.com/v1','gpt-6-luna'),
 'zhipu':('https://open.bigmodel.cn/api/paas/v4','glm-5.3-flash'),
 'qwen':('https://dashscope.aliyuncs.com/compatible-mode/v1','qwen3.7-plus'),
 'vectide':('https://vectide.cn/v1',''),
}
def is_public(address):
    ip=ipaddress.ip_address(address)
    return ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_unspecified
def profile(base):
    for name,(url,_) in PROFILES.items():
        if base==url:return name
    raise BillingError('BYOK_INVALID','服务地址未获服务端批准')
def public_addresses(base,allow_query=False):
    p=urlsplit(base)
    if p.scheme!='https' or p.port not in (None,443) or p.username or p.password or (p.query and not allow_query) or p.fragment:raise BillingError('BYOK_INVALID','仅允许批准的 HTTPS 地址')
    try:
        from .network_dns import public_source_addresses
        addresses=sorted(set(public_source_addresses(p.hostname,443)))
    except OSError:raise BillingError('PROVIDER_UNAVAILABLE','无法解析服务商地址',503)
    if not addresses or any(not is_public(a) for a in addresses):raise BillingError('BYOK_INVALID','服务地址指向受保护网络')
    return addresses
def payload(provider,model,messages,limit=2500):
    body={'model':model,'messages':messages,'stream':False}
    if provider=='openai':body.update(max_completion_tokens=limit,reasoning_effort='none')
    else:body['max_tokens']=limit
    if provider in ('siliconflow','qwen'):body['enable_thinking']=False
    if provider in ('deepseek','kimi','zhipu'):body['thinking']={'type':'disabled'}
    return body
