interface ProgressLineProps {
  /** 0~1 */
  progress: number
  className?: string
}

/** 2px 进度条：轨道 #E5E5E5，填充 #171717（design-spec §5.5） */
export function ProgressLine({ progress, className }: ProgressLineProps) {
  const pct = Math.max(0, Math.min(1, progress)) * 100
  return (
    <div
      className={`h-0.5 w-full overflow-hidden rounded-sm bg-line ${className ?? ''}`}
      role="progressbar"
      aria-valuenow={Math.round(progress * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-ink transition-[width] duration-150 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
