import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { CheckCircle2, Download, Laptop, LoaderCircle, Monitor, WandSparkles, X } from 'lucide-react'
import { companionSnapshot, subscribeCompanion, connectCompanion, companionRequest, LOCAL_URL, updateCompanionReady, ensureCloudRelay, setCompanionPolicy } from '../api/companion'
import { companionDownload, type CompanionRelease } from '../api/companionRelease'
import { parseQuota, type QuotaSnapshot } from '../api/quotaTypes'
import { useQuotaStore } from '../stores/quotaStore'
import './first-use-setup.css'
import { browserLocal } from '../browser/mode'
import { requestSetup } from '../browser/setupFlow'

type ComponentStatus = { state: string; downloaded_bytes: number; total_bytes: number; error?: string }
type Progress = { label: string; value?: number; max?: number }
type Health = {application?:string;protocol?:number;capabilities?:string[]}
type InstallReason = 'missing' | 'outdated' | null
export type OneClickSetupDependencies = {
  health:(signal:AbortSignal)=>Promise<Health|null>
  paired:()=>boolean
  connect:(signal:AbortSignal)=>Promise<void>
  tools:(signal:AbortSignal)=>Promise<ComponentStatus>
  prepareTools:(signal:AbortSignal)=>Promise<ComponentStatus>
  platform:(signal:AbortSignal)=>Promise<QuotaSnapshot>
  configureRelay:(signal:AbortSignal)=>Promise<void>
  relay:(signal:AbortSignal)=>Promise<{configured:boolean;origin:string;expires_at:number}>
  ready:()=>void
  wait:(milliseconds:number,signal:AbortSignal)=>Promise<void>
  now:()=>number
  origin:string
}
function checkCancelled(signal:AbortSignal){if(signal.aborted)throw new DOMException('已停止配置检测','AbortError')}
export function waitForSetup(milliseconds:number,signal:AbortSignal):Promise<void>{
  checkCancelled(signal)
  return new Promise((resolve,reject)=>{
    const cancelled=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancelled);reject(new DOMException('已停止配置检测','AbortError'))}
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancelled);resolve()},milliseconds)
    signal.addEventListener('abort',cancelled,{once:true})
  })
}
/** One abortable workflow: install/start detection, pairing, tools, platform and relay. */
export async function runOneClickSetup(deps:OneClickSetupDependencies,signal:AbortSignal,onProgress:(progress:Progress)=>void,onInstall:(reason:InstallReason)=>void):Promise<void>{
  const detectionDeadline=deps.now()+15*60_000
  onProgress({label:'正在检查助手安装、运行与版本…'})
  while(true){
    checkCancelled(signal)
    const health=await deps.health(signal);checkCancelled(signal)
    if(health?.application==='YnoteCompanion'&&health.protocol===1&&Array.isArray(health.capabilities)&&health.capabilities.includes('cloud_model_relay'))break
    onInstall(health?'outdated':'missing')
    onProgress({label:health?'等待更新并启动媒体助手，检测到新版本后自动继续…':'等待你解压并启动助手，启动后自动继续…'})
    if(deps.now()>detectionDeadline)throw new Error('暂未检测到可用助手。请按本窗口的步骤启动，或允许浏览器本地网络权限后点击重新检查。')
    await deps.wait(2000,signal)
  }
  onInstall(null)
  onProgress({label:'正在检查网站统一模型服务…'})
  const platform=await deps.platform(signal);checkCancelled(signal)
  if(platform.status!=='active'||!platform.platform_available||!platform.capabilities?.text_ai?.available||!platform.capabilities?.transcription?.available)throw new Error(platform.platform_message+'。请联系网站管理员处理；普通用户无需填写平台 Key。')
  if(!deps.paired()){onProgress({label:'请在助手窗口允许配对；如浏览器询问本地网络权限，请自行允许。'});await deps.connect(signal);checkCancelled(signal)}
  let tools:ComponentStatus
  try{tools=await deps.tools(signal)}catch(error){
    checkCancelled(signal)
    onProgress({label:'连接已过期，正在重新配对；请在助手窗口允许。'})
    await deps.connect(signal);checkCancelled(signal);tools=await deps.tools(signal)
  }
  checkCancelled(signal)
  if(tools.state!=='ready'){
    onProgress({label:'正在准备媒体工具，请确认助手窗口中的下载提示。'})
    if(tools.state!=='downloading')tools=await deps.prepareTools(signal)
    const toolsDeadline=deps.now()+60*60_000
    while(tools.state==='downloading'){
      checkCancelled(signal)
      onProgress({label:'正在下载媒体工具，完成后自动继续…',value:tools.downloaded_bytes,max:tools.total_bytes})
      if(deps.now()>toolsDeadline)throw new Error('媒体工具暂未准备完成，可在本窗口重新检查继续。')
      await deps.wait(1500,signal);tools=await deps.tools(signal)
    }
    if(tools.state!=='ready')throw new Error(tools.error||'媒体工具尚未就绪，请重新检查继续。')
  }
  checkCancelled(signal);onProgress({label:'正在连接并验证网站转写与笔记服务…'})
  await deps.configureRelay(signal);checkCancelled(signal)
  const relay=await deps.relay(signal);checkCancelled(signal)
  if(!relay.configured||relay.origin!==deps.origin||!Number.isFinite(relay.expires_at)||relay.expires_at<=deps.now()/1000)throw new Error('网站模型授权尚未就绪，请在本窗口重试。')
  deps.ready();onProgress({label:'助手、媒体工具、转写与笔记服务均已就绪',value:1,max:1})
}

export function FirstUseButton(){
  const connection=useSyncExternalStore(subscribeCompanion,companionSnapshot,companionSnapshot)
  const quota=useQuotaStore(state=>state.quota)
  if(browserLocal())return <button type="button" className="first-use-button" onClick={()=>requestSetup({kinds:['asr','text']})}><Laptop size={16}/>一键配置</button>
  const ready=connection.ready&&quota.capabilities?.text_ai?.available&&quota.capabilities?.transcription?.available
  return <button type="button" className="first-use-button" onClick={()=>window.dispatchEvent(new Event('ynote:open-setup'))}><WandSparkles size={16}/>{ready?'重新检查配置':'一键配置'}</button>
}

export function SetupInstallInstructions({release,hostname,reason,system='windows'}:{release:CompanionRelease|undefined;hostname:string;reason:InstallReason;system?:'windows'|'macos'}){
  const choice=companionDownload(release,hostname)
  if(!reason)return null
  return <section className="mt-4 rounded-lg border border-line bg-subtle p-4" aria-label="助手安装与启动步骤">
    <h3 className="font-semibold">{reason==='outdated'?'更新媒体助手':'安装并启动媒体助手'}</h3>
    {choice.url?<><a className="card-action mt-3" href={choice.url} download><Download size={15}/>下载 {release?.platform==='windows'?'Windows':'Mac'} {choice.testing?'测试包':choice.development?'开发测试包':'助手'}</a><p className="mt-2 text-xs">{release?.file_name} · {release?.bytes?.toLocaleString()} 字节{choice.testing?' · 未签名测试包，管理员已开启测试分发，尚未完成正式发布验收':choice.development?` · ${release?.signature==='valid'?'开发测试包':'未签名开发测试包'}，尚未完成正式发布验收`:''}</p><details className="mt-2 text-xs"><summary>版本与校验信息</summary><p>{release?.version}</p><p className="break-all">SHA-256：{release?.sha256}</p><p>{release?.release_notes}</p></details></>:<p className="mt-2 text-sm">当前系统暂无通过发布条件或本机开发下载条件的安装包。可以停止检测，待管理员提供适配包后重新检查。</p>}
    {choice.url&&<ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
      {reason==='outdated'&&<li>先退出旧版助手，再启动新版，避免两个版本占用同一端口。</li>}
      <li>下载完成后右键 ZIP，选择“全部解压”；不要直接在压缩包里启动。</li>
      {system==='windows'?<li>打开解压后的 YnoteCompanion 文件夹，双击 <strong>Start-YnoteCompanion.cmd</strong>，保持助手运行。</li>:<li>按安装包内 README 说明启动与你的 Mac 芯片匹配的助手，并保持运行。</li>}
      <li>回到此窗口等待自动继续。浏览器如询问本地网络权限、助手如询问配对或工具下载，请由你本人允许；网页不会代替确认。</li>
    </ol>}
    <p className="mt-3 text-xs text-ink-2">启动后会自动检测并继续配置，无需前往其他设置入口。</p>
  </section>
}

export function FirstUseSetup(){
  const navigate=useNavigate()
  const [open,setOpen]=useState(false),[system,setSystem]=useState<'windows'|'macos'>(()=>/Mac/i.test(navigator.userAgent)?'macos':'windows')
  const [architecture,setArchitecture]=useState('arm64'),[attempt,setAttempt]=useState(0)
  const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('')
  const [progress,setProgress]=useState<Progress>({label:'准备检查'}),[installReason,setInstallReason]=useState<InstallReason>(null)
  const [releases,setReleases]=useState<CompanionRelease[]>([])
  const connection=useSyncExternalStore(subscribeCompanion,companionSnapshot,companionSnapshot)
  const quota=useQuotaStore(state=>state.quota)
  const closeRef=useRef<HTMLButtonElement>(null),controller=useRef<AbortController|null>(null)
  function stop(){controller.current?.abort();controller.current=null;setBusy(false);setProgress({label:'已停止自动检测，可点击重新检查继续。'})}
  function close(){stop();setOpen(false)}
  useEffect(()=>{
    const show=()=>{setOpen(true);setAttempt(value=>value+1);setError('');setDone(false);setTimeout(()=>closeRef.current?.focus(),0)}
    window.addEventListener('ynote:open-setup',show)
    return()=>{window.removeEventListener('ynote:open-setup',show);controller.current?.abort()}
  },[])
  useEffect(()=>{
    if(!open)return
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close()}
    window.addEventListener('keydown',escape)
    const manifest=new AbortController()
    void fetch(import.meta.env.BASE_URL+'companion-releases.json',{cache:'no-store',signal:manifest.signal}).then(response=>response.ok?response.json():null).then(data=>{if(!manifest.signal.aborted&&data?.schema_version===1&&data?.protocol===1&&Array.isArray(data.releases))setReleases(data.releases)}).catch(()=>{})
    return()=>{window.removeEventListener('keydown',escape);manifest.abort()}
  },[open])
  useEffect(()=>{
    if(!open)return
    const current=new AbortController();controller.current?.abort();controller.current=current
    setBusy(true);setDone(false);setError('');setInstallReason(null)
    const checked=async(path:string,method='GET')=>{
      checkCancelled(current.signal)
      const response=await companionRequest(path,{method,signal:current.signal})
      const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'助手连接暂不可用')
      return data
    }
    const deps:OneClickSetupDependencies={
      health:async signal=>{try{const response=await fetch(LOCAL_URL+'/v1/health',{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(3500)])});return response.ok?await response.json():null}catch{checkCancelled(signal);return null}},
      paired:()=>companionSnapshot().active,
      connect:signal=>connectCompanion(signal),
      tools:()=>checked('/v1/tools'),prepareTools:()=>checked('/v1/tools/prepare','POST'),
      platform:async signal=>{const response=await fetch('/api/quota?tool=ynote',{credentials:'same-origin',cache:'no-store',signal});const parsed=parseQuota(await response.json());if(parsed.status==='active'){setCompanionPolicy(parsed.processing);useQuotaStore.setState({quota:parsed})}return parsed},
      configureRelay:signal=>ensureCloudRelay(true,signal),
      relay:()=>checked('/v1/cloud/status'),ready:()=>{updateCompanionReady(true);if(!companionSnapshot().ready)throw new Error('助手连接已变化，请重新检查。')},wait:waitForSetup,now:Date.now,origin:location.origin,
    }
    void runOneClickSetup(deps,current.signal,value=>{if(!current.signal.aborted)setProgress(value)},reason=>{if(!current.signal.aborted)setInstallReason(reason)})
      .then(()=>{if(!current.signal.aborted)setDone(true)})
      .catch(err=>{if(!current.signal.aborted){setError((err as Error).message);setProgress({label:'配置尚未完成，可在此窗口重新检查。'})}})
      .finally(()=>{if(controller.current===current){controller.current=null;setBusy(false)}})
    return()=>{current.abort();if(controller.current===current)controller.current=null}
  },[open,system,attempt])
  if(!open)return null
  const release=releases.find(item=>item.platform===system&&item.architecture===(system==='windows'?'x64':architecture))
  return <div className="setup-backdrop" onKeyDown={event=>{
    if(event.key!=='Tab')return
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary'))
    const first=controls[0],last=controls[controls.length-1]
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }}><section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div className="setup-heading"><div className="setup-symbol"><WandSparkles size={24}/></div><button ref={closeRef} type="button" aria-label="关闭配置并停止检测" onClick={close}><X size={20}/></button></div>
    <h2 id="setup-title">一键配置 Ynote</h2>
    <p className="setup-intro">自动检查安装、运行、版本、配对、媒体工具与网站模型连接。缺少助手时，在本窗口下载并手动解压启动，随后自动继续。</p>
    <div className="setup-systems" role="group" aria-label="电脑系统">
      <button type="button" disabled={busy} aria-pressed={system==='windows'} className={system==='windows'?'selected':''} onClick={()=>setSystem('windows')}><Monitor size={24}/><strong>Windows</strong><span>x64</span></button>
      <button type="button" disabled={busy} aria-pressed={system==='macos'} className={system==='macos'?'selected':''} onClick={()=>setSystem('macos')}><Laptop size={24}/><strong>Mac</strong><span>安装包以实际提供为准</span></button>
    </div>
    {system==='macos'&&<label className="block text-sm">Mac 芯片 <select value={architecture} onChange={event=>setArchitecture(event.target.value)}><option value="arm64">Apple Silicon</option><option value="x64">Intel</option></select></label>}
    <div className="setup-progress" aria-live="polite"><p>{busy?<LoaderCircle size={17} className="icon-spin"/>:done?<CheckCircle2 size={17}/>:null}{progress.label}</p>{progress.max&&<progress aria-label={progress.label} value={progress.value} max={progress.max}/>}<small>{connection.state}</small></div>
    <SetupInstallInstructions release={release} hostname={location.hostname} reason={installReason} system={system}/>
    <p className="setup-notice mt-3">只准备媒体工具（未安装时约 81 MB），不下载 ASR 模型，不要求个人 Key。来源：<a href="https://github.com/BtbN/FFmpeg-Builds" target="_blank" rel="noreferrer">BtbN FFmpeg Builds</a>，许可细节以发行包为准。</p>
    {error&&<p className="setup-error" role="alert">{error}</p>}
    <p className="setup-ai-status">网站模型：{quota.platform_message}。平台 Key 仅由网站管理员配置。</p>
    <button type="button" className="setup-start" onClick={()=>{if(done){close();if(location.pathname==='/settings')void navigate('/')}else if(busy){stop()}else{setAttempt(value=>value+1)}}}>{done?'完成，继续提取':busy?'停止自动检测':'重新检查并继续'}</button>
    <p className="mt-3 text-xs text-ink-3">停止或关闭会取消网页检测；已启动的助手不会被网页关闭。配对和浏览器权限须由你本人确认。</p>
  </section></div>
}
