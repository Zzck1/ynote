import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Download, FileText, LoaderCircle, NotebookPen, Zap } from 'lucide-react'
import { readableNote, exportWord, exportPdf } from '../utils/noteExport'
import { saveMindmap as saveBlob } from '../utils/mindmapExport'

export function AINotePanel({ markdown, title, sourceUrl = '', label = 'AI 笔记', busy = false, canGenerate = false, onGenerate }: { markdown: string; title: string; sourceUrl?: string; label?: string; busy?: boolean; canGenerate?: boolean; onGenerate?: () => void }) {
  const body = readableNote(markdown, markdown ? sourceUrl : '')
  const bodyRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState('')
  const [message, setMessage] = useState('')
  const filename = (title || 'AI笔记').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)
  async function action(kind: 'copy' | 'word' | 'markdown' | 'pdf') {
    if (!markdown || !bodyRef.current || exporting) return
    setExporting(kind); setMessage('')
    try {
      if (kind === 'copy') { await navigator.clipboard.writeText(bodyRef.current.innerText); setMessage('文本已复制') }
      else if (kind === 'word') exportWord(bodyRef.current, filename)
      else if (kind === 'markdown') saveBlob(new Blob([body], { type: 'text/markdown;charset=utf-8' }), filename + '.md')
      else await exportPdf(bodyRef.current, filename)
    } catch (e) { setMessage((e as Error).message || '操作未完成，请重试') }
    finally { setExporting('') }
  }
  return <section className="result-box ai-note-result"><div className="result-box-heading"><h3><NotebookPen size={20} /> {label}</h3><div className="result-actions">
    <button className="card-action" title="复制文本" disabled={!markdown || !!exporting} onClick={() => void action('copy')}><Copy size={14} />复制文本</button>
    <button className="card-action" title="导出为 Word" aria-label="导出为 Word" disabled={!markdown || !!exporting} onClick={() => void action('word')}><FileText size={14} />Word</button>
    <button className="card-action" title="导出为 Markdown" aria-label="导出为 Markdown" disabled={!markdown || !!exporting} onClick={() => void action('markdown')}><Download size={14} />Markdown</button>
    <button className="card-action" title="导出为 PDF" aria-label="导出为 PDF" disabled={!markdown || !!exporting} onClick={() => void action('pdf')}>{exporting === 'pdf' ? <LoaderCircle size={14} className="icon-spin" /> : <Download size={14} />}PDF</button>
    {onGenerate && <button className="card-action" disabled={!canGenerate || busy} onClick={onGenerate}>{busy ? <LoaderCircle size={14} className="icon-spin" /> : <Zap size={14} />}{busy ? '正在生成' : markdown ? (label==='AI 笔记'?'重新生成笔记':'重新生成摘录') : (label==='AI 笔记'?'生成笔记':'生成摘录')}</button>}
  </div></div>{message && <p role="status" className="input-hint">{message}</p>}
  {markdown ? <div ref={bodyRef} className="md-body note-paper"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown></div> : <div className="no-content text-surface">提取并核对原文后可生成摘录与内容导图。</div>}
  </section>
}
