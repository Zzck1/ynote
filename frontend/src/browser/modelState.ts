import models from './models.json'
export type ModelKind = 'asr' | 'text'
export type ModelPhase = 'unchecked' | 'cached' | 'missing' | 'update' | 'downloading' | 'verifying' | 'loading' | 'ready' | 'cancelled' | 'error'
export type ModelState = { phase: ModelPhase; message: string; completed?: number; total?: number; fingerprint?: string }
let state: Record<ModelKind,ModelState> = {
  asr:{phase:'unchecked',message:'尚未校验并启用'}, text:{phase:'unchecked',message:'尚未校验并启用'},
}
const listeners=new Set<()=>void>()
export const modelSnapshot=()=>state
export const subscribeModels=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn)}}
export function updateModel(kind: ModelKind, next: ModelState) { state={...state,[kind]:next};listeners.forEach(fn=>fn()) }
export const modelName=(kind:ModelKind)=>kind==='asr'?'转写模型':'笔记模型'
export const modelReady=(kind:ModelKind)=>state[kind].phase==='ready' && state[kind].fingerprint===models.find(m=>m.kind===kind)!.revision
