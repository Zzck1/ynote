import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, FileArchive, Image as ImageIcon, LoaderCircle, Maximize, Minimize, Network } from 'lucide-react'
import { Markmap } from 'markmap-view'
import { createSafeMindmap } from '../pages/workspace/components/safeMindmap'
import { mindmapPng, saveMindmap, standaloneSvg, xmindFile } from '../utils/mindmapExport'
import { toSimplified } from '../utils/simplified'

export function InlineMindmap({ markdown: sourceMarkdown }: { markdown: string }) {
  const markdown = toSimplified(sourceMarkdown)
  const svgRef = useRef<SVGSVGElement>(null)
  const mapRef = useRef<Markmap | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!markdown || !svgRef.current) return
    let live = true
    const map = Markmap.create(svgRef.current, { duration: 0, maxWidth: 280 }, createSafeMindmap(markdown))
    mapRef.current = map
    void map.fit().then(() => { if (live) setReady(true) })
    const observer = new ResizeObserver(() => { void map.fit() })
    observer.observe(svgRef.current)
    return () => { live = false; observer.disconnect(); map.destroy(); mapRef.current = null; setReady(false) }
  }, [markdown])

  useEffect(() => {
    const exit = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false) }
    const changed = () => { if (!document.fullscreenElement) setFullscreen(false) }
    window.addEventListener('keydown', exit); document.addEventListener('fullscreenchange', changed)
    return () => { window.removeEventListener('keydown', exit); document.removeEventListener('fullscreenchange', changed) }
  }, [])

  async function act(kind: 'xmind' | 'png' | 'copy' | 'svg') {
    if (!svgRef.current || busy || !ready) return
    setBusy(kind); setMessage('')
    try {
      if (kind === 'xmind') saveMindmap(xmindFile(createSafeMindmap(markdown)), '思维导图.xmind')
      else if (kind === 'svg') saveMindmap(standaloneSvg(svgRef.current).blob, '思维导图.svg')
      else if (kind === 'png') saveMindmap(await mindmapPng(svgRef.current), '思维导图.png')
      else {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前浏览器不支持复制图片，请使用 PNG 导出')
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': mindmapPng(svgRef.current) })])
        setMessage('PNG 图片已复制')
      }
    } catch (e) { setMessage(kind === 'copy' ? '图片复制未成功，请允许剪贴板权限或使用 PNG 导出。' : (e as Error).message) }
    finally { setBusy('') }
  }

  function toggleFullscreen() {
    if (fullscreen) {
      if (document.fullscreenElement === sectionRef.current) void document.exitFullscreen().catch(() => null)
      setFullscreen(false)
    } else {
      setFullscreen(true)
      void sectionRef.current?.requestFullscreen?.().catch(() => null)
    }
  }

  const disabled = !markdown || !ready || !!busy
  return <section ref={sectionRef} className={`result-box mindmap-result ${fullscreen ? 'mindmap-fullscreen' : ''}`}>
    <div className="result-box-heading"><h3><Network size={20} /> 思维导图</h3>
      <div className="result-actions">
        <button className="card-action" title="导出 Xmind 格式" aria-label="导出 Xmind 格式" disabled={disabled} onClick={() => void act('xmind')}><FileArchive size={14} />Xmind</button>
        <button className="card-action" title="导出 PNG 图片" aria-label="导出 PNG 图片" disabled={disabled} onClick={() => void act('png')}>{busy === 'png' ? <LoaderCircle size={14} className="icon-spin" /> : <ImageIcon size={14} />}PNG</button>
        <button className="card-action" title="复制 PNG 图片" aria-label="复制 PNG 图片" disabled={disabled} onClick={() => void act('copy')}>{busy === 'copy' ? <LoaderCircle size={14} className="icon-spin" /> : message === 'PNG 图片已复制' ? <Check size={14} /> : <Copy size={14} />}复制</button>
        <button className="card-action" title="导出 SVG 图片" aria-label="导出 SVG 图片" disabled={disabled} onClick={() => void act('svg')}><Download size={14} />SVG</button>
        <button className="card-action" title={fullscreen ? '退出全屏预览' : '全屏预览'} aria-label={fullscreen ? '退出全屏预览' : '全屏预览'} disabled={!markdown || !ready} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}{fullscreen ? '退出' : '全屏'}</button>
      </div>
    </div>
    {message && <p className="input-hint" role="status">{message}</p>}
    {markdown ? <div className="inline-mindmap"><svg ref={svgRef} className="markmap" role="img" aria-label="当前任务思维导图" /></div> : <div className="no-content text-surface">生成上方 AI 笔记后，思维导图会自动显示在这里。</div>}
  </section>
}
