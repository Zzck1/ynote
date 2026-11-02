import { useEffect, useRef } from 'react'
import { getJob, subscribeJobEvents, type JobEventSubscription } from '../api/jobs'
import type { JobEvent } from '../api/types'
import { useWorkspaceStore } from '../stores/workspaceStore'

export function startJobStream(jobId: string, onEvent: (event: JobEvent) => void, lastEventId = 0): JobEventSubscription {
  return subscribeJobEvents(jobId, onEvent, lastEventId)
}

/** Own each subscription for exactly its mounted lifetime, including StrictMode remounts. */
export function useWorkspaceJobStreams(activeJobIds: string): void {
  const streams = useRef(new Map<string, JobEventSubscription>())
  const sequences = useRef(new Map<string, number>())
  useEffect(() => {
    const ids = new Set(activeJobIds.split(',').filter(Boolean))
    for (const [id, stream] of streams.current) {
      if (!ids.has(id)) {
        sequences.current.set(id, stream.lastSeq)
        stream.unsubscribe()
        streams.current.delete(id)
        // Operations can become terminal just before job_done. Reconcile persisted assets/notes.
        void getJob(id).then(({ job }) => {
          const state = useWorkspaceStore.getState()
          if (!state.materials.some((material) => material.id === job.material_id)) return
          state.upsertJob(job)
          void state.refreshMaterial(job.material_id)
        }).catch(() => { /* Offline state is reported by material refresh. */ })
      }
    }
    for (const id of ids) {
      if (streams.current.has(id)) continue
      const stream = startJobStream(id, (event) => {
        sequences.current.set(id, event.seq)
        const state = useWorkspaceStore.getState()
        state.applyJobEvent(event)
        if (event.type === 'job_done') {
          const material = Object.entries(state.jobsByMaterial).find(([, jobs]) => jobs.some((job) => job.id === id))?.[0]
          if (material) void state.refreshMaterial(material)
        }
      }, sequences.current.get(id) ?? 0)
      streams.current.set(id, stream)
    }
  }, [activeJobIds])
  useEffect(() => () => {
    for (const [id, stream] of streams.current) {
      sequences.current.set(id, stream.lastSeq)
      stream.unsubscribe()
    }
    streams.current.clear()
  }, [])
}
