import models from './models.json'
import runtime from './runtime.json'
import { initializeModel, isComputing, MODEL_CACHE, RUNTIME_CACHE, modelUrl } from './engine'
import { modelSnapshot, updateModel, type ModelKind, modelName } from './modelState'
import { wasmSimdSupported } from './capabilities'
import { downloadResource as download, type Resource } from './resourceDownload'
export type { Resource } from './resourceDownload'

export type PreparationPlan={kinds:ModelKind[];resources:Resource[];missing:Resource[];additional:number;reserve:number;available:number|null;fingerprint:string;capability:string;blocked:string}
let pending:AbortController|null=null
const emit=()=>window.dispatchEvent(new Event('ynote:preparation-changed'))
export const preparationBusy=()=>pending!==null
export function cancelPreparation(){pending?.abort()}
function resourceList(kinds:ModelKind[]):Resource[]{
 const files:Resource[]=runtime.files.map(f=>({...f,url:location.origin+'/runtime/'+f.name,cache:RUNTIME_CACHE}))
 for(const kind of kinds){const m=models.find(m=>m.kind===kind)!;files.push(...m.files.map(f=>({...f,url:modelUrl(m,f.name),cache:MODEL_CACHE})))}
 return [...new Map(files.map(f=>[f.url,f])).values()]
}
async function hasFile(f:Resource){const r=await(await caches.open(f.cache)).match(f.url);return !!r && Number(r.headers.get('x-ynote-bytes')??r.headers.get('content-length'))===f.bytes}
export async function preparationPlan(kinds:ModelKind[]):Promise<PreparationPlan>{
 let blocked=''
 if(!isSecureContext||typeof Worker==='undefined'||!wasmSimdSupported()||!('caches'in window)||!navigator.storage?.estimate||!('serviceWorker'in navigator))blocked='当前浏览器缺少安全上下文、WASM SIMD、Worker、Cache API 或 Service Worker 支持，不能启用此本地模型路径'
 if(kinds.includes('asr')&&(typeof AudioContext==='undefined'||typeof OfflineAudioContext==='undefined'))blocked='当前浏览器不支持此音轨解码路径，不能配置音视频转写功能'
 const memory=(navigator as Navigator&{deviceMemory?:number}).deviceMemory
 if(kinds.includes('text')&&memory!==undefined&&memory<4)blocked='浏览器报告设备内存低于 4 GiB，笔记模型不支持在此设备准备；可单独尝试转写模型'
 const resources=resourceList(kinds),missing:Resource[]=[]
 let available:number|null=null
 if(!blocked){
  try{for(const f of resources)if(!await hasFile(f))missing.push(f)
   const s=await navigator.storage.estimate();available=s.quota?Math.max(0,s.quota-(s.usage??0)):null
  }catch{blocked='无法访问此网站的浏览器缓存或存储配额，请检查存储权限'}
 }
 const additional=missing.reduce((n,f)=>n+f.bytes,0),reserve=Math.ceil(additional*1.25+32*1048576)
 if(available!==null&&available<reserve)blocked='浏览器可用存储不足，当前准备操作已阻止；请清理不需要的数据后重试'
 return{kinds,resources,missing,additional,reserve,available,fingerprint:JSON.stringify(resources),blocked,capability:`安全上下文 ${isSecureContext?'有效':'无效'} · WASM SIMD ${wasmSimdSupported()?'支持':'不支持'} · ${navigator.hardwareConcurrency??'未知'} 逻辑核 · 当前使用 CPU/WASM；GPU 推理未验证`}
}
export async function inspectModelCaches(){
 for(const kind of ['asr','text']as const){
  const model=models.find(m=>m.kind===kind)!
  if(modelSnapshot()[kind].phase==='ready'&&modelSnapshot()[kind].fingerprint!==model.revision)updateModel(kind,{phase:'update',message:'模型固定版本已变化，需要重新配置'})
  if(['ready','downloading','verifying','loading'].includes(modelSnapshot()[kind].phase))continue
  try{const list=resourceList([kind]);const cached=await Promise.all(list.map(hasFile));if(['ready','downloading','verifying','loading','error','cancelled'].includes(modelSnapshot()[kind].phase))continue
   const entries=await(await caches.open(MODEL_CACHE)).keys()
   const oldVersion=entries.some(r=>r.url.startsWith(`${location.origin}/models/${model.id}/resolve/`)&&!r.url.includes('/resolve/'+model.revision+'/'))
   updateModel(kind,{phase:cached.every(Boolean)?'cached':oldVersion?'update':'missing',message:cached.every(Boolean)?'已有缓存，尚未校验并初始化':oldVersion?'缓存中存在旧版本，当前固定版本需要更新':'部分资源未缓存，需要下载并启用'})
  }catch(error){updateModel(kind,{phase:'error',message:error instanceof Error?error.message:'缓存读取失败'})}
 }
}
function verify(resources:Resource[],signal:AbortSignal,progress:(n:number,total:number)=>void){
 signal.throwIfAborted()
 return new Promise<void>((resolve,reject)=>{
  const worker=new Worker(new URL('./verify.worker.ts',import.meta.url),{type:'module'}),id=crypto.randomUUID()
  const done=()=>{signal.removeEventListener('abort',abort);worker.terminate()}
  const abort=()=>{done();reject(new Error('校验已取消'))}
  signal.addEventListener('abort',abort,{once:true})
  worker.onmessage=({data})=>{if(data.id!==id)return;if(data.type==='progress')progress(data.completed,data.total);if(data.type==='verified'){done();resolve()}if(data.type==='error'){done();reject(new Error(data.message))}}
  worker.onerror=()=>{done();reject(new Error('校验 Worker 失败，可能是存储或内存不足'))}
  worker.postMessage({id,items:resources})
 })
}
async function controlledPage(signal:AbortSignal){
 if(navigator.serviceWorker.controller)return
 await new Promise<void>((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',changed);signal.removeEventListener('abort',aborted)}
  const changed=()=>{if(navigator.serviceWorker.controller){cleanup();resolve()}}
  const aborted=()=>{cleanup();reject(new Error('准备已取消'))}
  const timer=setTimeout(()=>{cleanup();reject(new Error('页面静态缓存尚未就绪，请刷新后重试启用'))},10000)
  navigator.serviceWorker.addEventListener('controllerchange',changed);signal.addEventListener('abort',aborted,{once:true})
 })
}
export async function prepareModels(consented:PreparationPlan){
 if(pending||isComputing())throw new Error('已有本地任务运行，请等待或停止后再准备模型')
 const current=await preparationPlan(consented.kinds)
 if(current.blocked)throw new Error(current.blocked)
 if(current.fingerprint!==consented.fingerprint||current.additional>consented.additional)throw new Error('资源版本或新增下载总量已变化，请重新查看并确认')
 if(pending||isComputing())throw new Error('已有准备操作或本地任务运行')
 const controller=new AbortController();pending=controller;emit()
 let active:ModelKind|null=null
 try{
  for(const kind of current.kinds){
   controller.signal.throwIfAborted();active=kind
   const resources=resourceList([kind]),missing:Resource[]=[]
   for(const f of resources)if(!await hasFile(f))missing.push(f)
   const total=missing.reduce((n,f)=>n+f.bytes,0);let completed=0
   updateModel(kind,{phase:'downloading',message:total?'正在下载确认的资源':'复用已有缓存，无需重复下载',completed:0,total})
   for(const f of missing){await download(f,controller.signal,n=>updateModel(kind,{phase:'downloading',message:'正在下载确认的资源',completed:completed+n,total}));completed+=f.bytes}
   controller.signal.throwIfAborted()
   updateModel(kind,{phase:'verifying',message:'正在逐文件核对固定哈希'})
   await verify(resources,controller.signal,(completed,total)=>updateModel(kind,{phase:'verifying',message:'正在逐文件校验',completed,total}))
   controller.signal.throwIfAborted();await controlledPage(controller.signal)
   updateModel(kind,{phase:'loading',message:'正在本机创建模型推理会话，不代表质量已达标'})
   const initialized=await initializeModel(kind,p=>updateModel(kind,{phase:'loading',message:p.stage}),controller.signal)
   controller.signal.throwIfAborted()
   const model=models.find(m=>m.kind===kind)!
   if(!initialized.initialized||initialized.revision!==model.revision)throw new Error('模型未完成匹配版本的初始化')
   updateModel(kind,{phase:'ready',message:'就绪 · 已校验并初始化，使用时按需加载',fingerprint:model.revision})
  }
 }catch(error){if(active)updateModel(active,{phase:controller.signal.aborted?'cancelled':'error',message:controller.signal.aborted?'已取消，完整缓存保留，可重新启用':error instanceof Error?error.message:'模型准备失败'});throw error}
 finally{pending=null;emit()}
}
export async function clearModel(kind:ModelKind){
 if(pending||isComputing())throw new Error('请先停止模型准备和本地计算，再清理缓存')
 const cache=await caches.open(MODEL_CACHE),m=models.find(m=>m.kind===kind)!
 for(const key of await cache.keys())if(key.url.startsWith(`${location.origin}/models/${m.id}/resolve/`))await cache.delete(key)
 updateModel(kind,{phase:'missing',message:`${modelName(kind)}缓存已清除；任务记录和另一模型未删除`})
}
export async function cacheUsage(kind:ModelKind){const resources=resourceList([kind]).filter(f=>f.cache===MODEL_CACHE);let bytes=0;for(const f of resources)if(await hasFile(f))bytes+=f.bytes;return bytes}
export async function clearRuntime(){
 if(pending||isComputing())throw new Error('请先停止模型准备和本地计算')
 await caches.delete(RUNTIME_CACHE)
 for(const kind of ['asr','text']as const)updateModel(kind,{phase:'cached',message:'共享运行资源已清除，需要重新校验并启用；模型权重仍保留'})
}
export async function checkRequiredModels(kinds:ModelKind[]){
 for(const kind of kinds){
  const before=modelSnapshot()[kind]
  if(before.phase!=='ready'||before.fingerprint!==models.find(m=>m.kind===kind)!.revision)return false
  try{
   const resources=resourceList([kind]);for(const f of resources)if(!await hasFile(f)){updateModel(kind,{phase:'missing',message:'所需缓存已被清理，请重新配置'});return false}
   const controller=new AbortController()
   await verify(resources,controller.signal,()=>{})
  }catch(error){updateModel(kind,{phase:'error',message:error instanceof Error?error.message:'资源失效，请重新配置'});return false}
 }
 return true
}
