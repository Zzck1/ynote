/**
 * Mock 素材文件生成。
 * 更新（2026-10-14）：视频/音频/封面改为真实可播放的演示媒体，
 * 位于 frontend/public/demo/（ffmpeg 生成的 mp4/mp3/jpg），由 mock/router.ts 直接返回 URL，
 * 素材标签页内嵌 <video>/<audio> 播放器与封面图预览（对齐 anytocopy 式直接预览）。
 * 图片仍为程序生成 SVG 占位；字幕为文本占位。
 */

export interface PlaceholderImageSpec {
  width: number
  height: number
  label: string
}

/** 生成占位图 SVG 文本（纯黑白灰，符合 design-spec 红线：无彩色渐变） */
export function makePlaceholderSvg(spec: PlaceholderImageSpec): string {
  const { width, height, label } = spec
  const shortSide = Math.min(width, height)
  const iconSize = Math.round(shortSide * 0.12)
  const fontSize = Math.round(shortSide * 0.05)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#FAFAFA"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#E5E5E5" stroke-width="2"/>
  <g fill="none" stroke="#A3A3A3" stroke-width="${Math.max(2, Math.round(shortSide * 0.008))}" stroke-linecap="round" stroke-linejoin="round">
    <rect x="${width / 2 - iconSize * 1.35}" y="${height / 2 - iconSize}" width="${iconSize * 2.7}" height="${iconSize * 1.8}" rx="${iconSize * 0.15}"/>
    <circle cx="${width / 2 - iconSize * 0.55}" cy="${height / 2 - iconSize * 0.35}" r="${iconSize * 0.16}"/>
    <path d="M ${width / 2 - iconSize * 1.35} ${height / 2 + iconSize * 0.55} l ${iconSize * 0.8} -${iconSize * 0.7} l ${iconSize * 0.9} ${iconSize * 0.9} l ${iconSize * 0.6} -${iconSize * 0.5} l ${iconSize * 1.25} ${iconSize * 1.1}"/>
  </g>
  <text x="${width / 2}" y="${height / 2 + iconSize * 2.2}" font-family="ui-monospace, monospace" font-size="${fontSize}" fill="#737373" text-anchor="middle">${label}</text>
</svg>`
}

export function makePlaceholderImageBlob(width: number, height: number, label: string): Blob {
  return new Blob([makePlaceholderSvg({ width, height, label })], {
    type: 'image/svg+xml',
  })
}

/** 占位图的 dataURL，用于界面内 <img> 预览（alt 文案见 design-spec §8.6） */
export function makePlaceholderImageDataUrl(width: number, height: number, label: string): string {
  const svg = makePlaceholderSvg({ width, height, label })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 文本类文件（TXT/SRT/Markdown 导出、字幕） */
export function makeTextBlob(content: string, mime = 'text/plain;charset=utf-8'): Blob {
  return new Blob([content], { type: mime })
}

/** SRT 时间码：00:00:03,120 --> 00:00:07,480 */
export function formatSrtTimecode(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`
}
