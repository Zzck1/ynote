/**
 * 工作台全局状态（site-spec §6 Zustand）。
 * jobs 为高频 SSE 更新数据，仅放内存不 persist；
 * 资料/笔记/问答从后端恢复，仅界面偏好保存在浏览器。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { listMaterials, getMaterialDetail } from '../api/materials'
import { USE_MOCK } from '../api/errors'
import type {
  Conversation,
  Job,
  JobEvent,
  Material,
  MaterialCapabilities,
  NoteVersion,
  VariantPolicy,
} from '../api/types'

export type TabKey = 'transcript' | 'note' | 'mindmap' | 'assets'
export type NarrowTabKey = 'library' | 'workspace' | 'reference'

/**
 * 稳定的空数组引用：选择器返回它而非内联 `[]`，避免 useSyncExternalStore
 * 因「每次新引用」判定为变化而触发无限重渲染（React error #185）。
 * 当 jobsByMaterial[id] 为空时统一返回此引用。
 */
export const EMPTY_JOBS: Job[] = []

const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'partial', 'needs_action']

/** 将 SSE 事件应用到 Job 上，返回新 Job（纯函数） */
function applyEventToJob(job: Job, event: JobEvent): Job {
  const next: Job = { ...job, operations: job.operations.map((o) => ({ ...o })) }
  if (event.type === 'job_state' && event.state) {
    next.state = event.state
    if (event.state === 'queued' || event.state === 'running') {
      next.stage = event.state
    } else if (TERMINAL_STATES.includes(event.state)) {
      next.stage = 'done'
    }
  } else if (event.type === 'job_done' && event.state) {
    next.state = event.state
    next.stage = 'done'
  } else if (event.type === 'op_state' && event.op && event.state) {
    const op = next.operations.find((o) => o.kind === event.op)
    if (op) {
      op.state = event.state
      if (TERMINAL_STATES.includes(event.state)) {
        op.stage = 'done'
      }
    }
  } else if (event.type === 'op_progress' && event.op && event.progress !== undefined) {
    const op = next.operations.find((o) => o.kind === event.op)
    if (op) op.progress = event.progress
    recomputeProgress(next)
  } else if (event.type === 'op_stage' && event.op && event.stage) {
    const op = next.operations.find((o) => o.kind === event.op)
    if (op) op.stage = event.stage
  } else if (event.type === 'op_error' && event.op && event.error) {
    const op = next.operations.find((o) => o.kind === event.op)
    if (op) op.error_code = event.error.code
    if (event.error.code) next.error_code = event.error.code
  }
  return next
}

function recomputeProgress(job: Job): void {
  const total = job.operations.reduce((s, o) => s + o.progress, 0)
  job.progress = job.operations.length > 0 ? total / job.operations.length : 0
}

let hydration: Promise<void> | null = null
const detailRequests = new Map<string, Promise<void>>()

interface WorkspaceState {
  loading: boolean
  loadError: string | null
  hydrate: () => Promise<void>
  refreshMaterial: (id: string) => Promise<void>
  // ===== 持久化字段 =====
  currentMaterialId: string | null
  variantPolicy: VariantPolicy
  generateNote: boolean
  rightPanelOpen: boolean
  materials: Material[]
  capabilitiesByMaterial: Record<string, MaterialCapabilities>
  notesByMaterial: Record<string, NoteVersion>
  conversationsByMaterial: Record<string, Conversation>

  // ===== 内存字段（不持久化） =====
  jobsByMaterial: Record<string, Job[]>
  activeTab: TabKey
  activeNarrowTab: NarrowTabKey
  /** ChatPanel 引用 chip 点击后高亮的 segment id（ReferencePanel 读取并滚动） */
  highlightSegmentId: string | null

  // ===== Actions =====
  setCurrentMaterial: (id: string | null) => void
  addMaterial: (material: Material, capabilities: MaterialCapabilities) => void
  upsertJob: (job: Job) => void
  applyJobEvent: (event: JobEvent) => void
  setRightPanel: (open: boolean) => void
  setVariantPolicy: (policy: VariantPolicy) => void
  setGenerateNote: (val: boolean) => void
  setActiveTab: (tab: TabKey) => void
  setActiveNarrowTab: (tab: NarrowTabKey) => void
  setHighlightSegmentId: (id: string | null) => void
  putNote: (note: NoteVersion) => void
  putConversation: (conversation: Conversation) => void
  removeMaterial: (id: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      loading: true,
      loadError: null,
      hydrate: () => {
        if (hydration) return hydration
        set({ loading: true, loadError: null })
        hydration = (async () => {
          try {
            const { materials } = await listMaterials()
            const ids = new Set(materials.map((m) => m.id))
            set((s) => ({
              materials,
              currentMaterialId: s.currentMaterialId && ids.has(s.currentMaterialId) ? s.currentMaterialId : null,
              capabilitiesByMaterial: {}, notesByMaterial: {}, conversationsByMaterial: {}, jobsByMaterial: {},
            }))
            await Promise.all(materials.map((m) => get().refreshMaterial(m.id)))
          } catch (error) {
            set({ loadError: error instanceof Error ? error.message : '无法连接本机后端，请确认服务已启动。' })
          } finally {
            set({ loading: false })
            hydration = null
          }
        })()
        return hydration
      },
      refreshMaterial: (id) => {
        const pending = detailRequests.get(id)
        if (pending) return pending
        const task = (async () => {
          try {
            const detail = await getMaterialDetail(id)
            // A late request must not resurrect a deleted material or change selection.
            if (!get().materials.some((m) => m.id === id)) return
            set((s) => {
              const notes = { ...s.notesByMaterial }
              const conversations = { ...s.conversationsByMaterial }
              if (detail.note) notes[id] = detail.note
              else delete notes[id]
              if (detail.conversation) conversations[id] = detail.conversation
              else delete conversations[id]
              return {
                materials: s.materials.map((m) => m.id === id ? detail.material : m),
                capabilitiesByMaterial: { ...s.capabilitiesByMaterial, [id]: detail.capabilities },
                jobsByMaterial: { ...s.jobsByMaterial, [id]: USE_MOCK ? (s.jobsByMaterial[id] ?? []) : detail.jobs },
                notesByMaterial: notes, conversationsByMaterial: conversations,
              }
            })
          } catch (error) {
            set({ loadError: error instanceof Error ? error.message : '资料读取失败' })
          } finally { detailRequests.delete(id) }
        })()
        detailRequests.set(id, task)
        return task
      },
      currentMaterialId: null,
      variantPolicy: 'original',
      generateNote: false,
      rightPanelOpen: true,
      materials: [],
      capabilitiesByMaterial: {},
      notesByMaterial: {},
      conversationsByMaterial: {},

      jobsByMaterial: {},
      activeTab: 'transcript',
      activeNarrowTab: 'workspace',
      highlightSegmentId: null,

      setCurrentMaterial: (id) => {
        set({ currentMaterialId: id, highlightSegmentId: null })
        if (id) void get().refreshMaterial(id)
      },

      addMaterial: (material, capabilities) =>
        set((s) => {
          const exists = s.materials.some((m) => m.id === material.id)
          return {
            materials: exists ? s.materials.map((m) => m.id === material.id ? material : m) : [...s.materials, material],
            capabilitiesByMaterial: {
              ...s.capabilitiesByMaterial,
              [material.id]: capabilities,
            },
            currentMaterialId: material.id,
          }
        }),

      upsertJob: (job) =>
        set((s) => {
          const list = s.jobsByMaterial[job.material_id] ?? []
          const idx = list.findIndex((j) => j.id === job.id)
          const updated = idx >= 0 ? list.map((j) => (j.id === job.id ? job : j)) : [...list, job]
          return {
            jobsByMaterial: { ...s.jobsByMaterial, [job.material_id]: updated },
          }
        }),

      applyJobEvent: (event) => {
        const state = get()
        // 通过 jobId 查找所属 material
        let targetJob: Job | undefined
        let targetMaterialId: string | undefined
        for (const [matId, jobs] of Object.entries(state.jobsByMaterial)) {
          const found = jobs.find((j) => j.id === event.job_id)
          if (found) {
            targetJob = found
            targetMaterialId = matId
            break
          }
        }
        if (!targetJob || !targetMaterialId) return
        const updated = applyEventToJob(targetJob, event)
        const list = state.jobsByMaterial[targetMaterialId]
        const updatedList = list.map((j) => (j.id === updated.id ? updated : j))
        set({
          jobsByMaterial: { ...state.jobsByMaterial, [targetMaterialId]: updatedList },
        })
      },

      setRightPanel: (open) => set({ rightPanelOpen: open }),
      setVariantPolicy: (policy) => set({ variantPolicy: policy }),
      setGenerateNote: (val) => set({ generateNote: val }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setActiveNarrowTab: (tab) => set({ activeNarrowTab: tab }),
      setHighlightSegmentId: (id) => set({ highlightSegmentId: id }),

      putNote: (note) =>
        set((s) => ({
          notesByMaterial: { ...s.notesByMaterial, [note.material_id]: note },
        })),

      putConversation: (conversation) =>
        set((s) => ({
          conversationsByMaterial: {
            ...s.conversationsByMaterial,
            [conversation.material_id]: conversation,
          },
        })),

      removeMaterial: (id) =>
        set((s) => {
          const { [id]: _caps, ...restCaps } = s.capabilitiesByMaterial
          const { [id]: _notes, ...restNotes } = s.notesByMaterial
          const { [id]: _convs, ...restConvs } = s.conversationsByMaterial
          const { [id]: _jobs, ...restJobs } = s.jobsByMaterial
          return {
            materials: s.materials.filter((m) => m.id !== id),
            capabilitiesByMaterial: restCaps,
            notesByMaterial: restNotes,
            conversationsByMaterial: restConvs,
            jobsByMaterial: restJobs,
            currentMaterialId: s.currentMaterialId === id ? null : s.currentMaterialId,
          }
        }),
    }),
    {
      name: USE_MOCK ? 'enote.workspace.demo.v2' : 'enote.workspace.local.v2',
      partialize: (s) => ({
        currentMaterialId: s.currentMaterialId,
        variantPolicy: s.variantPolicy,
        generateNote: s.generateNote,
        rightPanelOpen: s.rightPanelOpen,
      }),
    },
  ),
)
