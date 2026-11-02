/** Loopback credentials live only in memory. Every managed request has one owner. */
import { browserLocal } from '../browser/mode'
import { browserRequest, browserAssetUrl } from '../browser/adapter'
export const LOCAL_URL = 'http://127.0.0.1:18790'

type State = { active: boolean; state: string; token: string; expires: number; error: string; ready: boolean; relay: boolean; relayExpires: number }
type CloudLease = { token: string; expires_at: number; origin: string }
type Session = { token: string; expires: number; owner: number }
let state: State = { active: false, state: '未连接', token: '', expires: 0, error: '', ready: false, relay: false, relayExpires: 0 }
let cloudLease: { session: Session; lease: CloudLease } | null = null
let renewal: { session: Session; promise: Promise<void> } | null = null
let ownerVersion = 0
let connectAttempt = 0
let connecting: AbortController | null = null
let companionRequired = true
const listeners = new Set<() => void>()
export const companionSnapshot = () => state
export const getTaskSourceVersion = () => ownerVersion
export function subscribeCompanion(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
function update(next: Partial<State>) { state = { ...state, ...next }; listeners.forEach(fn => fn()) }
function ownershipChanged() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('ynote:task-source-changed')) }
export function setCompanionPolicy(policy?: {media: 'companion'; models: 'gateway'}) {
  const required = policy?.media === 'companion'
  if (required === companionRequired) return
  companionRequired = required
  if (!state.active) { ownerVersion++; ownershipChanged() }
}
export const requiresCompanion = () => companionRequired
export const localActive = () => state.active && state.expires > Date.now()/1000
export function updateCompanionReady(ready: boolean) {
  const available = ready && localActive() && state.relay && state.relayExpires > Date.now()/1000
  if (state.ready !== available) update({ ready: available, ...(available ? { state: '本地媒体助手与网站模型服务已连接' } : {}) })
}
export function updateCompanionRelayStatus(status: {configured:boolean;origin:string;expires_at:number}) {
  const available=status.configured===true && status.origin===location.origin && Number.isFinite(status.expires_at) && status.expires_at>Date.now()/1000
  if (!available) cloudLease=null
  if(state.relay!==available || state.relayExpires!==status.expires_at)update({relay:available,relayExpires:available?status.expires_at:0,...(!available?{ready:false}:{})})
}
const managed = (path: string) => /^\/api\/(tasks|materials|assets|jobs|exports|media)(\/|\?|$)/.test(path)
const managedModelWrite = (path: string, method: string) => method === 'POST' && /^\/api\/(tasks\/(batch|[^/?]+\/(start|transcript))|materials\/[^/?]+\/(jobs|notes|chat))(\/|\?|$)/.test(path)
function sourceChangedResponse() { return Response.json({error:{code:'TASK_SOURCE_CHANGED',message:'任务数据来源已改变，请从当前助手重新选择任务或重新提交内容。',retryable:false}},{status:409}) }
function sourceChangedError() { return Object.assign(new Error('任务数据来源已改变，请从当前助手重新选择任务。'),{code:'TASK_SOURCE_CHANGED'}) }
function localRequiredResponse() { return Response.json({error:{code:'COMPANION_REQUIRED',message:'请先安装并连接本地媒体助手，再开始提取或导入文件；网站服务器不下载或保存媒体。',retryable:true}},{status:409}) }
function abortError() { return new DOMException('已取消连接','AbortError') }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError() }
function cancellable<T>(promise: Promise<T>,signal?: AbortSignal): Promise<T> {
  if(signal?.aborted){void promise.catch(()=>{});return Promise.reject(abortError())}
  if (!signal) return promise
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(abortError())}
    signal.addEventListener('abort',abort,{once:true})
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
  })
}
function currentSession(): Session { return { token:state.token, expires:state.expires, owner:ownerVersion } }
function sameSession(session:Session) { return state.active && session.owner===ownerVersion && session.token===state.token }
function assertSession(session:Session,signal?:AbortSignal) { checkAbort(signal);if (!sameSession(session) || state.expires<=Date.now()/1000) throw sourceChangedError() }
function invalidate(session:Session,message:string) {
  if (!sameSession(session)) return
  ownerVersion++;cloudLease=null;renewal=null
  update({active:false,token:'',expires:0,ready:false,relay:false,relayExpires:0,state:'需要重新配对',error:message})
  ownershipChanged()
}
function expireCurrent() { if (state.active && state.expires<=Date.now()/1000) invalidate(currentSession(),'本地助手配对已过期，请重新连接') }
export const localHeaders = () => ({ Authorization: `Bearer ${localActive()?state.token:''}`, 'X-Ynote-Protocol': '1' })
async function fetchSession(session:Session,path:string,init:RequestInit = {}) {
  checkAbort(init.signal || undefined)
  const headers=new Headers(init.headers)
  headers.set('Authorization',`Bearer ${session.token}`);headers.set('X-Ynote-Protocol','1')
  return cancellable(fetch(LOCAL_URL+path,{...init,credentials:'omit',cache:'no-store',headers}),init.signal || undefined)
}
async function requestSession(session:Session,path:string,init:RequestInit = {}) {
  try {
    const response=await fetchSession(session,path,init)
    if (response.status===401) invalidate(session,'本地助手配对已失效，请重新连接')
    return response
  } catch(error) {
    if ((error as Error).name!=='AbortError') invalidate(session,'无法连接本地助手，请检查助手是否仍在运行')
    throw error
  }
}
export async function companionRequest(path:string,init:RequestInit = {}) {
  expireCurrent()
  return requestSession(currentSession(),path,init)
}
async function obtainCloudLease(session:Session,signal?:AbortSignal,guard:()=>void=()=>{}) {
  checkAbort(signal);guard()
  const response=await cancellable(fetch('/api/companion/lease',{method:'POST',credentials:'same-origin',cache:'no-store',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:'ynote'})}),signal)
  const lease=await cancellable(response.json(),signal) as CloudLease & {error?:{message?:string}}
  guard();checkAbort(signal)
  if (!response.ok) throw new Error(lease.error?.message || '网站模型授权暂不可用')
  if (typeof lease.token!=='string' || lease.token.length<16 || lease.token.length>512 || !Number.isFinite(lease.expires_at) || lease.expires_at<=Date.now()/1000 || lease.expires_at>Date.now()/1000+3605 || lease.origin!==location.origin) throw new Error('网站模型授权无效，未发送到助手')
  const next:CloudLease={token:lease.token,expires_at:lease.expires_at,origin:lease.origin}
  const configured=await fetchSession(session,'/v1/cloud/configure',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(next)})
  if(configured.status===401)invalidate(session,'本地助手配对已失效，请重新连接')
  const result=await cancellable(configured.json(),signal)
  guard();checkAbort(signal)
  if (!configured.ok || result.configured!==true || result.origin!==next.origin || result.expires_at!==next.expires_at) throw new Error(result.error?.message || '助手未能配置网站模型服务')
  return next
}
export async function ensureCloudRelay(force=false,signal?:AbortSignal):Promise<void> {
  expireCurrent();checkAbort(signal)
  if (!state.active || !state.token) throw new Error('请先连接本地媒体助手')
  const session=currentSession()
  if (!force && cloudLease?.session.owner===session.owner && cloudLease.session.token===session.token && state.relay && cloudLease.lease.expires_at>Date.now()/1000+90) return
  if (renewal?.session.owner===session.owner && renewal.session.token===session.token) return cancellable(renewal.promise,signal)
  const record={session,promise:Promise.resolve()}
  record.promise=(async()=>{
    const lease=await obtainCloudLease(session,signal,()=>assertSession(session,signal))
    assertSession(session,signal);cloudLease={session,lease};update({relay:true,relayExpires:lease.expires_at,error:''})
  })().catch(error=>{
    if (sameSession(session) && (error as Error).name!=='AbortError') { cloudLease=null;update({relay:false,relayExpires:0,ready:false,error:(error as Error).message}) }
    throw error
  }).finally(()=>{if(renewal===record)renewal=null})
  renewal=record
  return record.promise
}
export async function routeFetch(path:string,init:RequestInit = {}) {
  if (browserLocal()) return browserRequest(path,init)
  if (!managed(path)) return fetch(path,init)
  expireCurrent();const owner=ownerVersion
  if (state.active) {
    const session=currentSession()
    try {
      if (managedModelWrite(path,(init.method || 'GET').toUpperCase())) await ensureCloudRelay(false,init.signal || undefined)
      if (!sameSession(session) || owner!==ownerVersion) return sourceChangedResponse()
      const response=await requestSession(session,'/v1/local'+path,init)
      if (!sameSession(session) || owner!==ownerVersion) return sourceChangedResponse()
      return response
    } catch(error) {
      if (owner!==ownerVersion || !sameSession(session)) return sourceChangedResponse()
      throw error
    }
  }
  if (companionRequired) return localRequiredResponse()
  const response=await fetch(path,init)
  return owner===ownerVersion && !state.active && !companionRequired ? response : sourceChangedResponse()
}
export async function connectCompanion(signal?:AbortSignal) {
  checkAbort(signal)
  connecting?.abort()
  const controller=new AbortController();connecting=controller
  const attempt=++connectAttempt
  const abort=()=>controller.abort()
  signal?.addEventListener('abort',abort,{once:true})
  const activeSignal=controller.signal
  const guard=()=>{checkAbort(activeSignal);if(attempt!==connectAttempt)throw abortError()}
  update({state:'正在检查助手',error:''})
  try {
    const health=await cancellable(fetch(LOCAL_URL+'/v1/health',{cache:'no-store',signal:activeSignal}),activeSignal)
    const h=await cancellable(health.json(),activeSignal);guard()
    if (!health.ok || h.protocol!==1 || h.application!=='YnoteCompanion') throw new Error('协议不兼容，请安装匹配版本')
    if (!Array.isArray(h.capabilities) || !h.capabilities.includes('cloud_model_relay')) throw new Error('当前助手版本不支持网站模型服务，请更新 Ynote 媒体助手后重新连接。')
    const nonce=crypto.randomUUID()+crypto.randomUUID()
    const unpaired:Session={token:'',expires:0,owner:ownerVersion}
    const started=await fetchSession(unpaired,'/v1/pair/start',{method:'POST',signal:activeSignal,headers:{'Content-Type':'application/json'},body:JSON.stringify({client_nonce:nonce})})
    const data=await cancellable(started.json(),activeSignal);guard()
    if (!started.ok) throw new Error(data.error?.message || '配对失败')
    update({state:'请在电脑上的助手窗口允许配对'})
    const end=Date.now()+120000
    while(Date.now()<end) {
      guard()
      await new Promise<void>((resolve,reject)=>{
        const cancel=()=>{clearTimeout(timer);activeSignal.removeEventListener('abort',cancel);reject(abortError())}
        const timer=setTimeout(()=>{activeSignal.removeEventListener('abort',cancel);resolve()},1000)
        activeSignal.addEventListener('abort',cancel,{once:true})
      });guard()
      const response=await fetchSession(unpaired,'/v1/pair/claim',{method:'POST',signal:activeSignal,headers:{'Content-Type':'application/json'},body:JSON.stringify({pairing_id:data.pairing_id,client_nonce:nonce})})
      if(response.status===202)continue
      const claimed=await cancellable(response.json(),activeSignal);guard()
      if(!response.ok)throw new Error(claimed.error?.message || '配对失败')
      if(typeof claimed.token!=='string' || claimed.token.length<16 || claimed.token.length>512 || !Number.isFinite(claimed.expires_at) || claimed.expires_at<=Date.now()/1000)throw new Error('助手未返回有效配对凭据')
      const candidate:Session={token:claimed.token,expires:claimed.expires_at,owner:ownerVersion+1}
      update({state:'已配对，正在准备安全预览'})
      await prepareMediaWorker(activeSignal);guard()
      update({state:'已配对，正在连接网站模型服务'})
      const lease=await obtainCloudLease(candidate,activeSignal,guard);guard()
      ownerVersion++;candidate.owner=ownerVersion;renewal=null;cloudLease={session:candidate,lease}
      update({active:true,token:candidate.token,expires:candidate.expires,relay:true,relayExpires:lease.expires_at,ready:h.tools_state==='ready',state:h.tools_state==='ready'?'本地媒体助手与网站模型服务已连接':'本地助手已连接 · 请准备媒体组件',error:''})
      ownershipChanged();return
    }
    throw new Error('配对超时，请重试')
  } catch(error) {
    if(attempt===connectAttempt)update({state:state.active?'已保留原助手连接':'未连接或浏览器权限受限',error:(error as Error).name==='AbortError'?'':(error as Error).message})
    throw error
  } finally {
    signal?.removeEventListener('abort',abort)
    if(connecting===controller)connecting=null
  }
}
export async function disconnectCompanion() {
  connecting?.abort();connecting=null;connectAttempt++
  const session=currentSession();const changed=state.active
  cloudLease=null;renewal=null
  if(changed)ownerVersion++
  update({active:false,token:'',expires:0,ready:false,relay:false,relayExpires:0,state:'已断开',error:''})
  if(changed)ownershipChanged()
  if(session.token)await fetchSession(session,'/v1/session/revoke',{method:'POST'}).catch(()=>null)
}
export function localMediaUrl(path:string) {
  if(browserLocal())return browserAssetUrl(path)
  if(!localActive() || !path.startsWith('/api/'))return path
  return import.meta.env.BASE_URL+'__ynote_local__'+path
}
async function prepareMediaWorker(signal?:AbortSignal) {
  checkAbort(signal)
  if(!('serviceWorker' in navigator))throw new Error('当前浏览器不支持安全流式预览，请换用支持 Service Worker 的浏览器')
  await cancellable(navigator.serviceWorker.register(import.meta.env.BASE_URL+'local-media-worker.js',{scope:import.meta.env.BASE_URL}),signal)
  await cancellable(navigator.serviceWorker.ready,signal);checkAbort(signal)
  if(!navigator.serviceWorker.controller)await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',changed);signal?.removeEventListener('abort',cancel)}
    const changed=()=>{cleanup();resolve()}
    const cancel=()=>{cleanup();reject(abortError())}
    const timer=setTimeout(()=>{cleanup();reject(new Error('安全预览尚未接管页面，请刷新后重新配对'))},6000)
    navigator.serviceWorker.addEventListener('controllerchange',changed)
    signal?.addEventListener('abort',cancel,{once:true})
  })
}
if(typeof navigator!=='undefined' && 'serviceWorker' in navigator)navigator.serviceWorker.addEventListener('message',event=>{
  if(event.data?.type==='ynote-local-auth' && event.ports[0])event.ports[0].postMessage(localActive()?{token:state.token}:{})
})
