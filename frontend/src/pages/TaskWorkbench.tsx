import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AudioLines, Check, ChevronDown, ChevronRight, Clipboard, Copy, Download, FileVideo, History, Image as ImageIcon, Layers, Link2, LoaderCircle, NotebookPen, Plus, Search, SquarePen, Trash2, Upload, Video, X, Zap } from 'lucide-react'
import { importLocalFile, createExport, createNote } from '../api/materials'
import { InlineMindmap } from '../components/InlineMindmap'
import { AINotePanel } from '../components/AINotePanel'
import { TranscriptPreview } from '../components/TranscriptPreview'
import { ResultImageGallery } from '../components/ResultImageGallery'
import { ExtractionButtons } from '../components/ExtractionButtons'
import { FirstUseButton } from '../components/FirstUseSetup'
import { transcriptParagraph } from '../utils/transcriptParagraph'
import type { Asset, Material, NoteVersion, Job, Segment, ExtractionMode } from '../api/types'
import { requestTask as api, startTaskInCurrentSource, resolveTaskInCurrentSource } from '../api/tasks'
import { QuotaSummary } from '../components/QuotaPanel'
import { localMediaUrl, getTaskSourceVersion } from '../api/companion'
import './extract.css'
import './task-workbench.css'
import { browserLocal } from '../browser/mode'
import { BrowserStatus } from '../browser/BrowserSettings'
import { cancelBrowserTasks } from '../browser/adapter'
import { toSimplified } from '../utils/simplified'
import { useModelStates } from '../browser/ModelPreparation'
import { modelReady } from '../browser/modelState'
import { requestSetup } from '../browser/setupFlow'
import { checkRequiredModels } from '../browser/preparation'

type Task = { id: string; title: string; raw_input: string; source_id: string | null; material_id: string | null; state: string; stage: string; created_at: string; batch_id?: string; batch_index?: number; extraction_mode?: ExtractionMode }
type Detail = { task: Task; material: Material | null; media: { description?: string; local?: boolean } | null; assets: Asset[]; transcript: { version: { id: string }; segments: Segment[] } | null; note: NoteVersion | null; result_job: Job | null }
type Row = { id: string; input: string; sourceId: string | null; taskId?: string }
const ACTIVE = ['running', 'queued']
const labels: Record<string, string> = { draft: '待开始', queued: '排队中', running: '提取中', succeeded: '提取完成', partial: '部分完成', failed: '提取失败', cancelled: '已取消', interrupted: '已暂停' }
const platforms: Record<string, string> = { bilibili: '哔哩哔哩', youtube: 'YouTube', douyin: '抖音', local: '本地文件', other: '视频平台' }
const row = (): Row => ({ id: crypto.randomUUID(), input: '', sourceId: null })
const initialRows = () => [row(), row(), row()]
// Keep only an unsubmitted link/text draft across a source switch, never private IDs/files.
let unsubmittedInput: string | null = null
const chinese = (n: number) => ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n - 1] || String(n)
const fmtBytes = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const assetUrl = (a: Asset, save = false) => localMediaUrl(`/api/assets/${a.id}/download${save ? '?attachment=1' : ''}`)

function CopyButton({ text, label = '复制内容' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  return <><button className="card-action" disabled={!text} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setError(''); setTimeout(() => setCopied(false), 1600); }).catch(() => setError('复制未成功，请手动选择文字复制')); }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : label}</button>{error && <span className="copy-error" role="status">{error}</span>}</>
}

function Results({ detail, onRefresh, compact = false }: { detail: Detail; onRefresh: () => void; compact?: boolean }) {
  useModelStates()
  const [error, setError] = useState('')
  const [textBusy, setTextBusy] = useState(false)
  const [noteBusy, setNoteBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [note, setNote] = useState<NoteVersion | null>(detail.note)
  useEffect(() => setNote(detail.note), [detail.note?.id])
  const { task, material, assets, transcript } = detail
  const active = ACTIVE.includes(task.state)
  const textRunning = !!detail.result_job && ACTIVE.includes(detail.result_job.state)
  const cover = assets.find(a => a.kind === 'cover' && material?.cover_url?.includes(a.id)) || assets.find(a => a.kind === 'cover')
  const videos = assets.filter(a => a.kind === 'video')
  const audios = assets.filter(a => a.kind === 'audio')
  const images = cover ? [cover] : []
  const text = toSimplified(transcriptParagraph(transcript?.segments ?? []))
  const transcriptOp = detail.result_job?.operations.find(o => o.kind === 'transcript')
  async function exportAll() {
    if (!material) return
    setExporting(true); setError('')
    try { const r = await createExport(material.id, { scope: 'full_package', format: 'zip' }); const a = document.createElement('a'); a.href = r.download_url; a.download = `${material.title}.zip`; a.click(); }
    catch (e) { setError((e as Error).message); }
    finally { setExporting(false); }
  }
  async function transcribe() {
    if (browserLocal() && !await checkRequiredModels(['asr'])) { requestSetup({kinds:['asr'],continueTask:performTranscribe,taskKey:task.id+':transcribe'}); return }
    await performTranscribe()
  }
  async function performTranscribe() {
    setTextBusy(true); setError('')
    try { await api(`/${task.id}/transcript`, {}); onRefresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setTextBusy(false); }
  }
  async function makeNote() {
    if (browserLocal() && !await checkRequiredModels(['text'])) { requestSetup({kinds:['text'],continueTask:performMakeNote,taskKey:task.id+':note'}); return }
    await performMakeNote()
  }
  async function performMakeNote() {
    if (!material || !transcript) return
    setNoteBusy(true); setError('')
    try { const r = await createNote(material.id, { transcript_version_id: transcript.version.id }); setNote(r.note); onRefresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setNoteBusy(false); }
  }
  return <div className={`task-results ${compact ? 'embedded-results' : ''}`}>
    {!compact && <section className="result-summary result-box"><div className="summary-cover">{cover ? <img src={assetUrl(cover)} alt="视频封面" /> : <FileVideo size={34} strokeWidth={1.2} />}</div><div className="summary-info"><div className="summary-title"><h2>{material?.title || task.title}</h2><span className={`task-badge ${task.state}`}>{labels[task.state]}</span></div><div className="summary-grid"><span>任务 ID：<code>{task.id}</code></span><span>平台：{material ? platforms[material.platform] || material.platform : '正在识别'}</span><span>类型：{material?.content_type === 'audio' ? '音频' : '视频'}</span><span>{material?.author ? `作者：${material.author}` : task.stage}</span></div><button className="card-action" disabled={!assets.length || exporting} onClick={() => void exportAll()}>{exporting ? <LoaderCircle size={14} className="icon-spin" /> : <Download size={14} />}导出资料包</button></div></section>}
    <AINotePanel markdown={note?.markdown ?? ''} title={material?.title || task.title} sourceUrl={material?.source_url} busy={noteBusy} label={browserLocal() ? '原文要点摘录' : undefined} canGenerate={!!text && !active} onGenerate={() => void makeNote()} />
    {browserLocal() && !modelReady('text') && <p className="input-hint">笔记模型尚未启用；转写和原文资料包导出仍可独立使用。已有摘录可继续查看及导出。</p>}
    <InlineMindmap markdown={note?.markdown ?? ''} />
    {error && <div className="task-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
    <section className="result-box"><div className="result-box-heading"><h3><NotebookPen size={20} /> 提取的文案</h3><div className="result-actions"><CopyButton text={text} label="复制文案" /><button className="card-action" disabled={!material || active || textBusy || textRunning} onClick={() => void transcribe()}>{textBusy || textRunning ? <LoaderCircle size={14} className="icon-spin" /> : <Zap size={14} />}{textRunning ? '正在获取' : text ? '重新获取' : '获取文案'}</button></div></div>
      {browserLocal() && text && <p className="input-hint">简体显示 · 仅转换字形，未纠错；原始识别文字单独保留在资料包。</p>}
      {textRunning && detail.result_job?.asr_progress && <p role="status" className="input-hint">本地 medium 已处理 {Math.floor(detail.result_job.asr_progress.processed_ms / 1000)} / {Math.ceil(detail.result_job.asr_progress.duration_ms / 1000)} 秒</p>}
      {text ? <TranscriptPreview key={transcript?.version.id} text={text} /> : <div className="no-content text-surface"><p>{active ? (browserLocal() ? '正在浏览器本地识别音轨。' : '正在获取文案；有可用字幕时优先使用字幕。') : transcriptOp?.stage && transcriptOp.state !== 'succeeded' ? transcriptOp.stage : (browserLocal() ? '尚无文案。请在设置中确认模型下载；不清晰音频可能无法识别。' : '还没有文案。可在设置中配置转写 API 后获取。')}</p>{!active && <Link to="/settings">{browserLocal() ? '本地计算设置' : '配置转写服务'} <ChevronRight size={13} /></Link>}</div>}
    </section>
    <section className="result-box"><div className="result-box-heading"><h3><Video size={20} /> 视频内容 <span>{videos.length ? `(${videos.length})` : ''}</span></h3>{videos[0] && <a className="card-action" href={assetUrl(videos[0], true)} download><Download size={14} />下载视频</a>}</div>{videos.length ? <div className="video-assets">{videos.map(a => <div className="video-asset" key={a.id}><video controls preload="metadata" src={assetUrl(a)} poster={cover ? assetUrl(cover) : undefined} /><div><span>{fmtBytes(a.bytes)}</span><a href={assetUrl(a, true)} download><Download size={14} />下载视频</a></div></div>)}</div> : <div className="asset-empty">{active ? <><LoaderCircle size={17} className="icon-spin" />正在提取视频…</> : (browserLocal() ? '本任务没有视频资产；本地模式仅处理语音。' : '暂无可用视频，请检查任务状态或重试提取。')}</div>}</section>
    <section className="result-box"><div className="result-box-heading"><h3><AudioLines size={20} /> 音频内容</h3>{audios[0] && <a className="card-action" href={assetUrl(audios[0], true)} download><Download size={14} />{browserLocal() ? '下载原始音频' : '下载 MP3'}</a>}</div>{audios.length ? audios.map(a => <div className="audio-asset" key={a.id}><audio controls preload="metadata" src={assetUrl(a)} /><span>{browserLocal() ? '原始音频' : 'MP3'} · {fmtBytes(a.bytes)}</span></div>) : <div className="asset-empty">{active ? <><LoaderCircle size={17} className="icon-spin" />正在提取音频…</> : (browserLocal() ? '音轨用于浏览器内转写；尚未提供单独的音频转码导出。' : '暂无 MP3 音频。')}</div>}</section>
    <section className="result-box"><div className="result-box-heading"><h3><ImageIcon size={20} /> 图片内容 <span>({images.length})</span></h3>{images.length > 0 && <button className="card-action" onClick={() => void exportAll()} disabled={exporting}><Download size={14} />打包导出</button>}</div>{images.length ? <ResultImageGallery assets={images} urlFor={assetUrl} /> : <div className="asset-empty">{active ? '正在提取视频封面…' : (browserLocal() ? '本地模式不提取画面或封面。' : '暂无可用视频封面。')}</div>}</section>

  </div>
}

function BatchResult({ task }: { task: Task }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const refresh = () => { void api<Detail>(`/${task.id}`).then(setDetail).catch(e => setError(e.message)); }
  const textJobKey = detail?.result_job && ACTIVE.includes(detail.result_job.state) ? detail.result_job.id : ''
  useEffect(() => { refresh(); if (!open || (!ACTIVE.includes(task.state) && !textJobKey)) return; const timer = setInterval(refresh, 1800); return () => clearInterval(timer); }, [task.id, task.state, open, textJobKey])
  const video = detail?.assets.find(a => a.kind === 'video'), audio = detail?.assets.find(a => a.kind === 'audio' && a.relative_path.endsWith('.mp3'))
  return <section className={`batch-result-block ${open ? 'is-open' : ''}`}><div className="batch-result-header"><span className="batch-result-index">{String(task.batch_index || 1).padStart(2, '0')}</span><div><h3>任务{chinese(task.batch_index || 1)}结果 <span className={`task-badge ${task.state}`}>{labels[task.state]}</span></h3><p>{task.title === '待提取链接' ? task.raw_input : task.title}</p></div><button className="card-action" onClick={() => setOpen(!open)}>{open ? '收起详情' : '查看详情'}<ChevronDown size={14} className={open ? 'rotated' : ''} /></button></div><div className="batch-result-bottom"><span>{task.stage}</span><div>{video && <a href={assetUrl(video, true)} download><Video size={14} />视频</a>}{audio && <a href={assetUrl(audio, true)} download><AudioLines size={14} />MP3</a>}</div></div>{error && <p className="task-error">{error}</p>}{open && (detail ? <Results detail={detail} onRefresh={refresh} compact /> : <div className="asset-empty">正在读取结果…</div>)}</section>
}

export function TaskWorkbench({resetSourceSelection=false,onSourceResetHandled}:{resetSourceSelection?:boolean;onSourceResetHandled?:()=>void} = {}) {
  useModelStates()
  const [searchParams, setSearchParams] = useSearchParams()
  const [tasks, setTasks] = useState<Task[]>([])
  const [selected, setSelected] = useState<string | null>(()=>resetSourceSelection?null:searchParams.get('task'))
  const [batchId, setBatchId] = useState<string | null>(()=>resetSourceSelection?null:searchParams.get('batch'))
  const [mode, setMode] = useState<'single' | 'batch'>(()=>!resetSourceSelection&&searchParams.has('batch')?'batch':'single')
  const [rows, setRows] = useState<Row[]>(initialRows)
  const [input, setInput] = useState(()=>unsubmittedInput || '')
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [requestedMode, setRequestedMode] = useState<ExtractionMode>('quick')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [dragging, setDragging] = useState(false)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const file = useRef<HTMLInputElement>(null)
  const fileRow = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const dragDepth = useRef(0)
  const startChecking = useRef(false)
  const selectedTask = tasks.find(t => t.id === selected) || detail?.task
  useEffect(()=>{unsubmittedInput=null;if(resetSourceSelection)onSourceResetHandled?.()},[])
  useEffect(()=>{
    const preserve=()=>{unsubmittedInput=(!selected || selectedTask?.state==='draft') && !sourceId ? input : null}
    window.addEventListener('ynote:preserve-unsubmitted-input',preserve)
    return()=>window.removeEventListener('ynote:preserve-unsubmitted-input',preserve)
  },[selected,selectedTask?.state,sourceId,input])
  const active = !!selectedTask && ACTIVE.includes(selectedTask.state)
  const locked = !!selectedTask && selectedTask.state !== 'draft'
  const activeKey = tasks.filter(t => ACTIVE.includes(t.state)).map(t => t.id).join(',')
  const textKey = detail?.result_job && ACTIVE.includes(detail.result_job.state) ? detail.result_job.id : ''
  const refreshHistory = async () => { const data = await api<{ tasks: Task[] }>(''); setTasks(data.tasks); return data.tasks; }
  const refreshDetail = () => { const id = selected; if (id) void api<Detail>(`/${id}`).then(d => { if (selectedRef.current === id) setDetail(d); }).catch(e => { if (selectedRef.current === id) setError(e.message); }); }
  useEffect(() => { let live=true;const owner=getTaskSourceVersion();void refreshHistory().then(list => { if(!live||getTaskSourceVersion()!==owner||selectedRef.current!==selected)return;const task=list.find(t=>t.id===selected);if(selected&&!task){selectedRef.current=null;setSelected(null);setDetail(null);setSourceId(null);setSearchParams({});setError('')}else if(task){setInput(task.raw_input);setSourceId(task.source_id)}if(batchId){const group=list.filter(t=>t.batch_id===batchId);if(!group.length){setBatchId(null);setRows(initialRows());setSearchParams({})}else setRows(group.sort((a,b)=>(a.batch_index||0)-(b.batch_index||0)).map(t=>({id:t.id,input:t.raw_input,sourceId:t.source_id,taskId:t.id})))}}).catch(e=>{if(live&&getTaskSourceVersion()===owner)setError(e.message)}).finally(()=>{if(live)setLoading(false)});return()=>{live=false} }, [])
  useEffect(() => { let live=true;if(loading||!selected){if(!selected)setDetail(null);return}const owner=getTaskSourceVersion();const load=()=>{void api<Detail>(`/${selected}`).then(d=>{if(live&&selectedRef.current===selected&&getTaskSourceVersion()===owner)setDetail(d)}).catch(e=>{if(live&&selectedRef.current===selected&&getTaskSourceVersion()===owner)setError(e.message)})};load();const timer=activeKey||textKey?setInterval(load,1600):null;return()=>{live=false;if(timer)clearInterval(timer)} },[selected,activeKey,textKey,loading])
  useEffect(() => { if (!activeKey) return; const timer = setInterval(() => { void refreshHistory().catch(() => {}); }, 1600); return () => clearInterval(timer); }, [activeKey])
  useEffect(() => { if (!selected || selectedTask?.state !== 'draft' || busy) return; const timer = setTimeout(() => { void api<Task>(`/${selected}/input`, { raw_input: input, source_id: sourceId }, 'PUT').catch(e => setError(e.message)); }, 700); return () => clearTimeout(timer); }, [selected, input, sourceId, selectedTask?.state, busy])
  async function saveDraft() { if (selected && selectedTask?.state === 'draft') await api(`/${selected}/input`, { raw_input: input, source_id: sourceId }, 'PUT'); }
  async function newTask() {
    if (busy) return
    if (browserLocal()) await cancelBrowserTasks()
    setBusy('create'); setError('')
    try { await saveDraft(); const task = await api<Task>('', {}); setTasks(old => [task, ...old]); setSelected(task.id); setInput(''); setSourceId(null); setDetail(null); setMode('single'); setBatchId(null); setSearchParams({ task: task.id }); scrollRef.current?.scrollTo(0, 0); inputRef.current?.focus(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }
  async function selectTask(task: Task) {
    if (busy) return
    if (browserLocal()) await cancelBrowserTasks()
    try { await saveDraft(); setError(''); setDetail(null); scrollRef.current?.scrollTo(0, 0); if (task.batch_id) { setMode('batch'); setBatchId(task.batch_id); setSelected(null); setRows(tasks.filter(t => t.batch_id === task.batch_id).sort((a, b) => (a.batch_index || 0) - (b.batch_index || 0)).map(t => ({ id: t.id, input: t.raw_input, sourceId: t.source_id, taskId: t.id }))); setSearchParams({ batch: task.batch_id }); } else { setMode('single'); setBatchId(null); setSelected(task.id); setInput(task.raw_input); setSourceId(task.source_id); setSearchParams({ task: task.id }); } }
    catch (e) { setError((e as Error).message); }
  }
  async function newBatch() { if (busy) return; if (browserLocal()) { setError('浏览器本地模式目前只处理单个文件，批量流程尚未验证。'); return; } try { await saveDraft(); setMode('batch'); setBatchId(null); setRows(initialRows()); setSelected(null); setDetail(null); setError(''); setSearchParams({}); scrollRef.current?.scrollTo(0, 0); } catch (e) { setError((e as Error).message); } }
  async function paste(target?: string) {
    setError('')
    try { const text = await navigator.clipboard.readText(); if (!text.trim()) throw new Error('剪贴板里没有文字，请先复制视频链接。'); if (target) setRows(old => old.map(r => r.id === target ? { ...r, input: text, sourceId: null } : r)); else { setInput(text); setSourceId(null); inputRef.current?.focus(); } }
    catch (e) { setError((e as Error).message.includes('剪贴板里') ? (e as Error).message : '浏览器未允许读取剪贴板，请在输入栏按 Ctrl+V 粘贴。'); inputRef.current?.focus(); }
  }
  async function importVideo(picked?: File, target?: string | null) {
    if (!picked || busy) return
    if (!/\.(mp4|mov|mkv|webm|avi|m4v|wav|mp3|m4a|ogg|flac|aac)$/i.test(picked.name) && !/^(audio|video)\//.test(picked.type)) { setError('请选择本地音频或视频文件。'); return; }
    if (browserLocal()) await cancelBrowserTasks()
    setBusy('import'); setError('')
    try { const result = await importLocalFile(picked); if (target) setRows(old => old.map(r => r.id === target ? { ...r, input: picked.name, sourceId: result.material.id } : r)); else {const owner=getTaskSourceVersion();const id=await resolveTaskInCurrentSource<Task>(locked?null:selected,{raw_input:picked.name,source_id:result.material.id},draft=>{if(getTaskSourceVersion()!==owner)return;setTasks(old=>[draft,...old.filter(t=>t.id!==draft.id)])});if(getTaskSourceVersion()!==owner)return;setSelected(id);setSearchParams({task:id});setSourceId(result.material.id);setInput(picked.name);await api(`/${id}/input`,{raw_input:picked.name,source_id:result.material.id},'PUT');await refreshHistory();} }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); if (file.current) file.current.value = ''; }
  }
  function chooseFile(target?: string) { fileRow.current = target || null; file.current?.click(); }
  async function start(extractionMode: ExtractionMode) {
    if (startChecking.current || busy || active) return
    if (browserLocal() && !sourceId) { setError('请选择本地音视频文件；本地模式不解析分享链接，也不会使用服务器中转。'); return }
    startChecking.current = true
    setRequestedMode(extractionMode)
    try {
      if (browserLocal() && !await checkRequiredModels(['asr'])) { requestSetup({kinds:['asr'],continueTask:()=>performStart(extractionMode),taskKey:selected || sourceId || input}); return }
      await performStart(extractionMode)
    } catch (e) { setError((e as Error).message) }
    finally { startChecking.current = false }
  }
  async function performStart(extractionMode: ExtractionMode) {
    if (busy || active) return
    if (!input.trim() && !sourceId) { setError('请粘贴链接或导入本地视频。'); inputRef.current?.focus(); return; }
    setBusy('start'); setError('')
    try { const owner=getTaskSourceVersion();const task=await startTaskInCurrentSource<Task>(selected,{raw_input:input,source_id:sourceId,extraction_mode:extractionMode},draft=>{if(getTaskSourceVersion()!==owner)return;setSelected(draft.id);setDetail(null);setTasks(old=>[draft,...old.filter(t=>t.id!==draft.id)]);setSearchParams({task:draft.id})});if(getTaskSourceVersion()!==owner)return;setSelected(task.id);setSearchParams({task:task.id});setTasks(old=>[task,...old.filter(t=>t.id!==task.id)]); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }
  async function startBatch(extractionMode: ExtractionMode) {
    if (busy) return
    const entries = rows.filter(r => !r.taskId && (r.input.trim() || r.sourceId))
    if (!entries.length) { setError('请至少填写一个链接或导入一个视频；空白栏会自动跳过。'); return; }
    setRequestedMode(extractionMode);setBusy('batch'); setError('')
    try { const result = await api<{ batch_id: string; tasks: Task[] }>('/batch', { batch_id: batchId, extraction_mode: extractionMode, entries: entries.map(r => ({ raw_input: r.input, source_id: r.sourceId })) }); setBatchId(result.batch_id); setSearchParams({ batch: result.batch_id }); const submitted = new Map(entries.map((entry, index) => [entry.id, result.tasks[index].id])); setRows(old => old.map(r => submitted.has(r.id) ? { ...r, taskId: submitted.get(r.id) } : r)); await refreshHistory(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }
  function drag(e: DragEvent<HTMLElement>) { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); if (e.type === 'dragenter') { dragDepth.current++; setDragging(true); } if (e.type === 'dragleave') { dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); } } }
  function drop(e: DragEvent<HTMLElement>) { e.preventDefault(); dragDepth.current = 0; setDragging(false); if (mode === 'batch') { const target = rows.find(r => !r.taskId && !r.input); if (target) void importVideo(e.dataTransfer.files[0], target.id); else setError('请先新建一个空白栏，再拖入视频。'); } else void importVideo(e.dataTransfer.files[0]); }
  const history = tasks.filter(t => !search || `${t.title} ${t.raw_input}`.toLowerCase().includes(search.toLowerCase())).filter((t, i, all) => !t.batch_id || all.findIndex(x => x.batch_id === t.batch_id) === i)
  const batchTasks = tasks.filter(t => t.batch_id === batchId && batchId).sort((a, b) => (a.batch_index || 0) - (b.batch_index || 0))
  const activeBatchTasks = batchTasks.filter(task=>ACTIVE.includes(task.state))
  const batchMode: ExtractionMode | 'unknown' | null = !activeBatchTasks.length ? null : activeBatchTasks.every(task=>task.extraction_mode==='quick') ? 'quick' : activeBatchTasks.every(task=>task.extraction_mode==='precise') ? 'precise' : 'unknown'
  return <div className="task-shell"><aside className="task-sidebar"><div className="sidebar-actions"><button className={`new-task-button ${mode === 'single' && !locked ? 'active' : ''}`} disabled={!!busy} onClick={() => void newTask()}><SquarePen size={18} />新任务<Plus size={15} /></button><button className={`batch-nav ${mode === 'batch' ? 'active' : ''}`} disabled={!!busy} onClick={() => void newBatch()}><Layers size={18} />批量提取<ChevronRight size={15} /></button></div><div className="history-label"><History size={15} />历史提取任务<span>{tasks.length}</span></div><div className="sidebar-search"><Search size={14} /><input aria-label="搜索历史任务" placeholder="搜索任务" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="task-history">{loading ? <div className="history-placeholder">正在读取任务…</div> : history.length ? history.map(t => { const group = t.batch_id ? tasks.filter(x => x.batch_id === t.batch_id) : [t]; const running = group.some(x => ACTIVE.includes(x.state)); return <button key={t.batch_id || t.id} className={`history-task ${(mode === 'single' && selected === t.id) || (mode === 'batch' && batchId && t.batch_id === batchId) ? 'selected' : ''}`} disabled={!!busy} onClick={() => void selectTask(t)}><span className="history-task-icon">{running ? <LoaderCircle size={16} className="icon-spin" /> : t.batch_id ? <Layers size={16} /> : <FileVideo size={16} />}</span><div><strong>{t.batch_id ? `批量任务 · ${group.length} 个素材` : t.title}</strong><span>{new Date(t.created_at).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}<i />{running ? '提取中' : t.batch_id ? `${group.filter(x => ['succeeded', 'partial'].includes(x.state)).length}/${group.length} 已完成` : labels[t.state]}</span></div>{!running && <span className={`status-dot ${t.state}`} />}</button>; }) : <div className="history-placeholder"><History size={22} strokeWidth={1.3} /><p>{search ? '没有找到匹配的任务' : '开始提取后，任务会保存在这里'}</p></div>}</div></aside>
    <main className={`task-main ${dragging ? 'dragging' : ''}`} ref={scrollRef} onDragEnter={drag} onDragLeave={drag} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={drop}>
      <div className="workbench-inner"><div className="workbench-title"><div><h1>{mode === 'batch' ? '批量提取' : '工作台'}</h1></div><FirstUseButton /></div>
        {browserLocal() ? <BrowserStatus /> : <QuotaSummary />}
        {mode === 'batch' ? <section className="batch-input-panel"><div className="batch-input-heading"><div><h2>批量导入素材</h2><p>每个栏放一条链接或一个视频，空白栏会自动跳过。</p></div><div><button className="card-action" disabled={!!busy || rows.length >= 10} onClick={() => setRows(old => [...old, row()])}><Plus size={15} />新建</button><ExtractionButtons disabled={!!busy || !!activeBatchTasks.length} busyMode={busy === 'batch' ? requestedMode : batchMode} onExtract={extractionMode => void startBatch(extractionMode)} /></div></div><div className="batch-rows">{rows.map((r, i) => <div className={`batch-input-row ${r.taskId ? 'submitted' : ''}`} key={r.id} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); dragDepth.current = 0; if (!r.taskId) void importVideo(e.dataTransfer.files[0], r.id); }}><span className="batch-row-index">{String(i + 1).padStart(2, '0')}</span>{r.sourceId ? <FileVideo size={17} /> : <Link2 size={17} />}<input aria-label={`任务${i + 1}链接`} placeholder="粘贴视频链接，或导入本地视频" value={r.input} readOnly={!!r.taskId} onChange={e => setRows(old => old.map(x => x.id === r.id ? { ...x, input: e.target.value, sourceId: null } : x))} /><div className="batch-row-tools">{r.taskId ? <span className="submitted-label">已提交</span> : <><button aria-label={`粘贴到任务${i + 1}`} disabled={!!busy} onClick={() => void paste(r.id)}><Clipboard size={16} /><span>粘贴</span></button><button aria-label={`导入视频到任务${i + 1}`} disabled={!!busy} onClick={() => chooseFile(r.id)}><Upload size={16} /><span>导入视频</span></button><button aria-label={`清空任务${i + 1}`} disabled={!!busy} onClick={() => setRows(old => old.map(x => x.id === r.id ? { ...x, input: '', sourceId: null } : x))}><Trash2 size={16} /></button><button aria-label={`移除任务${i + 1}栏`} disabled={!!busy} onClick={() => setRows(old => old.filter(x => x.id !== r.id))}><X size={14} /></button></>}</div></div>)}</div><p className="input-hint">支持链接与本地视频混合提取 · 每组最多 10 个素材</p></section> : <section className="task-input-panel"><div className="task-input-row"><div className="task-input-field">{sourceId ? <FileVideo size={21} /> : <Link2 size={21} />}<textarea ref={inputRef} aria-label="视频链接或本地音视频" rows={1} placeholder="粘贴视频链接或分享文字，或导入本地音视频" value={input} readOnly={locked} onChange={e => { setInput(e.target.value); setSourceId(null); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void start('quick'); } }} /></div><ExtractionButtons disabled={!!busy || active} busyMode={busy === 'start' ? requestedMode : active ? selectedTask?.extraction_mode || 'unknown' : null} onExtract={extractionMode => void start(extractionMode)} /></div><div className="task-input-tools"><button disabled={!!busy || locked} onClick={() => void paste()}><Clipboard size={16} />粘贴</button><button disabled={!!busy || locked} onClick={() => chooseFile()}><Upload size={16} />{busy === 'import' ? '正在导入…' : '导入本地音视频'}</button><button disabled={!!busy || locked} onClick={() => { setInput(''); setSourceId(null); setError(''); inputRef.current?.focus(); }}><Trash2 size={16} />清空</button><span>{sourceId ? '已选择本地视频 · 选择快速或精准提取' : '也可以将本地视频直接拖入工作台'}</span></div></section>}
        {error && <div className="task-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}><X size={16} /></button></div>}
        {mode === 'single' && selectedTask && ACTIVE.includes(selectedTask.state) && <div className="task-progress"><LoaderCircle size={17} className="icon-spin" /><span>{detail?.task.stage || selectedTask.stage}</span><button onClick={() => { void api(`/${selectedTask.id}/cancel`, {}).then(() => refreshHistory()).catch(e => setError(e.message)); }}>取消提取</button></div>}
        {mode === 'single' && selectedTask && ['failed', 'interrupted', 'cancelled'].includes(selectedTask.state) && <div className="task-error">{selectedTask.stage}</div>}
        {mode === 'single' ? detail && detail.task.state !== 'draft' ? <Results key={detail.task.id} detail={detail} onRefresh={refreshDetail} /> : <div className="blank-workbench"><span><FileVideo size={29} strokeWidth={1.3} /></span><h2>把内容放进来，剩下的交给 Ynote</h2><p>粘贴视频链接，或导入本地音视频，点击开始提取。<br />支持单条与批量提取；转写及笔记服务可在设置中配置。</p></div> : batchTasks.length > 0 ? <div className="batch-results"><div className="batch-results-title"><h2>提取结果</h2><span>{batchTasks.filter(t => ['succeeded', 'partial'].includes(t.state)).length} / {batchTasks.length} 已完成</span></div>{batchTasks.map(task => <BatchResult key={task.id} task={task} />)}</div> : <div className="blank-workbench batch-blank"><Layers size={28} strokeWidth={1.3} /><h2>一次导入，分别整理</h2><p>开始提取后，下方会逐项显示“任务一结果、任务二结果……”</p></div>}
      </div>{dragging && <div className="drop-overlay"><Upload size={38} strokeWidth={1.3} /><strong>松开鼠标，导入本地视频</strong><span>原文件不会被修改</span></div>}
    </main><input ref={file} type="file" accept="audio/*,video/*,.wav,.mp3,.m4a,.ogg,.flac,.aac,.mp4,.mov,.mkv,.webm,.avi,.m4v" hidden onChange={e => void importVideo(e.target.files?.[0], fileRow.current)} />
  </div>
}
