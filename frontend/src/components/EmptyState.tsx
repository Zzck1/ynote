import type { LucideIcon } from 'lucide-react'
import { Button } from './Button'

interface EmptyStateProps {
  icon: LucideIcon
  text: string
  /** 可选主操作按钮文案 */
  actionLabel?: string
  onAction?: () => void
}

/** 空状态卡片（design-spec §5.9：图标 40px 线宽 1.5 + 文案 + 可选按钮） */
export function EmptyState({ icon: Icon, text, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-5 py-10 text-center">
      <div className="rounded-xl border border-line bg-hov p-3"><Icon size={24} strokeWidth={1.4} className="text-ink-3" aria-hidden="true" /></div>
      <p className="mt-3 max-w-[280px] text-sm leading-relaxed text-ink-2">{text}</p>
      {actionLabel && onAction && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
