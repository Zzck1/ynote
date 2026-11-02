import type { JobState } from '../api/types'

interface TaskBadgeProps {
  state: JobState
  /** 自定义文案（默认取 content-plan §4 标准文案） */
  label?: string
}

/** content-plan §4 任务状态文案表 */
const DEFAULT_LABELS: Record<JobState, string> = {
  queued: '等待中',
  running: '处理中',
  partial: '部分完成',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  needs_action: '需要操作',
}

/** design-spec §5.5：点色 + 文字双重编码 */
const STYLE: Record<
  JobState,
  { dot: string; text: string; bg: string; dotAnim?: string }
> = {
  queued: { dot: 'bg-ink-4', text: 'text-ink-2', bg: 'bg-subtle' },
  running: {
    dot: 'bg-info',
    text: 'text-ink',
    bg: 'bg-info-bg',
    dotAnim: 'dot-breath',
  },
  partial: { dot: 'bg-warning', text: 'text-warning', bg: 'bg-warning-bg' },
  succeeded: { dot: 'bg-success', text: 'text-success', bg: 'bg-success-bg' },
  failed: { dot: 'bg-danger', text: 'text-danger', bg: 'bg-danger-bg' },
  cancelled: { dot: 'bg-ink-4', text: 'text-ink-2', bg: 'bg-subtle' },
  needs_action: {
    dot: 'bg-warning',
    text: 'text-warning',
    bg: 'bg-warning-bg',
    dotAnim: 'dot-blink',
  },
}

/** 7 态胶囊徽标（design-spec §5.5） */
export function TaskBadge({ state, label }: TaskBadgeProps) {
  const s = STYLE[state]
  const text = label ?? DEFAULT_LABELS[state]
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded-full px-2 text-[12px] font-medium leading-none tracking-[0.02em] ${s.bg} ${s.text}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot} ${s.dotAnim ?? ''}`}
        aria-hidden="true"
      />
      {text}
    </span>
  )
}
