import models from './models.json'
import { wasmSimdSupported } from './capabilities'
import { modelReady, updateModel } from './modelState'
import { downloadResource } from './resourceDownload'
export { models }
export const MODEL_CACHE = 'ynote-models-v1'
export const RUNTIME_CACHE = 'ynote-runtime-ort-1.22-v1'
export type ModelKind = 'asr' | 'text'
export type Progress = { stage: string; processed_ms?: number; duration_ms?: number }
let activeWorker: Worker | null = null
let rejectActive: ((e: Error) => void) | null = null
export const isComputing = () => activeWorker !== null
export function stopInference() {
  if (rejectActive) rejectActive(new Error('任务已取消；旧结果已丢弃'))
  else { activeWorker?.terminate(); activeWorker = null }
  rejectActive = null
}
export function modelUrl(model: typeof models[number], file: string) {
  return `${location.origin}/models/${model.id}/resolve/${model.revision}/${file}`
}
export async function modelCached(kind: ModelKind) {
  const cache = await caches.open(MODEL_CACHE)
  const m = models.find(m => m.kind === kind)!
  for (const f of m.files) {
    const r = await cache.match(modelUrl(m, f.name))
    if (!r || r.headers.get('x-ynote-bytes') !== String(f.bytes)) return false
  }
  return true
}
export async function downloadModel(kind: ModelKind, signal: AbortSignal, progress: (text: string) => void) {
  if (!isSecureContext || !('caches' in globalThis)) throw new Error('模型缓存需要 HTTPS 安全上下文和浏览器存储权限')
  const model = models.find(m => m.kind === kind)!
  const space = await navigator.storage.estimate()
  if (space.quota && space.quota - (space.usage ?? 0) < model.bytes * 1.3) throw new Error('浏览器存储空间不足，请清理缓存后重试')
  const cache = await caches.open(MODEL_CACHE)
  let completed = 0
  for (const f of model.files) {
    signal.throwIfAborted()
    const url = modelUrl(model, f.name)
    const existing = await cache.match(url)
    if (existing?.headers.get('x-ynote-bytes') === String(f.bytes)) { completed += f.bytes; continue }
    await downloadResource({...f,url,cache:MODEL_CACHE},signal,received=>progress(`下载 ${model.id}：${((completed+received)/model.bytes*100).toFixed(1)}%`))
    completed += f.bytes
  }
  progress('模型已缓存；可开始本地处理')
}
export async function infer<T>(kind: ModelKind, payload: object, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<T> {
  if (!modelReady(kind)) throw new Error(`${kind==='asr'?'转写':'笔记'}模型尚未校验并初始化，请先“下载并启用本地模型”；不会改用云端`)
  return execute<T>(kind,payload,onProgress,signal)
}
export async function initializeModel(kind: ModelKind, onProgress: (p: Progress)=>void, signal: AbortSignal) {
  return execute<{initialized:boolean;revision:string}>(kind,{operation:'initialize'},onProgress,signal)
}
async function execute<T>(kind: ModelKind, payload: object, onProgress: (p: Progress) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!wasmSimdSupported()) throw new Error('此浏览器不支持候选模型需要的 WASM SIMD；未启用未经验证的 CPU 或远程回退')
  if (typeof window !== 'undefined' && (!isSecureContext || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined')) throw new Error('本地模型需要 HTTPS、Worker 和 WebAssembly 支持；此设备不会切换到服务器处理')
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (kind === 'text' && memory !== undefined && memory < 4) throw new Error('浏览器报告可用设备内存低于 4 GiB，已停止加载文本模型，请在资源更充足的设备上重试')
  if (activeWorker) throw new Error('同一时间只允许运行一个本地模型，请等待或取消当前任务')
  if (!await modelCached(kind)) { updateModel(kind,{phase:'missing',message:'模型缓存不完整，请重新准备'});throw new Error('模型未完整缓存，请先到“设置 → 浏览器本地计算”确认下载') }
  signal?.throwIfAborted()
  // Recheck after asynchronous cache access to reject double clicks.
  if (activeWorker) throw new Error('已有任务正在运行')
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' })
    const id = crypto.randomUUID()
    const finish = () => { signal?.removeEventListener('abort', onAbort); worker.terminate(); if (activeWorker === worker) { activeWorker = null; rejectActive = null } }
    const onAbort = () => { finish(); reject(new Error('任务已取消；旧结果已丢弃')) }
    activeWorker = worker; rejectActive = e => { finish(); reject(e) }
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = ({ data }) => {
      if (data.id !== id || activeWorker !== worker) return
      if (data.type === 'progress') onProgress(data.payload)
      if (data.type === 'result') { finish(); resolve(data.payload as T) }
      if (data.type === 'error') { finish(); reject(new Error(data.payload)) }
    }
    worker.onerror = () => { finish(); reject(new Error('本地 Worker 退出，可能内存不足或运行时不兼容；未使用远程服务')) }
    const data = { id, kind, ...payload }
    const audio = (payload as { audio?: Float32Array }).audio
    worker.postMessage(data, audio ? [audio.buffer as ArrayBuffer] : [])
  })
}
