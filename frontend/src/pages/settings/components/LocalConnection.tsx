import { useEffect, useState, useSyncExternalStore } from 'react'
import { companionSnapshot, subscribeCompanion, connectCompanion, disconnectCompanion, companionRequest, updateCompanionReady, updateCompanionRelayStatus, ensureCloudRelay } from '../../../api/companion'

type Tools = {state:string;downloaded_bytes:number;total_bytes:number;error?:string}
export function LocalConnection() {
  const connection=useSyncExternalStore(subscribeCompanion,companionSnapshot,companionSnapshot)
  const [tools,setTools]=useState<Tools|null>(null)
  const [storage,setStorage]=useState<{model_bytes:number;tools_bytes:number;media_and_result_bytes:number}|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{
    if(!connection.active){setTools(null);setStorage(null);return}
    let disposed=false
    const poll=async()=>{
      try{
        const responses=await Promise.all([companionRequest('/v1/tools'),companionRequest('/v1/storage'),companionRequest('/v1/cloud/status')])
        if(responses.some(response=>!response.ok))throw new Error('助手暂不可用，请重新连接')
        const [media,usage,relay]=await Promise.all(responses.map(response=>response.json()))
        if(!disposed){setTools(media);setStorage(usage);updateCompanionRelayStatus(relay);updateCompanionReady(media.state==='ready')}
      }catch(e){if(!disposed){setError((e as Error).message);updateCompanionReady(false)}}
    }
    void poll();const timer=setInterval(()=>void poll(),2500)
    return()=>{disposed=true;clearInterval(timer)}
  },[connection.active])
  async function action(path:string){
    setBusy(true);setError('')
    try{const response=await companionRequest(path,{method:'POST'});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'操作失败');if(path.startsWith('/v1/tools'))setTools(data)}
    catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  const names:Record<string,string>={not_ready:'未准备',ready:'可用',downloading:'正在下载',cancelled:'下载已取消，可继续',corrupt:'校验失败',failed:'准备失败'}
  return <section className="mt-6 rounded-lg border border-line bg-page p-6">
    <h3 className="text-[15px] font-semibold">本地媒体助手连接</h3>
    <p className="mt-2 text-sm text-ink-2" role="status">{connection.state}</p>
    <p className="mt-2 text-xs text-ink-3">原视频、FFmpeg 转换、截图、文件与历史保存在本机助手。仅准备后的音频和生成笔记所需文字发送到网站模型代理；平台 Key 留在网站后端。切换来源不迁移或合并旧历史，尚未提交的链接文字会保留。刷新网页后需重新配对。</p>
    <div className="mt-4 flex flex-wrap gap-3">
      <button className="card-action" disabled={busy} onClick={()=>{setBusy(true);setError('');void(connection.active?disconnectCompanion():connectCompanion()).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>{busy?'正在处理…':connection.active?'断开媒体助手':'连接本地助手'}</button>
      {connection.active&&<button className="card-action" disabled={busy||tools?.state==='downloading'} onClick={()=>void action('/v1/tools/prepare')}>准备媒体组件</button>}
      {connection.active&&<button className="card-action" disabled={busy} onClick={()=>{setBusy(true);setError('');void ensureCloudRelay(true).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>重新连接网站模型服务</button>}
      {connection.active&&<button className="card-action" disabled={busy} onClick={()=>void action('/v1/cache/clear')}>清理临时下载</button>}
    </div>
    {connection.active&&<p className="mt-3 text-xs text-ink-3">网站模型连接：{connection.relay?'已授权':'未连接或授权已过期'}。无需下载 ASR 模型或填写个人 API Key。</p>}
    {connection.active&&storage&&<p className="mt-3 text-xs text-ink-3">本机占用：工具 {(storage.tools_bytes/1024**2).toFixed(1)} MiB · 媒体与结果 {(storage.media_and_result_bytes/1024**2).toFixed(1)} MiB</p>}
    {connection.active&&tools&&<div className="mt-4 text-sm text-ink-2"><p>FFmpeg / ffprobe · {names[tools.state]||tools.state}</p>{tools.state==='downloading'&&<><progress className="mt-2 w-full" max={tools.total_bytes} value={tools.downloaded_bytes}/><p>{tools.downloaded_bytes.toLocaleString()} / {tools.total_bytes.toLocaleString()} 字节 <button className="card-action" onClick={()=>void action('/v1/tools/cancel')}>取消</button></p></>}{tools.error&&<p role="alert">{tools.error}</p>}</div>}
    {(error||connection.error)&&<p role="alert" className="mt-3 text-sm text-danger">{error||connection.error}。请确认助手已启动；如浏览器提示本地网络权限，请按正常权限流程选择。</p>}
  </section>
}
