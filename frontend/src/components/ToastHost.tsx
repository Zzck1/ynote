import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useUiStore, pauseToast, resumeToast, type ToastKind } from '../stores/uiStore'

const ICONS: Record<ToastKind, LucideIcon> = {
  success: CheckCircle2,
  danger: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const ICON_COLORS: Record<ToastKind, string> = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  info: 'text-info',
}

/** 全局 Toast 容器（design-spec §5.9：右下角堆叠） */
export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[300] flex flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex min-w-[280px] max-w-[360px] items-start gap-3 rounded-lg border border-line bg-page px-4 py-3 text-sm shadow-[var(--shadow-modal)]"
            onMouseEnter={() => pauseToast(t.id)}
            onMouseLeave={() => resumeToast(t.id)}
          >
            <Icon
              size={16}
              strokeWidth={1.5}
              className={`mt-0.5 shrink-0 ${ICON_COLORS[t.kind]}`}
              aria-hidden="true"
            />
            <span className="flex-1 leading-relaxed text-ink">{t.text}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="-mr-1 -mt-1 shrink-0 cursor-pointer rounded p-0.5 text-ink-3 transition-colors duration-150 hover:text-ink"
              aria-label="关闭提示"
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
