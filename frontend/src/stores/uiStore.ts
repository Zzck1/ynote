/** 全局 UI 状态：Toast 队列（design-spec §5.9：右下角、4s 自动消失、多条堆叠） */
import { create } from 'zustand'

export type ToastKind = 'success' | 'danger' | 'warning' | 'info'

export interface ToastItem {
  id: string
  kind: ToastKind
  text: string
}

interface UiState {
  toasts: ToastItem[]
  pushToast: (kind: ToastKind, text: string) => void
  dismissToast: (id: string) => void
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleDismiss(get: () => UiState, id: string): void {
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  timers.set(
    id,
    setTimeout(() => {
      get().dismissToast(id)
      timers.delete(id)
    }, 4000),
  )
}

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  pushToast: (kind, text) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    scheduleDismiss(get, id)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** hover 暂停 / 移出恢复计时（design-spec §5.9） */
export function pauseToast(id: string): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
}

export function resumeToast(id: string): void {
  scheduleDismiss(useUiStore.getState, id)
}
