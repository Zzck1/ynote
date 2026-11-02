export const MAX_BYTES = 64 * 1024 * 1024
export const MAX_SECONDS = 300
export async function decodeLocal(file: File, signal: AbortSignal): Promise<{ pcm: Float32Array; duration: number }> {
  if (file.size > MAX_BYTES) throw new Error('当前保守限制：文件不超过 64 MiB，请先在本机裁剪；不会上传处理')
  signal.throwIfAborted()
  const url = URL.createObjectURL(file)
  const media = document.createElement('audio')
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('读取音轨信息超时，请换用 WAV／MP3')), 15000)
      const aborted = () => finish(new Error('解码已取消'))
      const finish = (error?: Error) => {
        clearTimeout(timeout); signal.removeEventListener('abort', aborted)
        media.onloadedmetadata = null; media.onerror = null
        error ? reject(error) : resolve()
      }
      media.onloadedmetadata = () => finish(!Number.isFinite(media.duration) || media.duration <= 0 || media.duration > MAX_SECONDS ? new Error('当前仅处理不超过 5 分钟且具有有效时长的文件，请先在本机裁剪') : undefined)
      media.onerror = () => finish(new Error('浏览器不能读取此文件的音轨信息，请换用 WAV／MP3 或兼容 MP4'))
      signal.addEventListener('abort', aborted, { once: true })
      media.preload = 'metadata'; media.src = url
    })
  } finally { media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url) }
  signal.throwIfAborted()
  const context = new AudioContext({ sampleRate: 16000 })
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer())
    signal.throwIfAborted()
    if (decoded.duration > MAX_SECONDS || decoded.numberOfChannels > 2) throw new Error('当前仅接受不超过 5 分钟的单声道／双声道文件，请先裁剪；不承诺任意视频格式')
    const offline = new OfflineAudioContext(1, decoded.length, 16000)
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start()
    const mono = await offline.startRendering()
    signal.throwIfAborted()
    const pcm = new Float32Array(mono.getChannelData(0))
    // AudioContext requests 16 kHz; reject rather than pass wrong-rate samples.
    if (decoded.sampleRate !== 16000) throw new Error('浏览器未按 16 kHz 解码，此格式尚不支持')
    return { pcm, duration: decoded.duration }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'EncodingError') throw new Error('浏览器无法解码此音视频的音轨。请使用 WAV／MP3 或兼容的 MP4 音轨；未上传文件')
    throw e
  } finally { await context.close() }
}

export function timestamp(ms: number) {
  const value = Math.max(0, Math.round(ms))
  return `${String(Math.floor(value / 3600000)).padStart(2,'0')}:${String(Math.floor(value / 60000) % 60).padStart(2,'0')}:${String(Math.floor(value / 1000) % 60).padStart(2,'0')},${String(value % 1000).padStart(3,'0')}`
}
export function validateNote(markdown: string) {
  if (!markdown.trim() || markdown.length > 60000) throw new Error('生成笔记为空或超过安全长度')
  const clean = markdown.replace(/<[^>]*>/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片已移除]').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Limit tree depth and node count before passing to existing safe Markmap renderer.
  if (clean.split('\n').filter(line => /^\s*(?:#{1,6}\s|[-*+]\s)/.test(line)).length > 500) throw new Error('导图节点过多，请缩短原文')
  return /^#\s/m.test(clean) ? clean : '# 语音笔记\n\n' + clean
}
