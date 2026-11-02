/* Same-origin streaming media proxy; credentials are never in URLs or storage. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const marker = '__ynote_local__'
  const index = url.pathname.indexOf(marker)
  if (url.origin !== self.location.origin || index < 0) return
  const path = url.pathname.slice(index + marker.length)
  if (!/^\/api\/(assets|exports)\/[a-f0-9]+\/download$/.test(path) || event.request.method !== 'GET') {
    event.respondWith(new Response('接口不允许', { status: 403 })); return
  }
  event.respondWith((async () => {
    let client = event.clientId ? await self.clients.get(event.clientId) : null
    // Download navigations can omit clientId; use only an exact same-origin referrer.
    if (!client && event.request.referrer) {
      const referrer = new URL(event.request.referrer)
      if (referrer.origin === self.location.origin) {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: false })
        client = windows.find(window => window.url === referrer.href)
      }
    }
    if (!client) return new Response('请重新打开工作台', { status: 401 })
    const auth = await new Promise(resolve => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve({}), 3000)
      channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data || {}); channel.port1.close() }
      client.postMessage({ type: 'ynote-local-auth' }, [channel.port2])
    })
    if (!auth.token) return new Response('请重新配对助手', { status: 401 })
    const headers = { Authorization: 'Bearer ' + auth.token, 'X-Ynote-Protocol': '1' }
    if (event.request.headers.has('range')) headers.Range = event.request.headers.get('range')
    const r = await fetch('http://127.0.0.1:18790/v1/local' + path + url.search, { headers, credentials: 'omit', cache: 'no-store' })
    const resultHeaders = new Headers()
    for (const name of ['content-type','content-length','content-range','accept-ranges','content-disposition']) {
      if (r.headers.has(name)) resultHeaders.set(name,r.headers.get(name))
    }
    resultHeaders.set('Cache-Control','no-store')
    return new Response(r.body,{status:r.status,headers:resultHeaders})
  })())
})
