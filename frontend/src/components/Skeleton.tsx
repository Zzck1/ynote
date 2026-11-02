interface SkeletonProps {
  /** 宽度，如 '40%' '100%' '90%' */
  width: string
  /** 高度 px */
  height: number
  className?: string
}

/** 脉动骨架块（design-spec §5.9：bg #F5F5F5，radius 4px，prefers-reduced-motion 静止） */
export function Skeleton({ width, height, className }: SkeletonProps) {
  return (
    <div
      className={`skeleton-pulse rounded-sm bg-hov ${className ?? ''}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  )
}
