import { strToU8, zipSync } from 'fflate'

type Topic = { content: string; children?: Topic[] }
const NS = 'http://www.w3.org/2000/svg'

export function xmindFile(root: Topic): Blob {
  function topic(node: Topic): object {
    const text = document.createElement('template')
    text.innerHTML = node.content
    return { id: crypto.randomUUID(), class: 'topic', title: text.content.textContent || '未命名',
      ...(node.children?.length ? { children: { attached: node.children.map(topic) } } : {}) }
  }
  const sheet = [{ id: crypto.randomUUID(), class: 'sheet', title: '思维导图', rootTopic: topic(root) }]
  const files = {
    'content.json': strToU8(JSON.stringify(sheet)),
    'metadata.json': strToU8(JSON.stringify({ creator: { name: 'Ynote', version: '0.5' } })),
    'manifest.json': strToU8(JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } })),
  }
  return new Blob([new Uint8Array(zipSync(files)).buffer], { type: 'application/vnd.xmind.workbook' })
}

/** Export all visible branches in map coordinates, independent of pan or zoom.
 * Replace HTML labels with SVG text so PNG conversion remains origin-clean. */
export function standaloneSvg(svg: SVGSVGElement): { blob: Blob; width: number; height: number } {
  const group = svg.querySelector('g')
  if (!group) throw new Error('导图还在绘制，请稍后重试')
  const bounds = group.getBBox(), inverse = group.getScreenCTM()?.inverse()
  if (!inverse || !bounds.width || !bounds.height) throw new Error('导图还未准备好')
  const width = Math.ceil(bounds.width + 64), height = Math.ceil(bounds.height + 64)
  const result = document.createElementNS(NS, 'svg')
  result.setAttribute('xmlns', NS); result.setAttribute('width', String(width)); result.setAttribute('height', String(height))
  result.setAttribute('viewBox', `${bounds.x - 32} ${bounds.y - 32} ${width} ${height}`)
  const background = document.createElementNS(NS, 'rect')
  background.setAttribute('x', String(bounds.x - 32)); background.setAttribute('y', String(bounds.y - 32))
  background.setAttribute('width', String(width)); background.setAttribute('height', String(height)); background.setAttribute('fill', '#ffffff')
  result.appendChild(background)
  const clone = group.cloneNode(true) as SVGGElement
  clone.removeAttribute('transform')
  const originalPaths = group.querySelectorAll('path,line,circle,rect')
  clone.querySelectorAll('path,line,circle,rect').forEach((element, i) => {
    const style = getComputedStyle(originalPaths[i])
    for (const name of ['fill', 'stroke', 'stroke-width', 'opacity']) element.setAttribute(name, style.getPropertyValue(name))
  })
  clone.querySelectorAll('foreignObject').forEach(element => element.remove())
  const labels = document.createElementNS(NS, 'g')
  let glyphs = 0
  for (const foreign of group.querySelectorAll('foreignObject')) {
    const walker = document.createTreeWalker(foreign, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const style = getComputedStyle(node.parentElement!)
      const range = document.createRange()
      const content = node.textContent || ''
      for (let index = 0; index < content.length;) {
        const character = String.fromCodePoint(content.codePointAt(index)!)
        if (++glyphs > 30000) throw new Error('导图过大，请折叠部分分支后导出图片')
        range.setStart(node, index); index += character.length; range.setEnd(node, index)
        const rect = range.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        const point = new DOMPoint(rect.left, rect.bottom - rect.height * .2).matrixTransform(inverse)
        const text = document.createElementNS(NS, 'text')
        text.setAttribute('x', String(point.x)); text.setAttribute('y', String(point.y))
        text.setAttribute('font-family', style.fontFamily); text.setAttribute('font-size', style.fontSize)
        text.setAttribute('font-weight', style.fontWeight); text.setAttribute('font-style', style.fontStyle)
        text.setAttribute('fill', style.color); text.textContent = character
        labels.appendChild(text)
      }
    }
  }
  clone.appendChild(labels); result.appendChild(clone)
  return { blob: new Blob([new XMLSerializer().serializeToString(result)], { type: 'image/svg+xml;charset=utf-8' }), width, height }
}

export async function mindmapPng(svg: SVGSVGElement): Promise<Blob> {
  const { blob, width, height } = standaloneSvg(svg)
  const scale = Math.min(2, 8192 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)))
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法创建图片画布')
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG 生成失败')), 'image/png'))
  } finally { URL.revokeObjectURL(url) }
}

export function saveMindmap(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
