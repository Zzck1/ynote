/**
 * EdayNote 接口契约 —— 全队唯一事实来源（site-spec.md v1.1 §5）。
 * 所有页面/组件只准从这里 import 类型，禁止在组件内重复定义。
 */

// ===== §5.1 基础类型 =====

export type JobState =
  | 'queued'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_action'

export type Platform =
  | 'bilibili'
  | 'douyin'
  | 'xiaohongshu'
  | 'kuaishou'
  | 'youtube'
  | 'local'

export type ContentType = 'video' | 'image_post' | 'audio' | 'local_file'

/** 水印状态：marked=有水印；declared_clean=来源声明无水印（未人工确认）；unconfirmed=未确认 */
export type WatermarkState = 'marked' | 'declared_clean' | 'unconfirmed'

/** 五个素材操作 */
export type OperationKind = 'cover' | 'transcript' | 'video' | 'images' | 'audio'
export type ExtractionMode = 'quick' | 'precise'

/** 无水印三策略 */
export type VariantPolicy = 'original' | 'prefer_no_watermark' | 'no_watermark_only'

export type ErrorCode =
  | 'MATERIAL_NOT_FOUND'
  | 'ASSET_NOT_FOUND'
  | 'LOGIN_REQUIRED'
  | 'RATE_LIMITED'
  | 'LINK_EXPIRED'
  | 'NO_CLEAN_SOURCE'
  | 'TRANSCRIBE_FAILED'
  | 'MODEL_FAILED'
  | 'DISK_FULL'
  | 'INVALID_INPUT'
  | 'QUOTA_EXCEEDED'
  | 'BYOK_INVALID'
  | 'BYOK_VALIDATION_REQUIRED'
  | 'QUOTA_UNAVAILABLE'
  | 'COMPANION_REQUIRED'
  | 'TASK_NOT_FOUND'
  | 'TASK_SOURCE_CHANGED'

export interface ApiError {
  code: ErrorCode
  message: string // 可直接展示的中文文案
  retryable: boolean
}

// ===== §5.2 实体类型 =====

export interface Material {
  id: string
  platform: Platform
  external_id: string // 平台作品 ID
  part_id: string | null // 分P/分集标识；null 表示无分集
  source_url: string // canonical_url
  title: string
  author: string
  duration: number | null // 秒；图文帖为 null
  content_type: ContentType
  cover_url: string | null
  created_at: string // ISO 8601
}

/** 逐项能力：available=false 时必须给出 reason */
export interface MaterialCapability {
  available: boolean
  reason?: string
}

export interface MaterialCapabilities {
  cover: MaterialCapability
  transcript: MaterialCapability
  video: MaterialCapability
  images: MaterialCapability
  audio: MaterialCapability
}

export interface MediaVariant {
  id: string
  material_id: string
  quality: string // 例：'1080p'
  watermark_state: WatermarkState
  assertion_source: 'platform' | 'manual' | 'none'
  expires_at: string | null
  access_requirements: string[]
}

export type AssetKind = 'cover' | 'video' | 'image' | 'audio' | 'subtitle'

export interface Asset {
  id: string
  material_id: string
  variant_id: string | null
  kind: AssetKind
  relative_path: string
  mime: string
  bytes: number
  sha256: string
  duration: number | null
  origin: 'original' | 'generated'
}

export interface TranscriptVersion {
  id: string
  material_id: string
  source: 'subtitle' | 'asr' | 'post_text' | 'imported'
  language: string // BCP-47
  status: 'complete' | 'partial'
  coverage: number // 0~1
  failed_ranges: Array<{ start_ms: number; end_ms: number }>
  parent_version_id: string | null
}

export interface Segment {
  id: string
  transcript_version_id: string
  start_ms: number | null // 无真实时间戳的供应商文本为 null（禁止伪造）
  end_ms: number | null
  text: string
  source_chunk: string | null
}

export interface NoteVersion {
  id: string
  material_id: string
  transcript_version_id: string
  markdown: string
  provider: string
  model: string
  created_at: string
}

export interface JobOperation {
  kind: OperationKind
  state: JobState
  stage: string
  progress: number // 0~1
  error_code: ErrorCode | null
  retry_count: number
  asset_ids: string[]
}

export interface Job {
  asr_progress?: { processed_ms: number; duration_ms: number }
  id: string
  material_id: string
  operation: OperationKind[] // 本次请求的操作集合
  state: JobState
  stage: string
  progress: number // 总体进度（各操作均值）
  error_code: ErrorCode | null
  retry_count: number
  lease_until: string | null
  cancel_requested: boolean
  operations: JobOperation[]
}

export interface Citation {
  transcript_version_id: string
  segment_id: string
  start_ms: number | null
  end_ms: number | null
  quote: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
}

export interface Conversation {
  id: string
  material_id: string
  messages: ChatMessage[]
  source_version_ids: string[]
}

// ===== §5.3 请求/响应类型 =====

// ① POST /api/materials/resolve
export interface ResolveRequest {
  raw_input: string
  candidate_id?: string
}

export interface ResolveCandidate {
  candidate_id: string
  url: string
  platform: Platform | null
  title_hint: string | null
}

export interface ResolveResponse {
  status: 'resolved' | 'needs_selection'
  material?: Material
  capabilities?: MaterialCapabilities
  candidates?: ResolveCandidate[]
}

// ② POST /api/materials/import
export interface ImportResponse {
  material: Material
  capabilities: MaterialCapabilities
}

// ③ POST /api/materials/{id}/jobs
export interface CreateJobsRequest {
  extraction_mode?: ExtractionMode
  operations: OperationKind[]
  variant_policy?: VariantPolicy
  quality?: string
  audio_bitrate?: '128' | '192' | '320'
  generate_note?: boolean
  idempotency_key: string
}

export interface CreateJobsResponse {
  job: Job
}

// ④ GET /api/jobs/{id}、⑥ cancel、⑦ retry
export interface JobResponse {
  job: Job
}

export interface RetryJobRequest {
  operations?: OperationKind[]
}

// ⑤ GET /api/jobs/{id}/events（SSE）
export interface JobEvent {
  seq: number // 单调递增；SSE id 字段同值
  job_id: string
  ts: string
  type: 'job_state' | 'op_state' | 'op_progress' | 'op_stage' | 'op_error' | 'job_done'
  op?: OperationKind
  state?: JobState
  progress?: number
  stage?: string
  error?: ApiError
}

// ⑧ GET /api/assets/{id}/download —— 走二进制，无 JSON 类型

// ⑨ GET /api/materials/{id}/transcript
export interface TranscriptResponse {
  version: TranscriptVersion
  segments: Segment[]
  total_segments: number
  page: number
  page_size: number
}

// ⑩ POST /api/materials/{id}/notes
export interface CreateNoteRequest {
  transcript_version_id: string
  provider?: string
}

export interface NoteResponse {
  note: NoteVersion
}

// ⑪ POST /api/materials/{id}/chat
export interface ChatRequest {
  provider?: string
  conversation_id?: string
  question: string
}

export interface ChatResponse {
  conversation: Conversation
}

// ⑫ POST /api/materials/{id}/exports
export interface ExportsRequest {
  scope: 'transcript' | 'note' | 'full_package'
  format: 'txt' | 'srt' | 'md' | 'zip'
}

export interface ExportsResponse {
  export_id: string
  download_url: string
}

// ⑬ GET /api/health
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down'
  checks: {
    backend: 'ok' | 'down'
    database: 'ok' | 'down'
    ffmpeg: 'ok' | 'down' | 'absent'
    model: 'ok' | 'not_configured' | 'down'
    disk: 'ok' | 'full'
  }
}

// ⑭ GET/PUT /api/settings/providers
export interface ProviderConfig {
  base_url: string
  api_key_masked: string // 例 'sk-****abcd'；明钥永不回传
  model: string
}

export interface TranscriptionProviderConfig {
  engine: 'local' | 'remote'
  base_url: string
  api_key_masked: string
  model: string
}

export interface ProviderSettings {
  text_ai: ProviderConfig
  transcription: TranscriptionProviderConfig
}

export interface ProviderConfigInput {
  base_url: string
  api_key: string
  model: string
}

export interface TranscriptionProviderConfigInput {
  engine: 'local' | 'remote'
  base_url?: string
  api_key?: string
  model: string
}

export interface SaveProvidersRequest {
  text_ai?: ProviderConfigInput
  transcription?: TranscriptionProviderConfigInput
}

// ⑯ POST /api/settings/providers/{kind}/test
export type ProviderKind = 'text_ai' | 'transcription'

export interface TestConnectionResult {
  ok: boolean
  latency_ms: number
  model?: string
  message: string
}

// ===== 契约扩展（site-spec §5.3 未列、前端先行，已向主理人报备） =====

// 扩展 1：GET /api/materials/{id}/assets —— 素材标签页需要按资料列出资产与版本信息
export interface AssetListResponse {
  assets: Asset[]
  variants: MediaVariant[]
}

// 扩展 2：DELETE /api/materials/{id} —— content-plan §6「删除资料确认弹层」对应操作
export interface DeleteMaterialResponse {
  deleted: true
}

/** Backend-owned workspace snapshot; browser state is only a view cache. */
export interface MaterialListResponse { materials: Material[] }
export interface MaterialDetailResponse {
  material: Material
  capabilities: MaterialCapabilities
  jobs: Job[]
  note: NoteVersion | null
  conversation: Conversation | null
}
