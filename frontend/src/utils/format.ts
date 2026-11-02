/** 时间/平台/字节的展示格式化 */

export function formatDurationSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`
}

/** ms -> mm:ss（≥1h 用 h:mm:ss），用于原文时间戳 */
export function formatClockMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  return formatDurationSec(Math.floor(ms / 1000))
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前（content-plan §2.4 示例口径） */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  if (diff < MIN) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 2 * DAY) return '昨天'
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 平台显示名（content-plan §2.2） */
export function platformLabel(platform: string): string {
  switch (platform) {
    case 'bilibili':
      return 'B站'
    case 'douyin':
      return '抖音'
    case 'xiaohongshu':
      return '小红书'
    case 'kuaishou':
      return '快手'
    case 'youtube':
      return 'YouTube'
    case 'local':
      return '本地'
    default:
      return platform
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** 原文来源显示名（content-plan §2.2/§2.3 的 {来源}） */
export function transcriptSourceLabel(source: string): string {
  switch (source) {
    case 'subtitle':
      return '字幕'
    case 'asr':
      return '转写'
    case 'post_text':
      return '帖子正文'
    case 'imported':
      return '导入文本'
    default:
      return source
  }
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}
