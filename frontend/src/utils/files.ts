/** 文件名清理（Windows 保留字/非法字符）与下载/剪贴板工具 */

/** 清理文件名：Windows 保留字、非法字符、首尾空格与点 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
  if (reserved.test(cleaned)) return `_${cleaned}`
  return cleaned || '未命名'
}

/** 触发浏览器下载（blob: URL 或同源路径） */
export function downloadUrl(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = sanitizeFilename(filename)
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (url.startsWith('blob:')) {
    // 释放稍晚进行，确保下载已开始
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}

/** 复制文本；失败返回 false（content-plan §6 复制失败文案由调用方展示） */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 走降级 */
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    textarea.remove()
    return ok
  } catch {
    return false
  }
}
