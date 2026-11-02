/** 任务相关接口（site-spec §5.3 ③④⑤⑥⑦）—— 含 SSE 订阅与 seq 补齐 */
import { request } from './client'
import { USE_MOCK } from './errors'
import { inspectQuotaJob, isHostedPreview } from './quotaSignals'
import { billingContext } from '../stores/quotaStore'
import { localActive, companionRequest } from './companion'
import type { JobEvent, JobResponse, OperationKind } from './types'
import { mockSubscribeJob } from '../mock/sse'

// ③ POST /api/materials/{id}/jobs（见 materials.ts，避免重复导出）

// ④ GET /api/jobs/{id}
export function getJob(jobId: string): Promise<JobResponse> {
  return request<JobResponse>('GET', `/api/jobs/${jobId}`)
}

// ⑤ GET /api/jobs/{id}/events（SSE）
export interface JobEventSubscription {
  unsubscribe: () => void
  /** 最近一次收到的事件 seq（= SSE Last-Event-ID），断线重连时回传补齐 */
  lastSeq: number
}

export function subscribeJobEvents(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  lastEventId = 0,
): JobEventSubscription {
  if (isHostedPreview()) return { unsubscribe: () => {}, lastSeq: lastEventId }
  if (USE_MOCK) {
    return mockSubscribeJob(jobId, onEvent, lastEventId)
  }
  if (localActive()) {
    let closed=false,lastSeq=lastEventId,timer:ReturnType<typeof setTimeout>|undefined
    const abort=new AbortController()
    const unsubscribe=()=>{closed=true;clearTimeout(timer);abort.abort()}
    const read=async()=>{
      try {
        const r=await companionRequest(`/v1/local/api/jobs/${encodeURIComponent(jobId)}/events?last_event_id=${lastSeq}`,{signal:abort.signal})
        if (!r.ok || !r.body) throw new Error('本机任务事件流断开')
        const reader=r.body.getReader(),decoder=new TextDecoder();let buffer=''
        while(!closed){
          const chunk=await reader.read();if(chunk.done)break
          buffer+=decoder.decode(chunk.value,{stream:true})
          let end:number
          while((end=buffer.indexOf('\n\n'))>=0){
            const block=buffer.slice(0,end);buffer=buffer.slice(end+2)
            const line=block.split('\n').find(s=>s.startsWith('data: '));if(!line)continue
            const event=JSON.parse(line.slice(6)) as JobEvent
            if(event.job_id!==jobId || event.seq<=lastSeq)continue
            lastSeq=event.seq;inspectQuotaJob(event);onEvent(event)
            if(event.type==='job_done'){unsubscribe();break}
          }
        }
      }catch{ /* Read-only reconnection never retries a model call. */ }
      if(!closed && localActive())timer=setTimeout(()=>void read(),1500)
    }
    void read();return {unsubscribe,get lastSeq(){return lastSeq}}
  }
  let es: EventSource | null = null
  let lastSeq = lastEventId
  let closed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = () => {
    closed = true
    clearTimeout(timer)
    es?.close()
    es = null
  }
  const connect = () => {
    if (closed) return
    // Reconstructed EventSource instances do not inherit Last-Event-ID headers.
    es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events?last_event_id=${lastSeq}`)
    es.onopen = () => { attempts = 0 }
    es.addEventListener('job_event', (event) => {
      let data: JobEvent
      try { data = JSON.parse((event as MessageEvent).data) as JobEvent }
      catch { return }
      if (closed || data.job_id !== jobId || !Number.isFinite(data.seq) || data.seq <= lastSeq) return
      inspectQuotaJob(data)
      lastSeq = data.seq
      onEvent(data)
      if (data.type === 'job_done') unsubscribe()
    })
    es.onerror = () => {
      es?.close()
      es = null
      if (closed) return
      // Retry with a bounded backoff and the last acknowledged sequence.
      timer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000))
    }
  }
  connect()
  return { unsubscribe, get lastSeq() { return lastSeq } }
}

// ⑥ POST /api/jobs/{id}/cancel
export function cancelJob(jobId: string): Promise<JobResponse> {
  return request<JobResponse>('POST', `/api/jobs/${jobId}/cancel`)
}

// ⑦ POST /api/jobs/{id}/retry —— 只重跑失败操作，复用有效缓存
export async function retryJob(jobId: string, operations?: OperationKind[]): Promise<JobResponse> {
  const body = operations && operations.length > 0 ? { operations } : {}
  return request<JobResponse>('POST', `/api/jobs/${jobId}/retry`, { ...body, ...billingContext() })
}

export type { JobEvent }
