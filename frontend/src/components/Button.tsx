import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  /** loading 时的进行中文案 */
  loadingText?: string
  /** loading 时的进度（0~1），用于底部 2px 进度条 */
  progress?: number
  /** 不可用态（≠ disabled）：保留 tooltip reason 文案，按钮按禁用样式渲染 */
  unavailableReason?: string
  children: ReactNode
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'btn-ink bg-accent text-inverse hover:bg-[#1255cb] active:bg-[#1049ad] disabled:bg-hov disabled:text-ink-4 shadow-sm',
  secondary:
    'bg-page border border-line-strong text-ink hover:bg-subtle active:bg-act disabled:border-line disabled:text-ink-4',
  ghost:
    'text-ink-2 hover:bg-hov hover:text-ink active:bg-act disabled:text-ink-4',
  danger:
    'bg-page border border-danger text-danger hover:bg-danger-bg active:bg-[#fee2e2] disabled:border-line disabled:text-ink-4',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] font-medium rounded-md',
  md: 'h-10 px-4 text-sm font-medium rounded-md',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingText,
  progress,
  unavailableReason,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || !!unavailableReason || loading

  // 不可用态：包裹 tooltip
  if (unavailableReason) {
    return (
      <span className="group relative inline-block">
        <button
          type="button"
          disabled
          className={`${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} cursor-not-allowed opacity-60 ${className ?? ''}`}
          aria-disabled="true"
          {...rest}
        >
          {children}
        </button>
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-[100] mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-page px-2 py-1 text-[12px] text-ink-2 opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover:opacity-100"
        >
          {unavailableReason}
        </span>
      </span>
    )
  }

  return (
    <button
      type="button"
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={`relative inline-flex items-center justify-center gap-1.5 transition-[background,border-color,color] duration-150 ease-out ${
        SIZE_CLASSES[size]
      } ${VARIANT_CLASSES[variant]} ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${className ?? ''}`}
      {...rest}
    >
      {loading && <Spinner size={14} className="text-current" />}
      <span>{loading ? (loadingText ?? children) : children}</span>
      {loading && progress !== undefined && (
        <span className="font-mono text-[13px] tabular-nums">{`${Math.round(progress * 100)}%`}</span>
      )}
      {loading && progress !== undefined && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden rounded-b-md">
          <div
            className="h-full bg-current transition-[width] duration-150 ease-out"
            style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
          />
        </div>
      )}
    </button>
  )
}
