import { useEffect, useRef, useState, lazy, Suspense, type ReactNode, type PointerEvent } from 'react'
import { Link } from 'react-router'
import { ArrowRight, ArrowUpRight, AudioLines, Check, CheckCircle2, ChevronDown, Clock3, Copy, Download, FileText, FolderOpen, Link2, LoaderCircle, MonitorPlay, Plus, ShieldCheck, Sparkles, Upload, Video, X } from 'lucide-react'
import { importLocalFile } from '../api/materials'
import { useWorkspaceStore } from '../stores/workspaceStore'
const GlassArt = lazy(() => import('../components/GlassArt').then(m => ({default:m.GlassArt})))
import './extract.css'

type Format = { id: string; height: number | null; ext: string; video: boolean; audio: boolean; bytes: number | null }
type Media = { id: string; title: string; author: string; duration: number | null; platform: string; url: string; local: boolean; formats: Format[]; created_at: string }
type Job = { id: string; media_id: string; title: string; kind: 'video' | 'mp3'; format_id: string; state: string; stage: string; bytes?: number; download_url?: string; created_at: string }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/media' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || '请求失败，请重试')
  return data as T
}
const duration = (v: number | null) => v == null ? '时长未知' : `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`
const bytes = (v?: number | null) => v ? `${(v / 1024 / 1024).toFixed(1)} MB` : '大小以实际文件为准'
const platforms: Record<string, string> = { bilibili: 'Bilibili', youtube: 'YouTube', douyin: '抖音', local: '本地文件', other: '视频平台' }

function MotionCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  function move(e: PointerEvent<HTMLElement>) {
    if (e.pointerType !== 'mouse' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const el = e.currentTarget, r = el.getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    el.style.setProperty('--mx', `${x}px`); el.style.setProperty('--my', `${y}px`)
    el.style.transform = `perspective(1000px) rotateX(${-(y / r.height - .5) * 3}deg) rotateY(${(x / r.width - .5) * 3}deg) translateY(-3px)`
  }
  return <article className={`motion-card ${className}`} onPointerMove={move} onPointerLeave={e => { e.currentTarget.style.transform = ''; }}><div className="spotlight-halo" />{children}</article>
}

export function ExtractPage() {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [items, setItems] = useState<Media[]>([])
  const [current, setCurrent] = useState<Media | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [format, setFormat] = useState('best')
  const [preparing, setPreparing] = useState('')
  const [preview, setPreview] = useState<Job | null>(null)
  const [copied, setCopied] = useState(false)
  const [tools, setTools] = useState({ ffmpeg: true, ffprobe: true })
  const [notice, setNotice] = useState('')
  const [historyFilter, setHistoryFilter] = useState('all')
  const file = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const active = jobs.filter(j => ['queued', 'running'].includes(j.state))
  const activeKey = active.map(j => j.id).join(',')
  function select(m: Media) { setCurrent(m); setFormat('best'); setPreview(null); setError(''); }
  function merge(next: Job) { setJobs(old => [next, ...old.filter(j => j.id !== next.id)]); }
  async function refresh() {
    const data = await api<{ items: Media[]; jobs: Job[]; ffmpeg: boolean; ffprobe: boolean }>('')
    setItems(data.items); setJobs(data.jobs); setTools(data)
    setCurrent(chosen => data.items.find(m => m.id === chosen?.id) || data.items[0] || null)
    await useWorkspaceStore.getState().hydrate()
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [])
  useEffect(() => {
    if (!activeKey) return
    let mounted = true
    const timer = setInterval(() => {
      void Promise.all(activeKey.split(',').map(id => api<Job>(`/jobs/${id}`))).then(next => {
        if (!mounted) return
        setJobs(old => [...next, ...old.filter(j => !next.some(n => n.id === j.id))])
      }).catch(() => { if (mounted) setNotice('连接暂时中断，正在重新获取任务状态…'); })
    }, 1300)
    return () => { mounted = false; clearInterval(timer); }
  }, [activeKey])
  useEffect(() => {
    const previous = jobs.filter(j => j.media_id === current?.id && j.kind === 'video').sort((a,b) => b.created_at.localeCompare(a.created_at))[0]
    setFormat(previous?.format_id || 'best')
  }, [current?.id])
  async function resolve() {
    if (busy) return
    if (!input.trim()) { setError('先粘贴一条视频链接，再开始解析。'); inputRef.current?.focus(); return; }
    setBusy(true); setError(''); setNotice('')
    try {
      const m = await api<Media>('/resolve', { raw_input: input })
      select(m); await refresh()
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function localFile(picked?: File) {
    if (!picked) return
    setBusy(true); setError('')
    try {
      const imported = await importLocalFile(picked)
      useWorkspaceStore.getState().addMaterial(imported.material, imported.capabilities)
      const m = await api<Media>(`/local/${imported.material.id}`, {})
      select(m); await refresh()
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); if (file.current) file.current.value = ''; }
  }
  async function prepare(kind: 'video' | 'mp3') {
    if (!current) return
    setPreparing(kind); setError(''); setNotice('')
    try { merge(await api<Job>(`/${current.id}/prepare`, { kind, format_id: format })); }
    catch (e) { setError((e as Error).message); }
    finally { setPreparing(''); }
  }
  async function openWorkspace() {
    if (current) {
      await useWorkspaceStore.getState().hydrate()
      useWorkspaceStore.getState().setCurrentMaterial(current.id)
    }
  }
  const videoFormats = current?.formats.filter(f => f.video).sort((a, b) => (b.height || 0) - (a.height || 0)) || []
  const recent = items.filter(m => historyFilter === 'all' || (historyFilter === 'local' ? m.local : !m.local))
  const currentJobs = jobs.filter(j => j.media_id === current?.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
  function mediaAction(kind: 'video' | 'mp3') {
    const job = currentJobs.find(j => j.kind === kind && (kind === 'mp3' || j.format_id === format))
    const running = job && ['queued', 'running'].includes(job.state)
    const enabled = current?.formats.some(f => f[kind === 'video' ? 'video' : 'audio'])
    const Icon = kind === 'video' ? Video : AudioLines
    return <div className="media-output" key={kind}>
      <span className={`output-icon ${kind === 'mp3' ? 'audio' : ''}`}><Icon size={21} strokeWidth={1.7} /></span>
      <div className="output-meta"><strong>{kind === 'video' ? '视频文件' : 'MP3 音频'}</strong><small>{job?.state === 'succeeded' ? bytes(job.bytes) : running ? '提取与转换中…' : kind === 'mp3' ? '192 kbps · 独立音频' : '保留画面与声音'}</small></div>
      {job?.state === 'succeeded' ? <a className="save-button" href={job.download_url} download><Download size={15} /> 下载</a> : <button className="prepare-button" disabled={!enabled || !!running || !!preparing || (kind === 'mp3' && (!tools.ffmpeg || !tools.ffprobe))} onClick={() => void prepare(kind)}>{running || preparing === kind ? <LoaderCircle className="icon-spin" size={15} /> : <Plus size={15} />}{running ? '准备中' : kind === 'video' ? '准备视频' : '准备 MP3'}</button>}
      {job && <div className={`job-detail ${job.state}`} role="status"><span>{job.stage}</span>{running ? <button onClick={() => { void api<Job>(`/jobs/${job.id}/cancel`, {}).then(merge).catch(e => setError(e.message)); }}>取消</button> : job.state === 'succeeded' ? <><button onClick={() => setPreview(preview?.id === job.id ? null : job)}>预览</button><button onClick={() => void prepare(kind)}>重新准备</button></> : null}</div>}
    </div>
  }
  return <main className="extract-page">
    <div className="extract-wrap">
      <div className="page-intro"><div><div className="intro-kicker"><span /> 从信息，到灵感</div><h1>把视频，变成<span>你的知识。</span></h1><p>提取视频与音频，整理笔记，让好内容真正为你所用。</p></div><span className="local-status"><span /> 本地工作空间</span></div>
      <div className="tool-tabs" role="navigation" aria-label="工具选择"><span className="selected"><Link2 size={18} /> 链接提取</span><button disabled={busy} onClick={() => file.current?.click()}><Upload size={18} /> 本地文件</button><Link to="/workspace"><FileText size={18} /> 视频笔记 <span className="new-tag">AI</span></Link></div>
      <section className="extractor" aria-label="素材提取工作区">
        <div className="source-pane"><div className="pane-label"><span><Link2 size={16} /> 视频链接</span><span className="subtle-tag">自动识别平台</span></div>
          <textarea ref={inputRef} aria-label="视频链接或分享文字" placeholder={'粘贴视频链接或分享文字\n让值得收藏的内容，触手可及。'} value={input} disabled={busy} onChange={e => setInput(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void resolve(); } }} />
          <div className="source-helper"><span>Bilibili</span><i /> <span>YouTube</span><i /><span>抖音</span><span className="more-platforms">等平台</span></div>
          <div className="input-toolbar"><button className="plain-button" disabled={busy} onClick={() => { setInput(''); setError(''); inputRef.current?.focus(); }}><X size={15} /> 清空</button><div><span className="shortcut">Ctrl + Enter</span><button className="resolve-button" disabled={busy} onClick={() => void resolve()}>{busy ? <LoaderCircle size={17} className="icon-spin" /> : <Sparkles size={17} />}{busy ? '正在解析…' : '开始解析'}{!busy && <ArrowRight size={17} />}</button></div></div>
        </div>
        <div className="result-pane"><div className="pane-label"><span><FolderOpen size={16} /> 提取结果</span>{current ? <span className="ready-label"><CheckCircle2 size={13} /> 已解析</span> : <span className="subtle-tag">等待解析</span>}</div>
          {current ? <div className="result-content"><div className="result-title"><span className="platform-badge">{platforms[current.platform] || current.platform}</span><h2>{current.title}</h2><p>{current.author || '作者未知'}<i />{duration(current.duration)}</p></div>
            {videoFormats.length > 0 && <label className="quality-select">视频清晰度<div><select aria-label="视频清晰度" value={format} onChange={e => setFormat(e.target.value)}><option value="best">最佳可用画质</option>{videoFormats.map(f => <option key={f.id} value={f.id}>{f.height ? f.height + 'p' : '原始画质'} · {f.ext.toUpperCase()} · {f.id}</option>)}</select><ChevronDown size={13} /></div></label>}
            <div className="output-list">{mediaAction('video')}{mediaAction('mp3')}</div>
            {preview && <div className="inline-preview">{preview.kind === 'mp3' ? <audio src={preview.download_url + '?inline=1'} controls /> : <video src={preview.download_url + '?inline=1'} controls />}<button onClick={() => setPreview(null)}>关闭预览</button></div>}
            <Link className="note-link" to={`/workspace?m=${current.id}`} onClick={() => void openWorkspace()}>继续整理为笔记 <ArrowUpRight size={14} /></Link>
          </div> : <div className="empty-result"><div className="empty-visual"><Suspense fallback={null}><GlassArt /></Suspense><div className="floating-play"><MonitorPlay size={34} strokeWidth={1.3} /></div><span className="floating-audio"><AudioLines size={21} /></span><span className="tiny-spark">✦</span></div><h2>好内容，等你来发现</h2><p>粘贴链接后，视频与音频会出现在这里</p><div className="empty-chips"><span><Video size={13} /> 视频</span><span><AudioLines size={13} /> MP3 音频</span></div></div>}
        </div>
      </section>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭提示" onClick={() => setError('')}><X size={16} /></button></div>}
      {notice && <p className="muted-notice" role="status">{notice}</p>}
      {(!tools.ffmpeg || !tools.ffprobe) && <p className="error-banner">未检测到 FFmpeg / ffprobe。请安装并加入 PATH 后重新启动，才能转换 MP3 与合并视频。</p>}
      <div className="privacy-line"><ShieldCheck size={14} /><span>解析只读取视频信息。点击准备后才提取文件，由你手动下载保存。</span><span className="privacy-right">无需账号 · 本地运行</span></div>
      <div className="feature-grid">
        <MotionCard><span className="feature-icon"><Video size={21} strokeWidth={1.6} /></span><div><h3>画面与声音，各取所需</h3><p>保留完整视频，或单独提取 MP3 音频。</p></div><span className="feature-number">01</span></MotionCard>
        <MotionCard><span className="feature-icon"><FileText size={21} strokeWidth={1.6} /></span><div><h3>从内容，到清晰的笔记</h3><p>转写原文、生成笔记，连成一张知识地图。</p></div><span className="feature-number">02</span></MotionCard>
        <MotionCard><span className="feature-icon"><Sparkles size={21} strokeWidth={1.6} /></span><div><h3>带着问题，深入一点</h3><p>连接你的 AI 模型，与素材展开对话。</p></div><span className="feature-number">03</span></MotionCard>
      </div>
      <section className="recent-section"><div className="section-heading"><h2><Clock3 size={17} /> 最近解析 <span>{items.length.toString().padStart(2, '0')}</span></h2><div className="history-tabs">{[['all', '全部'], ['local', '本地'], ['link', '链接']].map(([key, label]) => <button className={historyFilter === key ? 'active' : ''} key={key} onClick={() => setHistoryFilter(key)}>{label}</button>)}</div></div>
        {recent.length ? <div className="history-list">{recent.map(m => <button className={`history-row ${current?.id === m.id ? 'active' : ''}`} key={m.id} onClick={() => { select(m); document.querySelector('.extract-page')?.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }}><span className="history-icon"><MonitorPlay size={19} /></span><div><strong>{m.title}</strong><small>{platforms[m.platform] || m.platform} · {duration(m.duration)} · {new Date(m.created_at).toLocaleDateString('zh-CN')}</small></div><span className="history-state">{jobs.some(j => j.media_id === m.id && j.state === 'succeeded') ? '文件已就绪' : '已解析'}</span><ArrowUpRight size={16} /></button>)}</div> : <div className="empty-history"><FolderOpen size={23} strokeWidth={1.4} /><div><strong>{items.length ? '还没有这类素材' : '这里会留下你的灵感足迹'}</strong><p>{items.length ? '试试其他分类，或导入一份新素材。' : '开始第一次解析，最近的内容会自动整理在这里。'}</p></div><button className="plain-button" onClick={() => inputRef.current?.focus()}>解析第一条链接 <ArrowRight size={14} /></button></div>}
      </section>
      <footer className="extract-footer"><span>Ynote <i /> 为每一次好奇，留一份笔记。</span><button className="plain-button" onClick={() => { void navigator.clipboard.writeText(location.origin).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => setNotice('当前浏览器无法复制，可直接复制地址栏中的链接。')); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制地址' : '复制本地地址'}</button></footer>
    </div><input ref={file} type="file" accept="video/*,audio/*,.mp4,.mkv,.webm,.mp3,.wav,.m4a" hidden onChange={e => void localFile(e.target.files?.[0])} />
  </main>
}
