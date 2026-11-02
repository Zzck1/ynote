import { useEffect, useState } from 'react'
import { Check, LoaderCircle, Save } from 'lucide-react'
type Preferences = { quality: string; audio_bitrate: string; image_count: number; subtitle_first: boolean; transcribe: boolean; auto_note: boolean; note_style: string; subtitle_language: string }
export function ExtractionPreferences() {
  const [config, setConfig] = useState<Preferences | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void fetch('/api/tasks/preferences').then(r => { if (!r.ok) throw new Error('无法读取提取设置'); return r.json(); }).then(setConfig).catch(e => setError(e.message)); }, [])
  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) { setConfig(c => c ? { ...c, [key]: value } : c); setSaved(false); }
  async function save() {
    setBusy(true); setError('')
    try { const r = await fetch('/api/tasks/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }); const d = await r.json(); if (!r.ok) throw new Error(d.error?.message || '保存失败'); setConfig(d); setSaved(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="preferences-form"><h2>提取与笔记设置</h2><p>保存后对新开始的任务生效，单条与批量任务使用相同设置。</p>{error && <p role="alert" className="task-error">{error}</p>}{config ? <><div className="preferences-grid"><label>视频清晰度<select value={config.quality} onChange={e => update('quality', e.target.value)}><option value="best">最佳可用画质</option>{['1080', '720', '480', '360'].map(q => <option key={q} value={q}>{q}p 及以下最佳画质</option>)}</select></label><label>MP3 音频码率<select value={config.audio_bitrate} onChange={e => update('audio_bitrate', e.target.value)}>{['128', '192', '320'].map(b => <option key={b} value={b}>{b} kbps</option>)}</select></label><label>截图数量<input type="number" min="1" max="9" value={config.image_count} onChange={e => update('image_count', Number(e.target.value))} /></label><label>笔记风格<select value={config.note_style} onChange={e => update('note_style', e.target.value)}><option value="brief">简洁摘要</option><option value="structured">结构化笔记</option><option value="detailed">详细学习笔记</option></select></label><label>优先字幕语言<select value={config.subtitle_language} onChange={e => update('subtitle_language', e.target.value)}><option value="zh">中文优先</option><option value="en">英文优先</option></select></label><label className="preference-toggle"><input type="checkbox" checked={config.subtitle_first} onChange={e => update('subtitle_first', e.target.checked)} />优先读取平台字幕</label><label className="preference-toggle"><input type="checkbox" checked={config.transcribe} onChange={e => update('transcribe', e.target.checked)} />提取文案（无字幕时调用转写 API）</label><label className="preference-toggle"><input type="checkbox" checked={config.auto_note} onChange={e => update('auto_note', e.target.checked)} />文案就绪后自动生成 AI 笔记</label></div><button className="card-action" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle size={15} className="icon-spin" /> : <Save size={15} />}保存提取设置</button>{saved && <span className="preferences-saved"><Check size={12} className="inline mr-1" />已保存</span>}</> : !error && <p>正在读取设置…</p>}</section>
}
