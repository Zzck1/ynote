import type { Asset, Material, NoteVersion, Segment } from '../api/types'
import { zipSync, strToU8 } from 'fflate'
import { infer, stopInference, type Progress, isComputing } from './engine'
import { read, write, recordKeys, removeRecords } from './storage'
import { decodeLocal, MAX_BYTES, timestamp, validateNote } from './media'
import { toSimplified } from '../utils/simplified'
import { modelReady } from './modelState'
import { requireFullSourceCoverage, requireAuditableSource } from './notePlan'
type Task = { id: string; title: string; raw_input: string; source_id: string | null; material_id: string | null; state: string; stage: string; created_at: string }
type Record = { material: Material; file: File; assets: Asset[]; transcript: { version: { id: string }; segments: Segment[] } | null; note: NoteVersion | null }
const tasks = new Map<string, Task>()
const records = new Map<string, Record>()
const urls = new Map<string, string>()
const jobs = new Map<string, { controller: AbortController; token: string }>()
const noteRuns = new Set<AbortController>()
let initialized: Promise<void> | null = null
let leaseHeld = false
let reserved = false
let persistQueue = Promise.resolve()
const uid = () => crypto.randomUUID()
function persist() {
  const snapshot = structuredClone([...tasks.values()])
  const next = persistQueue.then(() => write('tasks', snapshot))
  persistQueue = next.catch(() => {})
  return next
}
async function initialize() {
  if (!initialized) initialized = (async () => {
    if (typeof navigator !== 'undefined' && navigator.locks && !leaseHeld) {
      await new Promise<void>((resolve, reject) => {
        void navigator.locks.request('ynote-browser-workbench-v1', { ifAvailable: true }, async lock => {
          if (!lock) { reject(new Error('另一 Ynote 页面正在使用本地工作台，请先关闭该页面，避免同时占用模型和覆盖历史')); return }
          leaseHeld = true; resolve()
          await new Promise<void>(() => {})
        }).catch(reject)
      })
    }
    for (const task of await read<Task[]>('tasks') ?? []) {
      if (task.state === 'running' || task.state === 'queued') { task.state = 'interrupted'; task.stage = '页面关闭或刷新导致任务中断，请重试；没有自动恢复推理' }
      tasks.set(task.id, task)
    }
    await persist()
  })().catch(e => { initialized = null; throw e })
  return initialized
}
async function record(id: string) {
  if (!records.has(id)) {
    const stored = await read<Record>('material:' + id)
    if (stored) {
      if (stored.note?.provider === 'browser-wasm' && !stored.note.model.includes('auditable-source-coverage-v3')) {
        await write('rejected-note:' + stored.note.id, stored.note)
        stored.note = null
        await write('material:' + id, stored)
      }
      records.set(id, stored)
    }
  }
  const result = records.get(id)
  if (!result) throw new Error('未找到本地文件，请重新导入')
  for (const asset of result.assets) if (!urls.has(asset.id)) urls.set(asset.id, URL.createObjectURL(result.file))
  return result
}
export function browserAssetUrl(path: string) {
  const match = path.match(/^\/api\/assets\/([^/]+)\/download/)
  if (match) return urls.get(match[1]) ?? ''
  return path
}
async function importFile(file: File) {
  if (!file || file.size === 0 || file.size > MAX_BYTES) throw new Error('请选择非空且不超过 64 MiB 的本地音视频')
  if (!/\.(wav|mp3|m4a|ogg|flac|aac|mp4|mov|webm|mkv|m4v)$/i.test(file.name) && !/^(audio|video)\//.test(file.type)) throw new Error('请选择音频或视频文件')
  const id = uid(), created_at = new Date().toISOString()
  const audio = file.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(file.name)
  const material: Material = { id, title: file.name, platform: 'local', external_id: id, part_id: null, source_url: '', author: '', duration: null, content_type: audio ? 'audio' : 'video', cover_url: null, created_at }
  const asset: Asset = { id: uid(), material_id: id, variant_id: null, kind: audio ? 'audio' : 'video', relative_path: file.name, mime: file.type, bytes: file.size, sha256: '', duration: null, origin: 'original' }
  const data: Record = { material, file, assets: [asset], transcript: null, note: null }
  await write('material:' + id, data)
  records.set(id, data); urls.set(asset.id, URL.createObjectURL(file))
  return { material, capabilities: { transcript: { available: true }, audio: { available: audio }, video: { available: !audio }, cover: { available: false, reason: '本地模式仅整理语音' }, images: { available: false, reason: '不分析画面' } } }
}
async function transcribe(task: Task) {
  if (reserved || isComputing() || jobs.size) throw new Error('同一时间仅处理一个本地文件，请等待或取消当前任务')
  if (!task.source_id) throw new Error('本地模式不能直接取得 B站、抖音或小红书分享页的媒体，请选择本地文件；不会使用服务器中转')
  if(!modelReady('asr'))throw new Error('请先下载并启用转写模型；笔记模型可以稍后准备')

  reserved = true
  let data: Record
  try { data = await record(task.source_id) } finally { reserved = false }
  // A pending import/read cannot start a second model.
  if (isComputing() || jobs.size) throw new Error('已有本地任务正在运行')
  const controller = new AbortController(), token = uid()
  jobs.set(task.id, { controller, token })
  task.state = 'running'; task.stage = '浏览器正在解码音轨；不上传文件'; task.material_id = data.material.id
  await persist()
  const current = () => jobs.get(task.id)?.token === token && !controller.signal.aborted
  const update = (p: Progress) => {
    if (!current()) return
    task.stage = p.processed_ms !== undefined ? `${p.stage}：${(p.processed_ms / 1000).toFixed(1)} / ${((p.duration_ms ?? 0) / 1000).toFixed(1)} 秒` : p.stage
    void persist().catch(() => {})
  }
  void (async () => {
    try {
      const { pcm, duration } = await decodeLocal(data.file, controller.signal)
      if (!current()) return
      data.material.duration = duration
      const result = await infer<Array<{ start_ms: number; end_ms: number; text: string; source_chunk?: string }>>('asr', { audio: pcm }, update, controller.signal)
      if (!current()) return
      const version = { id: uid() }
      if(data.transcript)await write('transcript-version:'+data.transcript.version.id,{material_id:data.material.id,transcript:data.transcript},controller.signal)
      if(data.note)await write('note-version:'+data.note.id,{material_id:data.material.id,note:data.note},controller.signal)
      const completed: Record = { ...data, transcript: { version, segments: result.map(s => ({ ...s, id: uid(), transcript_version_id: version.id, source_chunk: s.source_chunk ?? null })) }, note: null }
      await write('material:' + data.material.id, completed, controller.signal)
      if (!current()) return
      Object.assign(data, completed)
      const timingIssue = result.some((s,i) => s.end_ms > duration * 1000 + 20 || (i > 0 && s.start_ms < result[i-1].end_ms))
      task.state = 'succeeded'; task.stage = timingIssue ? '转写已保留，但存在时间戳重叠或越界；未截断原始时间戳，请核对原音频' : result.length ? '本地转写完成；请对照原音频核对后生成笔记' : '处理完成，未识别到语音；未生成笔记'
    } catch (e) {
      if (current()) { task.state = 'failed'; task.stage = e instanceof Error ? e.message : '本地转写失败' }
    } finally {
      if (current()) jobs.delete(task.id)
      await persist()
    }
  })()
  return task
}
function download(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const timer = setTimeout(() => URL.revokeObjectURL(url), 300000)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return url
}
export async function browserRequest(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    await initialize()
    const method = init.method ?? 'GET'
    const body = init.body instanceof FormData ? init.body : typeof init.body === 'string' ? JSON.parse(init.body) : {}
    const p = path.split('?')[0].split('/').filter(Boolean)
    let result: unknown
    if (path === '/api/materials/import' && body instanceof FormData) result = await importFile(body.get('file') as File)
    else if (p[1] === 'tasks') {
      if (p.length === 2) {
        if (method === 'GET') result = { tasks: [...tasks.values()].reverse() }
        else {
          const task: Task = { id: uid(), title: body.raw_input || '新任务', raw_input: body.raw_input || '', source_id: body.source_id || null, material_id: null, state: 'draft', stage: '待开始', created_at: new Date().toISOString() }
          tasks.set(task.id, task); await persist(); result = task
        }
      } else {
        const task = tasks.get(p[2]); if (!task) throw new Error('本地任务不存在')
        if (p[3] === 'input') {
          if (jobs.has(task.id)) throw new Error('请先取消当前任务')
          task.raw_input = body.raw_input; task.source_id = body.source_id; task.title = body.raw_input || '新任务'; await persist(); result = task
        } else if (p[3] === 'start' || p[3] === 'transcript') {
          if (p[3] === 'start') { task.source_id = body.source_id || task.source_id; task.raw_input = body.raw_input || task.raw_input }
          result = await transcribe(task)
        } else if (p[3] === 'cancel') {
          const job = jobs.get(task.id)
          if (job) { job.controller.abort(); jobs.delete(task.id); stopInference() }
          task.state = 'cancelled'; task.stage = '已取消；旧结果不会写回'; await persist(); result = task
        } else {
          const data = task.source_id ? await record(task.source_id) : null
          result = { task, material: data?.material ?? null, media: { local: true }, assets: data?.assets ?? [], transcript: data?.transcript ?? null, note: data?.note ?? null, result_job: null }
        }
      }
    } else if (p[1] === 'materials' && p[2] && p[3] === 'notes' && method === 'POST') {
      const data = await record(p[2])
      if (!data.transcript?.segments.length) throw new Error('没有可用转写文本')
      try { requireAuditableSource(data.transcript.segments,data.material.duration) }
      catch(error) { await write('rejected-note:'+uid(),{material_id:data.material.id,transcript_version_id:data.transcript.version.id,stage:'source-validation',source_ids:data.transcript.segments.map(s=>s.id),reason:(error as Error).message,created_at:new Date().toISOString()});throw error }
      const parts: Array<{ text: string; count: number }> = []
      const groups: Segment[][] = []
      let group: Segment[] = [], part = ''
      for (const s of data.transcript.segments) {
        const line = s.text + '\n'
        if (part.length + line.length > 1400 || group.length >= 20) {
          if (group.length) { groups.push(group); parts.push({ text: group.map((seg,i) => `${i+1}. ${seg.text}`).join('\n'), count: group.length }) }
          part = ''; group = []
        }
        if (line.length > 1800) throw new Error('单段转写过长，请先缩短文件')
        part += line; group.push(s)
      }
      if (group.length) { groups.push(group); parts.push({ text: group.map((seg,i) => `${i+1}. ${seg.text}`).join('\n'), count: group.length }) }
      const noteController = new AbortController()
      noteRuns.add(noteController)
      try {
      const selected = await infer<number[][]>('text', { parts }, p => window.dispatchEvent(new CustomEvent('ynote:browser-progress', { detail: p.stage })), noteController.signal)
      noteController.signal.throwIfAborted()
      try { requireFullSourceCoverage(selected, groups.map(group=>group.length)) }
      catch(error) {
        await write('rejected-note:'+uid(),{material_id:data.material.id,transcript_version_id:data.transcript.version.id,selected,counts:groups.map(group=>group.length),source_ids:groups.map(group=>group.map(s=>s.id)),reason:(error as Error).message,created_at:new Date().toISOString()},noteController.signal)
        throw error
      }
      const escape = (text: string) => text.replace(/[\\`*_{}\[\]<>#|]/g, '\\$&').replace(/\r?\n/g, ' ')
      const bullet=(seg:Segment)=>`- **${timestamp(seg.start_ms??0)} → ${timestamp(seg.end_ms??0)}** ${escape(toSimplified(seg.text))}`
      const markdown = validateNote('# 原文要点摘录\n\n> 这是原文摘录，不是完整摘要。模型选点可能遗漏重要任务、条件、数字和结论；未入选原文另行保留。仅转换简体字形，识别错误未被润色修正。\n\n' + selected.map((indices,i) => {
        const omitted=groups[i].filter((_,index)=>!indices.includes(index+1))
        return `## 第 ${i+1} 组 · 模型选中的原文\n\n`+indices.map(index=>bullet(groups[i][index-1])).join('\n')+(omitted.length?'\n\n### 未入选原文 · 保留核对，不能视为不重要\n\n'+omitted.map(bullet).join('\n'):'')
      }).join('\n\n'))
      const note: NoteVersion = { id: uid(), material_id: data.material.id, transcript_version_id: data.transcript.version.id, markdown, provider: 'browser-wasm', model: 'Qwen2.5-0.5B-Instruct q8 / auditable-source-coverage-v3', created_at: new Date().toISOString() }
      await write('material:' + p[2], { ...data, note }, noteController.signal)
      noteController.signal.throwIfAborted(); data.note = note; result = { note }
      } finally { noteRuns.delete(noteController); if(!noteRuns.size&&typeof window!=='undefined')window.dispatchEvent(new CustomEvent('ynote:browser-progress',{detail:''})) }
    } else if (p[1] === 'materials' && p[2] && p[3] === 'exports') {
      const data = await record(p[2]), original = data.transcript?.segments ?? []
      const segments = original.map(s => ({ ...s, text: toSimplified(s.text) }))
      const text = segments.map(s => `[${timestamp(s.start_ms ?? 0)} → ${timestamp(s.end_ms ?? 0)}] ${s.text}`).join('\n')
      const srt = segments.map((s, i) => `${i+1}\n${timestamp(s.start_ms ?? 0)} --> ${timestamp(s.end_ms ?? 0)}\n${s.text}\n`).join('\n')
      const files = { 'transcript.txt': strToU8(text), 'transcript.srt': strToU8(srt), 'transcript.json': strToU8(JSON.stringify(segments,null,2)), 'transcript.asr-original.json': strToU8(JSON.stringify(original,null,2)), 'notes.md': strToU8(toSimplified(data.note?.markdown ?? '笔记尚未生成')), 'README.txt': strToU8('浏览器本地处理。默认文本为简体字形转换，未作识别纠错；原始识别结果见 transcript.asr-original.json。原始媒体未加入压缩包；模型结果需要对照原音频核对。') }
      result = { export_id: uid(), download_url: download(new Blob([zipSync(files) as BlobPart], { type: 'application/zip' })) }
    } else if (p[1] === 'materials' && p.length === 2) result = { materials: [...records.values()].map(r => r.material), total: records.size }
    else if (p[1] === 'settings' && method === 'GET') result = { text_ai: null, transcription: null }
    else if (p[1] === 'quota') result = { tool: 'ynote', status: 'unavailable' }
    else throw new Error('浏览器本地模式尚不支持此操作；未向服务器发送内容。平台链接请改选本地文件')
    return Response.json(result)
  } catch (e) { return Response.json({ error: { code: 'INVALID_INPUT', message: e instanceof Error ? e.message : '本地操作失败', retryable: true } }, { status: 400 }) }
}
export function releaseLocalResources() { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); stopInference() }
export async function cancelBrowserTasks() {
  await initialize()
  for (const controller of noteRuns) controller.abort()
  noteRuns.clear()
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('ynote:browser-progress',{detail:''}))
  for (const [id, job] of jobs) {
    job.controller.abort()
    const task = tasks.get(id)
    if (task) { task.state = 'cancelled'; task.stage = '切换任务已取消上次处理；旧结果已丢弃' }
  }
  jobs.clear(); stopInference(); await persist()
}
export async function browserHistoryInfo(){
 await initialize()
 const keys=await recordKeys();let materials=0,bytes=0
 for(const key of keys)if(typeof key==='string'&&key.startsWith('material:')){const data=await read<Record>(key);if(data){materials++;bytes+=data.file.size}}
 return{tasks:tasks.size,materials,bytes}
}
export async function clearBrowserHistory(){
 await cancelBrowserTasks()
 const keys=(await recordKeys()).filter(key=>typeof key==='string'&&(key==='tasks'||/^(material:|transcript-version:|note-version:|rejected-note:)/.test(key)))
 await removeRecords(keys);tasks.clear();records.clear();releaseLocalResources()
 window.dispatchEvent(new Event('ynote:task-source-changed'))
}
