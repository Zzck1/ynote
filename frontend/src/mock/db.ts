/**
 * Mock 内存数据库 + localStorage 快照/恢复（site-spec §5.4「持久化」规则）。
 * 刷新后资料、能力、资产、原文、笔记、问答、去重表仍在；任务不持久化（运行中的计时器随刷新终止）。
 */
import type { DemoSpec } from './fixtures/demo'
import type {
  Asset,
  Conversation,
  Job,
  Material,
  MaterialCapabilities,
  MediaVariant,
  NoteVersion,
  Segment,
  TranscriptVersion,
} from '../api/types'

const LS_KEY = 'edaynote.mockdb.v1'

export interface MockDB {
  materials: Record<string, Material>
  /** materialId -> 演示规格（占位图尺寸、图集数量、原文段落、笔记 Markdown 等 mock 侧元数据） */
  meta: Record<string, DemoSpec>
  /** materialId -> 按顺序的资产 id 列表 */
  assetOrder: Record<string, string[]>
  assets: Record<string, Asset>
  variants: Record<string, MediaVariant>
  transcripts: Record<string, TranscriptVersion> // by version id
  segments: Record<string, Segment[]> // by version id
  latestTranscript: Record<string, string> // materialId -> version id
  notes: Record<string, NoteVersion> // materialId -> 最新笔记
  conversations: Record<string, Conversation> // materialId -> 会话
  /** platform+external_id+part_id -> materialId（去重判定，F04） */
  dedup: Record<string, string>
  /** 演示设置仅保存在运行时内存，绝不持久化密钥 */
  settings: {
    text_ai: { base_url: string; api_key: string; model: string } | null
    transcription: {
      engine: 'local' | 'remote'
      base_url: string
      api_key: string
      model: string
    } | null
  }
}

function freshDb(): MockDB {
  return {
    materials: {},
    meta: {},
    assetOrder: {},
    assets: {},
    variants: {},
    transcripts: {},
    segments: {},
    latestTranscript: {},
    notes: {},
    conversations: {},
    dedup: {},
    settings: { text_ai: null, transcription: null },
  }
}

let db: MockDB = load()

function load(): MockDB {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return freshDb()
    const parsed = JSON.parse(raw) as MockDB
    const safe = { ...freshDb(), ...parsed, settings: { text_ai: null, transcription: null } }
    localStorage.setItem(LS_KEY, JSON.stringify(safe))
    return safe
  } catch {
    return freshDb()
  }
}

export function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...db, settings: { text_ai: null, transcription: null } }))
  } catch {
    /* 存储满时静默失败（演示版） */
  }
}

export function getDb(): MockDB {
  return db
}

export function resetDb(): void {
  db = freshDb()
  persist()
}

// ===== Material =====

export function getMaterial(id: string): Material | undefined {
  return db.materials[id]
}

export function findMaterialByDedupKey(key: string): Material | undefined {
  const id = db.dedup[key]
  return id ? db.materials[id] : undefined
}

export function putMaterial(
  material: Material,
  capabilities: MaterialCapabilities,
  meta?: DemoSpec,
): void {
  db.materials[material.id] = material
  if (meta) db.meta[material.id] = meta
  const dedupKey = `${material.platform}+${material.external_id}+${material.part_id ?? ''}`
  db.dedup[dedupKey] = material.id
  capabilityCache[material.id] = capabilities
  persist()
}

export function getMeta(materialId: string): DemoSpec | undefined {
  return db.meta[materialId]
}

export function removeMaterial(id: string): void {
  const m = db.materials[id]
  if (m) {
    delete db.dedup[`${m.platform}+${m.external_id}+${m.part_id ?? ''}`]
  }
  delete db.materials[id]
  for (const assetId of db.assetOrder[id] ?? []) delete db.assets[assetId]
  delete db.assetOrder[id]
  const versionId = db.latestTranscript[id]
  if (versionId) {
    delete db.segments[versionId]
    delete db.transcripts[versionId]
  }
  delete db.latestTranscript[id]
  delete db.notes[id]
  delete db.conversations[id]
  delete db.meta[id]
  delete capabilityCache[id]
  persist()
}

// ===== Capabilities =====

const capabilityCache: Record<string, MaterialCapabilities> = {}

export function getCapabilities(materialId: string): MaterialCapabilities | undefined {
  return capabilityCache[materialId]
}

// ===== Assets =====

/** 写入资产（同 kind 覆盖旧资产，保持顺序），返回写入后的资产列表 */
export function putAssets(materialId: string, newAssets: Asset[], variants: MediaVariant[]): Asset[] {
  for (const v of variants) db.variants[v.id] = v
  const existing = (db.assetOrder[materialId] ?? []).map((id) => db.assets[id]).filter(Boolean)
  const newKinds = new Set(newAssets.map((a) => a.kind))
  const kept = existing.filter((a) => !newKinds.has(a.kind))
  // 图片保持原顺序：旧图片保留，新图片按传入顺序追加
  const merged = [...kept, ...newAssets]
  db.assetOrder[materialId] = merged.map((a) => a.id)
  for (const a of merged) db.assets[a.id] = a
  persist()
  return merged
}

export function getAsset(id: string): Asset | undefined {
  return db.assets[id]
}

export function listAssets(materialId: string): { assets: Asset[]; variants: MediaVariant[] } {
  const assets = (db.assetOrder[materialId] ?? []).map((id) => db.assets[id]).filter(Boolean)
  const variantIds = [...new Set(assets.map((a) => a.variant_id).filter((v): v is string => !!v))]
  return { assets, variants: variantIds.map((id) => db.variants[id]).filter(Boolean) }
}

// ===== Transcript =====

export function putTranscript(
  version: TranscriptVersion,
  segments: Segment[],
): void {
  db.transcripts[version.id] = version
  db.segments[version.id] = segments
  db.latestTranscript[version.material_id] = version.id
  persist()
}

export function getLatestTranscript(
  materialId: string,
): { version: TranscriptVersion; segments: Segment[] } | undefined {
  const versionId = db.latestTranscript[materialId]
  if (!versionId) return undefined
  const version = db.transcripts[versionId]
  if (!version) return undefined
  return { version, segments: db.segments[versionId] ?? [] }
}

// ===== Notes =====

export function putNote(note: NoteVersion): void {
  db.notes[note.material_id] = note
  persist()
}

export function getNote(materialId: string): NoteVersion | undefined {
  return db.notes[materialId]
}

// ===== Conversations =====

export function getConversation(materialId: string): Conversation | undefined {
  return db.conversations[materialId]
}

export function putConversation(conversation: Conversation): void {
  db.conversations[conversation.material_id] = conversation
  persist()
}

// ===== Jobs（仅内存：运行中的计时器随刷新终止，由前端把非终态任务扫成 cancelled） =====

const jobCache = new Map<string, Job>()

export function getJob(jobId: string): Job | undefined {
  return jobCache.get(jobId)
}

export function putJob(job: Job): void {
  jobCache.set(job.id, job)
}

export function cloneJob(job: Job): Job {
  return JSON.parse(JSON.stringify(job)) as Job
}

// ===== Settings =====

export function getRawSettings(): MockDB['settings'] {
  return db.settings
}

export function putSettings(settings: MockDB['settings']): void {
  db.settings = settings
  persist()
}

export function isTextAiConfigured(): boolean {
  const t = db.settings.text_ai
  return !!t && t.base_url.trim() !== '' && t.api_key.trim() !== '' && t.model.trim() !== ''
}
