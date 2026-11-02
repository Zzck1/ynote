import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'
import './theme.css'
import './components/yuanshengzhe-panel.css'
import { installLocalNetworkGuard } from './browser/privacy'
import { browserLocal } from './browser/mode'
installLocalNetworkGuard()
if (browserLocal() && isSecureContext && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/browser-offline.js', { scope: '/' }).catch(() => {})
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

createRoot(root).render(<App />)

// 全局兜底：捕获 effect 里的未处理 Promise rejection（ErrorBoundary 抓不到这类）
// 与渲染期异常不同，这类 rejection 不会清空 root，但会让功能静默失效，显式抛到控制台便于排查。
// eslint-disable-next-line no-console
window.addEventListener('unhandledrejection', (e) => console.error('[unhandledrejection]', e.reason))
// eslint-disable-next-line no-console
window.addEventListener('error', (e) => console.error('[window error]', e.error ?? e.message))
