/**
 * Mock SSE 事件总线（site-spec §5.4）：
 * - 每个任务的事件带单调递增 seq（SSE id 字段同值）
 * - 订阅时按 Last-Event-ID（lastSeq）先重放 seq 更大的历史事件，再接续实时推送
 */
import type { JobEvent } from '../api/types'

interface Listener {
  onEvent: (event: JobEvent) => void
  lastSeq: number
}

/** jobId -> 事件日志（仅内存，用于断线重放） */
const eventLogs = new Map<string, JobEvent[]>()
/** jobId -> 监听者 */
const listeners = new Map<string, Set<Listener>>()
/** 全局 seq 源 */
const seqCounters = new Map<string, number>()

export function emitJobEvent(
  jobId: string,
  partial: Omit<JobEvent, 'seq' | 'job_id' | 'ts'>,
): JobEvent {
  const seq = (seqCounters.get(jobId) ?? 0) + 1
  seqCounters.set(jobId, seq)
  const event: JobEvent = {
    ...partial,
    seq,
    job_id: jobId,
    ts: new Date().toISOString(),
  }
  let log = eventLogs.get(jobId)
  if (!log) {
    log = []
    eventLogs.set(jobId, log)
  }
  log.push(event)
  for (const listener of listeners.get(jobId) ?? []) {
    if (event.seq <= listener.lastSeq) continue
    listener.lastSeq = event.seq
    listener.onEvent(event)
  }
  return event
}

export interface MockSubscription {
  unsubscribe: () => void
  get lastSeq(): number
}

export function mockSubscribeJob(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  lastEventId = 0,
): MockSubscription {
  let closed = false
  const listener: Listener = { onEvent, lastSeq: lastEventId }
  let set = listeners.get(jobId)
  if (!set) {
    set = new Set()
    listeners.set(jobId, set)
  }
  set.add(listener)
  // 按 Last-Event-ID 补齐：先重放 seq 更大的历史事件（微任务异步，模拟重连）
  const log = eventLogs.get(jobId) ?? []
  const missed = log.filter((e) => e.seq > lastEventId)
  if (missed.length > 0) {
    queueMicrotask(() => {
      for (const e of missed) {
        if (closed || e.seq <= listener.lastSeq) continue
        listener.lastSeq = e.seq
        listener.onEvent(e)
      }
    })
  }
  return {
    unsubscribe: () => {
      closed = true
      set?.delete(listener)
    },
    get lastSeq() {
      return listener.lastSeq
    },
  }
}

/** 任务终结后清理日志与计数（db 持久化不包含这些） */
export function clearJobEvents(jobId: string): void {
  eventLogs.delete(jobId)
  seqCounters.delete(jobId)
  listeners.delete(jobId)
}
