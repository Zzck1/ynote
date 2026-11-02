import { request } from './client'
import { browserLocal } from '../browser/mode'
import { billingContext } from '../stores/quotaStore'
import { getTaskSourceVersion } from './companion'
import { ApiRequestError } from './errors'
import type { ExtractionMode } from './types'

/** Task mode and billing context travel together to the paired media helper. */
export async function requestTask<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const actualMethod = body === undefined ? 'GET' : method
  const billable = actualMethod === 'POST' && (/\/(start|transcript)$/.test(path) || path === '/batch')
  const payload = billable && !browserLocal() ? { ...(body as object), ...billingContext(path.endsWith('/transcript') ? 'transcription' : undefined) } : body
  return request<T>(actualMethod, '/api/tasks' + path, payload)
}

export function isMissingTask(error: unknown) {
  return error instanceof ApiRequestError && (error.code === 'TASK_NOT_FOUND' || (error.status === 404 && error.message === '任务不存在'))
}

/** Validate IDs in their current owner before starting; never replay a paid call. */
export async function resolveTaskInCurrentSource<T extends {id:string}>(selectedId: string | null, input: {raw_input:string;source_id:string|null}, onDraft?: (task:T)=>void): Promise<string> {
  const owner=getTaskSourceVersion()
  const checkOwner=()=>{if(getTaskSourceVersion()!==owner)throw new ApiRequestError('TASK_SOURCE_CHANGED','任务来源已切换，请重新选择本机任务后提取。',true,409)}
  let id=selectedId
  if(id) {
    try { await requestTask(`/${id}`) }
    catch(error) { if(!isMissingTask(error))throw error;id=null }
    checkOwner()
  }
  if(!id) {
    const draft=await requestTask<T>('',{raw_input:input.raw_input,source_id:input.source_id})
    checkOwner();id=draft.id;onDraft?.(draft)
  }
  checkOwner()
  return id
}

export async function startTaskInCurrentSource<T extends {id:string}>(selectedId: string | null, input: {raw_input:string;source_id:string|null;extraction_mode:ExtractionMode}, onDraft?: (task:T)=>void): Promise<T> {
  const owner=getTaskSourceVersion()
  const id=await resolveTaskInCurrentSource<T>(selectedId,input,onDraft)
  if(getTaskSourceVersion()!==owner)throw new ApiRequestError('TASK_SOURCE_CHANGED','任务来源已切换，请重新选择本机任务后提取。',true,409)
  const started=await requestTask<T>(`/${id}/start`,input)
  if(getTaskSourceVersion()!==owner)throw new ApiRequestError('TASK_SOURCE_CHANGED','任务来源已切换，请重新选择本机任务后提取。',true,409)
  return started
}
