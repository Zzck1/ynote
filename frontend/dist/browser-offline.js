/* Static shell cache only. Models use their separate, explicit-consent cache. No content logging. */
const CACHE = 'ynote-static-898039a1fcc5da9e'
const RUNTIME = 'ynote-runtime-ort-1.22-v1'
self.addEventListener('install', event => event.waitUntil((async () => {
  const files = await (await fetch('/offline-files.json', { cache: 'no-store' })).json()
  const cache = await caches.open(CACHE)
  await cache.addAll(files)
  await self.skipWaiting()
})()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.includes('__ynote_local__') || url.pathname.startsWith('/models/')) return
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      try { const response = await fetch(event.request); if (response.ok) await cache.put('/index.html',response.clone()); return response }
      catch { return await cache.match('/index.html') ?? new Response('离线缓存尚未准备完成，请联网打开一次网站。',{status:503}) }
    })())
  } else if (/^\/(assets|fonts|runtime)\//.test(url.pathname) || /\.(jpg|png|svg)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(url.pathname.startsWith('/runtime/') ? RUNTIME : CACHE)
      if(url.pathname.startsWith('/runtime/') && event.request.headers.get('X-Ynote-Prepare') === '1') return fetch(event.request)
      const cached = await cache.match(event.request)
      if (cached) return cached
      if(url.pathname.startsWith('/runtime/')) return new Response('请先准备本地模型运行资源',{status:503})
      const response = await fetch(event.request)
      if (response.ok) await cache.put(event.request, response.clone())
      return response
    })())
  }
})
