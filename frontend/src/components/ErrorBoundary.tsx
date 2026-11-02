import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  hasError: boolean
  error: Error | null
  info: ErrorInfo | null
}

/**
 * 错误边界：把渲染期未捕获异常从「白屏」变成「可见报错卡」。
 * 设计规范 §5.9 风格：白底 + 1px 边框 + danger 文字。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 写到控制台，便于排查
    // eslint-disable-next-line no-console
    console.error('[Ynote ErrorBoundary]', error, info)
    this.setState({ info })
  }

  handleReload = (): void => {
    // 清掉本地工作台状态后刷新，避免坏数据再次触发同一崩溃
    try {
      localStorage.removeItem('edaynote.workspace.v1')
    } catch {
      /* 忽略 */
    }
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError || !this.state.error) return this.props.children
    const stack = this.state.error.stack ?? ''
    const componentStack = this.state.info?.componentStack ?? ''
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-[640px] rounded-lg border border-line bg-page p-6">
          <h1 className="text-lg font-semibold text-danger">页面出错了</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Ynote 在渲染时遇到了一个未预期的错误。这是 Bug，不是你的操作问题。
            可以点击下方按钮清空本地状态并刷新；如果仍出错，请把下面这段错误信息发给我。
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="h-9 rounded-md bg-ink px-4 text-sm font-medium text-inverse transition-colors duration-150 hover:bg-black"
            >
              清空状态并刷新
            </button>
          </div>
          <pre className="mt-4 max-h-[320px] overflow-auto rounded-md bg-subtle p-3 font-mono text-[12px] leading-relaxed text-ink-2">
            {this.state.error.name}: {this.state.error.message}
            {stack && `\n\n${stack}`}
            {componentStack && `\n\n组件栈：${componentStack}`}
          </pre>
        </div>
      </div>
    )
  }
}
