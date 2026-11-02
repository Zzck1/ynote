"""Opt-in, loopback-only administration for this local preview."""
import secrets
from urllib.parse import urlsplit
from fastapi.responses import HTMLResponse, JSONResponse
from .billing import BillingError


def install_local_admin(gateway,runtime,origins):
    token=secrets.token_urlsafe(32)

    def allowed(request):
        host=urlsplit('http://'+request.headers.get('host','')).hostname
        peer=request.client.host if request.client else ''
        return host in ('127.0.0.1','localhost','::1') and peer in ('127.0.0.1','::1')

    async def dispatch(request):
        if not allowed(request):raise BillingError('ADMIN_FORBIDDEN','仅允许本机管理员访问',403)
        if request.url.path=='/admin/platform' and request.method=='GET':
            page=HTML.replace('__TOKEN__',token)
            return HTMLResponse(page,headers={'Cache-Control':'no-store','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'nonce-"+token+"'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"})
        if request.url.path=='/api/admin/platform' and request.method=='POST':
            if request.headers.get('origin') not in origins or not secrets.compare_digest(request.headers.get('x-ynote-admin',''),token):raise BillingError('ADMIN_FORBIDDEN','管理请求未授权',403)
            try:
                if int(request.headers.get('content-length','0'))>8192:raise ValueError()
                body=await request.json()
                if not isinstance(body,dict):raise ValueError()
            except (TypeError,ValueError):raise BillingError('INVALID_INPUT','配置请求无效')
            import asyncio
            try:result=await asyncio.to_thread(runtime.verify_and_save,body.get('api_key'))
            except (OSError,RuntimeError):raise BillingError('CREDENTIAL_STORAGE_FAILED','Windows 凭据加密保存失败，请用当前 Windows 用户启动后端后重试；平台 Key 尚未启用',503)
            return JSONResponse(result,headers={'Cache-Control':'no-store'})
        raise BillingError('METHOD_NOT_ALLOWED','管理接口不支持此操作',405)

    gateway.state.local_admin=dispatch


HTML='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ynote · 后端平台配置</title>
<style>body{font:16px/1.7 system-ui;background:#f5f7fc;color:#17283e;margin:0;padding:32px 18px}main{max-width:640px;margin:auto;background:white;border-radius:20px;padding:28px}h1{font-size:25px}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #bbc9dc;border-radius:9px;font-size:16px}button,a{display:inline-block;margin-top:16px}button{background:#506de3;color:white;border:0;padding:12px 18px;border-radius:9px;cursor:pointer}small{color:#52647c}#status{white-space:pre-wrap}a{color:#425fca}</style>
<main><h1>配置全站统一 API Key</h1><p>服务商：硅基流动。填写一次，所有访客使用后端统一服务。</p><p>文本：DeepSeek-V4.1-Flash<br>快速提取：FunAudioLLM/SenseVoiceSmall<br>精准提取：Qwen/Qwen3-ASR-1.7B</p><p><small>Key 只提交到本机后端，由 Windows 当前用户加密保存，不会写入前端或返回浏览器。保存前只验证鉴权与模型列表，不执行付费生成。两种提取与文本共用全站每日 10 元预算；SenseVoice 当前免费，Qwen 按实际上传音频时长及官方每秒 0.00022 元费率计入平台预算。</small></p>
<label for="key">硅基流动 API Key</label><input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="在此粘贴平台 Key"><button id="save">验证、加密保存并启用</button><p id="status" role="status"></p><a href="/">返回工作台</a></main>
<script nonce="__TOKEN__">document.getElementById('save').onclick=async()=>{const button=document.getElementById('save'),input=document.getElementById('key'),status=document.getElementById('status');button.disabled=true;status.textContent='正在验证平台 Key…';try{const response=await fetch('/api/admin/platform',{method:'POST',headers:{'Content-Type':'application/json','X-Ynote-Admin':'__TOKEN__'},body:JSON.stringify({api_key:input.value.trim()})});let data;try{data=await response.json()}catch{throw Error('后端暂时不可用，请稍后重试（HTTP '+response.status+'）')}if(!response.ok)throw Error(data.error?.message||'配置失败');input.value='';status.textContent=data.message+'\\n现在可返回工作台刷新后提取。'}catch(error){status.textContent=error.message}finally{button.disabled=false}};</script></html>'''
