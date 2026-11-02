import { browserLocal } from './mode'
// Guard before React mounts. Fail closed for APIs and write requests in local mode.
export function installLocalNetworkGuard() {
  if (!browserLocal()) return
  const policy = document.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "default-src 'self'; connect-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'"
  document.head.append(policy)
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (url.origin !== location.origin || !['GET','HEAD'].includes(method.toUpperCase()) || url.pathname.startsWith('/api/') || url.pathname.includes('__ynote_local__')) {
      throw new Error('浏览器本地模式已阻止网络内容请求；不会静默上传或使用远程模型')
    }
    return originalFetch(input, init)
  }
  // The current pipeline never uses XHR/WebSocket/sendBeacon; block legacy transports too.
  navigator.sendBeacon = () => false
  const denied = () => { throw new Error('本地模式不允许使用此网络传输') }
  XMLHttpRequest.prototype.send = denied
  window.WebSocket = class { constructor() { denied() } } as unknown as typeof WebSocket
  window.EventSource = class { constructor() { denied() } } as unknown as typeof EventSource
}
