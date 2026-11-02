/** Only transport adapters call these after an actual server response. No timer or local usage simulation. */
type QuotaListener = (eventId: string) => void
const listeners = new Set<QuotaListener>()
const seenJobs = new Set<string>()
let responseSequence = 0
export function onQuotaExceeded(listener: QuotaListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function emit(id: string) { for (const listener of listeners) listener(id) }
export function inspectQuotaHttpError(status: number, code: unknown): void {
  if (status === 402 && code === 'QUOTA_EXCEEDED') emit(`http:${++responseSequence}`)
}
export function inspectQuotaJob(job: unknown): void {
  if (!job || typeof job !== 'object') return
  const value = job as { id?: string; job_id?: string; error_code?: string; error?: { code?: string }; operations?: { error_code?: string }[] }
  const id = value.id || value.job_id
  if (!id || (value.error_code !== 'QUOTA_EXCEEDED' && value.error?.code !== 'QUOTA_EXCEEDED' && !value.operations?.some(op => op.error_code === 'QUOTA_EXCEEDED'))) return
  if (seenJobs.has(id)) return
  seenJobs.add(id)
  if (seenJobs.size > 200) seenJobs.delete(seenJobs.values().next().value!)
  emit(`job:${id}`)
}
export function inspectQuotaPayload(data: unknown): void {
  if (!data || typeof data !== 'object') return
  const value = data as { job?: unknown; result_job?: unknown; jobs?: unknown[]; media_jobs?: unknown[] }
  inspectQuotaJob(value.job)
  inspectQuotaJob(value.result_job)
  if (Array.isArray(value.jobs)) value.jobs.forEach(inspectQuotaJob)
  if (Array.isArray(value.media_jobs)) value.media_jobs.forEach(inspectQuotaJob)
}
export function isHostedPreview(): boolean {
  return typeof window !== 'undefined' && (window as Window & { __YNOTE_PREVIEW__?: boolean }).__YNOTE_PREVIEW__ === true
}
