import { Loader2 } from 'lucide-react'

interface SpinnerProps {
  /** 尺寸，默认 14px；进行中场景按 design-spec §5.5 用 info 色 #2563EB 的圆点呼吸另算 */
  size?: 12 | 14 | 16
  className?: string
}

/** 旋转 spinner（design-spec §5.5：黑白用 #171717） */
export function Spinner({ size = 14, className }: SpinnerProps) {
  return (
    <Loader2
      className={`icon-spin shrink-0 text-ink ${className ?? ''}`}
      size={size}
      strokeWidth={1.5}
      aria-hidden="true"
    />
  )
}
