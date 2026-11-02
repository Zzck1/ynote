import { strToU8, zipSync } from 'fflate'
import { saveMindmap as saveBlob } from './mindmapExport'
import { toSimplified } from './simplified'

export function readableNote(markdown: string, sourceUrl = ''): string {
  const body = toSimplified(markdown).replace(/\s*\[[a-f0-9]{24,64}\]/gi, '').replace(/[ \t]+\n/g, '\n').trim()
  return sourceUrl && /^https?:\/\//.test(sourceUrl) && !body.startsWith('> 来源链接') ? `> 来源链接：${sourceUrl.replace(/[<>\r\n]/g, '')}\n\n${body}\n` : body + '\n'
}
function xml(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

type Block = { text: string; heading: number; list: boolean; quote: boolean; code: boolean; runs: { text: string; bold: boolean; italic: boolean; code: boolean }[] }
export function noteBlocks(container: HTMLElement): Block[] {
  const blocks: Block[] = []
  function add(element: Element, list = false) {
    const tag = element.tagName, heading = /^H[1-6]$/.test(tag) ? Number(tag[1]) : 0
    if (['UL', 'OL'].includes(tag)) { Array.from(element.children).forEach(child => add(child, true)); return }
    if (tag === 'TABLE') { for (const row of element.querySelectorAll('tr')) blocks.push({ text: Array.from(row.children).map(c => c.textContent || '').join('  |  '), heading: 0, list: false, quote: false, code: false, runs: [] }); return }
    const runs: Block['runs'] = []
    function visit(node: Node, bold = false, italic = false, code = false) {
      if (node.nodeType === Node.TEXT_NODE) { if (node.textContent) runs.push({ text: node.textContent, bold, italic, code }); return }
      if (!(node instanceof Element) || ['UL', 'OL'].includes(node.tagName)) return
      if (node.tagName === 'BR') { runs.push({ text: '\n', bold, italic, code }); return }
      for (const child of node.childNodes) visit(child, bold || ['STRONG', 'B'].includes(node.tagName), italic || ['EM', 'I'].includes(node.tagName), code || ['CODE', 'PRE'].includes(node.tagName))
    }
    visit(element)
    const text = runs.map(r => r.text).join('').trim()
    if (text) blocks.push({ text, heading, list, quote: tag === 'BLOCKQUOTE', code: tag === 'PRE', runs })
    if (tag === 'LI') for (const child of element.children) if (['UL', 'OL'].includes(child.tagName)) add(child)
  }
  for (const element of container.children) add(element)
  return blocks
}

export function exportWord(container: HTMLElement, filename: string) {
  const paragraphs = noteBlocks(container).map(block => {
    const style = block.heading === 1 ? 'Title' : block.heading ? `Heading${Math.min(3, block.heading - 1)}` : 'Normal'
    const properties = `<w:pStyle w:val="${style}"/>${block.heading ? '<w:keepNext/>' : ''}<w:spacing w:after="160" w:line="340" w:lineRule="auto"/>${block.list ? '<w:ind w:left="360" w:hanging="180"/>' : ''}`
    const runs = block.runs.length ? block.runs : [{ text: block.text, bold: false, italic: false, code: false }]
    const text = runs.map(run => `<w:r><w:rPr>${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${run.code ? '<w:rFonts w:ascii="Consolas" w:eastAsia="Microsoft YaHei"/>' : ''}</w:rPr>${run.text.split('\n').map((part, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(part)}</w:t>`).join('')}</w:r>`).join('')
    return `<w:p><w:pPr>${properties}</w:pPr>${block.list ? '<w:r><w:t>• </w:t></w:r>' : ''}${text}</w:p>`
  }).join('')
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:color w:val="000000"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[['Title', '36'], ['Heading1', '30'], ['Heading2', '26'], ['Heading3', '24']].map(([id, size]) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/><w:color w:val="000000"/></w:rPr></w:style>`).join('')}</w:styles>`
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/document.xml': documentXml, 'word/styles.xml': styles,
  }
  saveBlob(new Blob([new Uint8Array(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))).buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), filename + '.docx')
}

let fontPromise: Promise<string> | undefined
async function pdfFont() {
  if (!fontPromise) fontPromise = fetch(import.meta.env.BASE_URL + 'fonts/YnoteSans-Regular.ttf').then(async response => {
    if (!response.ok) throw new Error('中文字体加载失败，请重试')
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return btoa(binary)
  }).catch(error => { fontPromise = undefined; throw error })
  return fontPromise
}
export async function exportPdf(container: HTMLElement, filename: string) {
  const [{ jsPDF }, font] = await Promise.all([import('jspdf'), pdfFont()])
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  pdf.addFileToVFS('YnoteSans.ttf', font); pdf.addFont('YnoteSans.ttf', 'YnoteSans', 'normal'); pdf.setFont('YnoteSans')
  pdf.setProperties({ title: filename, creator: 'Ynote' })
  let y = 22
  function newPage() { pdf.addPage(); y = 22 }
  for (const block of noteBlocks(container)) {
    const size = block.heading === 1 ? 18 : block.heading === 2 ? 14 : block.heading ? 12 : 10.5
    const lineHeight = size * .3528 * 1.7
    const indent = block.list || block.quote ? 4 : 0
    pdf.setFontSize(size)
    const lines = pdf.splitTextToSize((block.list ? '• ' : '') + block.text, 166 - indent) as string[]
    if (block.heading && y + lineHeight * 3 > 272) newPage()
    y += block.heading ? 4 : 1
    for (const line of lines) {
      if (y + lineHeight > 276) newPage()
      pdf.text(line, 22 + indent, y + lineHeight * .8); y += lineHeight
    }
    y += block.heading ? 2 : 3
  }
  for (let i = 1; i <= pdf.getNumberOfPages(); i++) { pdf.setPage(i); pdf.setFontSize(9); pdf.text(`${i} / ${pdf.getNumberOfPages()}`, 105, 287, { align: 'center' }) }
  pdf.save(filename + '.pdf')
}
