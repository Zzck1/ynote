/**
 * Mock 路由器（site-spec §5.4）：按「方法+路径」分发到 handler，实现任务状态机引擎。
 * 仅被 src/api/client.ts 单点引用；业务组件严禁直接 import。
 */
import { ApiRequestError } from '../api/errors'
import type {
  ApiError,
  Asset,
  ChatMessage,
  Citation,
  Conversation,
  CreateJobsRequest,
  ErrorCode,
  Job,
  JobOperation,
  Material,
  MaterialCapabilities,
  MaterialCapability,
  MediaVariant,
  OperationKind,
  ResolveCandidate,
  ResolveResponse,
  Segment,
  TestConnectionResult,
  TranscriptVersion,
  VariantPolicy,
} from '../api/types'
import * as db from './db'
import { DEMO_SPEC_BY_KEY, type DemoSpec } from './fixtures/demo'
import { makePlaceholderImageBlob, makeTextBlob, formatSrtTimecode } from './fixtures/media'
import { emitJobEvent } from './sse'
import { detectScenarios, ERROR_MESSAGES } from './scenarios'
import { LOCAL_TRANSCRIPTION_MODEL } from '../utils/transcription'

// ===== 基础工具 =====

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const uid = (prefix: string) =>
  `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`

function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

function fail(code: ErrorCode, message: string, retryable = false): never {
  throw new ApiRequestError(code, message, retryable)
}

/** mock 内部用的 URL 提取（site-spec §5.4：剥离外层引号与尾部中文标点） */
function extractUrls(raw: string): string[] {
  const matched = raw.match(/https?:\/\/[^\s"'<>]+/g) ?? []
  const cleaned = matched.map((u) =>
    u.replace(/[，。、；：！？）】」』,.;:!?)\]}…]+$/u, '').replace(/^["'«»]+/, '').replace(/["'«»]+$/g, ''),
  )
  return [...new Set(cleaned)]
}

// ===== 演示真实媒体（frontend/public/demo，视频/封面/音频可直接预览播放） =====

const DEMO_MEDIA = {
  video16x9: '/demo/demo-video-16x9.mp4',
  video9x16: '/demo/demo-video-9x16.mp4',
  audio: '/demo/demo-audio.mp3',
  cover16x9: '/demo/cover-16x9.jpg',
  cover9x16: '/demo/cover-9x16.jpg',
  cover3x4: '/demo/cover-3x4.jpg',
} as const

/** 按宽高比选演示媒体形态：≥1.2 用 16:9，≤0.8 用 9:16，其余用 3:4 */
function aspectKindFor(dims: [number, number] | null): '16x9' | '9x16' | '3x4' {
  if (!dims) return '16x9'
  const r = dims[0] / dims[1]
  if (r >= 1.2) return '16x9'
  if (r <= 0.8) return '9x16'
  return '3x4'
}

function demoCoverFor(dims: [number, number] | null): string {
  const k = aspectKindFor(dims)
  return k === '16x9' ? DEMO_MEDIA.cover16x9 : k === '9x16' ? DEMO_MEDIA.cover9x16 : DEMO_MEDIA.cover3x4
}

/** 本地导入真实文件的媒体 URL 注册表：asset_id -> object URL（预览即原文件） */
const importMediaUrls = new Map<string, string>()

// ===== 平台识别（site-spec §5.4 域名映射） =====

const PLATFORM_DOMAINS: Record<string, string> = {
  'b23.tv': 'bilibili',
  'bilibili.com': 'bilibili',
  'v.douyin.com': 'douyin',
  'douyin.com': 'douyin',
  'xhslink.com': 'xiaohongshu',
  'xiaohongshu.com': 'xiaohongshu',
}

function detectPlatform(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    for (const [domain, platform] of Object.entries(PLATFORM_DOMAINS)) {
      if (host === domain || host.endsWith(`.${domain}`)) return platform
    }
  } catch {
    /* 非法 URL 走统一错误 */
  }
  return null
}

function specKeyForPlatform(platform: string): DemoSpec['key'] {
  switch (platform) {
    case 'bilibili':
      return 'bilibili'
    case 'douyin':
      return 'douyin'
    case 'xiaohongshu':
      return 'xiaohongshu'
    default:
      return 'generic'
  }
}

function externalIdFor(url: string, platform: string): string {
  const bv = url.match(/BV[a-zA-Z0-9]{8,}/)
  if (bv) return bv[0]
  if (platform === 'douyin') {
    const m = url.match(/\/(\d{15,})/)
    if (m) return m[1]
  }
  return hashString(url)
}

function buildCapabilities(spec: DemoSpec): MaterialCapabilities {
  const cap = (kind: OperationKind): MaterialCapability =>
    spec.unavailable[kind]
      ? { available: false, reason: spec.unavailable[kind] }
      : { available: true }
  return {
    cover: cap('cover'),
    transcript: cap('transcript'),
    video: cap('video'),
    images: cap('images'),
    audio: cap('audio'),
  }
}

function coverUrlFor(spec: DemoSpec): string | null {
  if (!spec.coverDims) return null
  return demoCoverFor(spec.coverDims)
}

/** 建立或复用资料（F04 去重：platform+external_id+part_id 判定） */
function ensureMaterial(url: string, platform: string): { material: Material; spec: DemoSpec } {
  const externalId = externalIdFor(url, platform)
  const dedupKey = `${platform}+${externalId}+`
  const existing = db.findMaterialByDedupKey(dedupKey)
  if (existing) {
    return { material: existing, spec: db.getMeta(existing.id) ?? DEMO_SPEC_BY_KEY[specKeyForPlatform(platform)] }
  }
  const spec = DEMO_SPEC_BY_KEY[specKeyForPlatform(platform)]
  const material: Material = {
    id: `mat-${hashString(dedupKey)}`,
    platform: platform as Material['platform'],
    external_id: externalId,
    part_id: null,
    source_url: url,
    title: spec.title,
    author: spec.author,
    duration: spec.duration,
    content_type: spec.contentType,
    cover_url: coverUrlFor(spec),
    created_at: new Date(Date.now() - spec.ageMs).toISOString(),
  }
  db.putMaterial(material, buildCapabilities(spec), spec)
  return { material, spec }
}

// ===== ① resolve =====

/** 多链接候选登记表：candidate_id -> url */
const candidateRegistry = new Map<string, string>()

function resolveOne(url: string): ResolveResponse {
  const platform = detectPlatform(url)
  if (!platform) {
    fail(
      'INVALID_INPUT',
      '暂不支持这个站点。当前支持 B站、抖音、小红书（演示版），本地文件可直接导入。',
    )
  }
  const flags = detectScenarios(url)
  if (flags.expire) {
    fail('LINK_EXPIRED', '链接已过期或被删除。分享链接有时效，请回到原作品重新分享一次。')
  }
  const { material } = ensureMaterial(url, platform)
  const capabilities = db.getCapabilities(material.id) ?? buildCapabilities(DEMO_SPEC_BY_KEY[specKeyForPlatform(platform)])
  return { status: 'resolved', material, capabilities }
}

function handleResolve(rawInput: string, candidateId?: string): ResolveResponse {
  if (candidateId) {
    const url = candidateRegistry.get(candidateId)
    if (!url) fail('INVALID_INPUT', '没有检测到内容。粘贴分享链接、整段分享文字或视频网址后再试。')
    return resolveOne(url)
  }
  const urls = extractUrls(rawInput ?? '')
  if (urls.length === 0) {
    if (!rawInput || rawInput.trim() === '') {
      fail('INVALID_INPUT', '没有检测到内容。粘贴分享链接、整段分享文字或视频网址后再试。')
    }
    fail(
      'INVALID_INPUT',
      '这段文字里没有链接。纯口令无法解析，请在原平台打开分享，复制完整链接后再来。',
    )
  }
  if (urls.length >= 2) {
    candidateRegistry.clear()
    const candidates: ResolveCandidate[] = urls.map((url) => {
      const id = `cand-${hashString(url)}`
      candidateRegistry.set(id, url)
      let domain = ''
      try {
        domain = new URL(url).hostname
      } catch {
        domain = url.slice(0, 24)
      }
      return {
        candidate_id: id,
        url,
        platform: detectPlatform(url) as ResolveCandidate['platform'],
        title_hint: domain || null,
      }
    })
    return { status: 'needs_selection', candidates }
  }
  return resolveOne(urls[0])
}

// ===== ② 本地文件导入 =====

function handleImport(file: File): { material: Material; capabilities: MaterialCapabilities } {
  if (!file || typeof file !== 'object' || !('name' in file)) {
    fail('INVALID_INPUT', '没有检测到内容。粘贴分享链接、整段分享文字或视频网址后再试。')
  }
  const name = (file as File).name
  const lower = name.toLowerCase()
  const isVideo = (file as File).type.startsWith('video/') || /\.(mp4|mkv|mov|webm|avi)$/.test(lower)
  const isAudio = (file as File).type.startsWith('audio/') || /\.(mp3|wav|aac|flac|m4a)$/.test(lower)
  const isImage = (file as File).type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp)$/.test(lower)
  const isSubtitle = /\.(srt|vtt|txt)$/.test(lower)
  if (!isVideo && !isAudio && !isImage && !isSubtitle) {
    fail('INVALID_INPUT', '暂不支持这个文件类型。当前支持视频、音频、图片与字幕文件（演示版）。')
  }
  const spec: DemoSpec = {
    ...DEMO_SPEC_BY_KEY.local,
    title: name.replace(/\.[^.]+$/, ''),
    transcriptSource: isSubtitle ? 'imported' : isVideo || isAudio ? 'asr' : 'post_text',
    coverDims: null,
    images: isImage ? { count: 1, dims: [1280, 1707] } : null,
  }
  const externalId = hashString(`${name}:${(file as File).size}`)
  const dedupKey = `local+${externalId}+`
  const existing = db.findMaterialByDedupKey(dedupKey)
  if (existing) {
    return { material: existing, capabilities: db.getCapabilities(existing.id)! }
  }
  const material: Material = {
    id: `mat-${hashString(dedupKey)}`,
    platform: 'local',
    external_id: externalId,
    part_id: null,
    source_url: `file://localhost/${name}`,
    title: spec.title,
    author: '本地导入',
    duration: isVideo || isAudio ? 600 : null,
    content_type: isVideo ? 'video' : isAudio ? 'audio' : isImage ? 'image_post' : 'local_file',
    cover_url: null,
    created_at: new Date().toISOString(),
  }
  const unavailable: DemoSpec['unavailable'] = {}
  if (!isVideo && !isAudio) {
    unavailable.video = '这份作品没有视频。可导入视频文件后使用这项。'
    unavailable.audio = '该作品没有可提取的音轨'
  } else {
    unavailable.cover = '该作品没有封面，可从视频取一帧生成'
    unavailable.images = '该作品没有图集，可改为提取关键帧'
  }
  if (!isSubtitle && !isVideo && !isAudio) {
    unavailable.transcript = '该作品没有可提取的文字内容'
  }
  const localSpec = { ...spec, unavailable }
  db.putMaterial(material, buildCapabilities(localSpec), localSpec)
  // 导入的媒体文件本身直接作为资产（真实文件 → object URL，可直接预览播放）
  if (isVideo || isAudio || isImage) {
    const kind = isVideo ? 'video' : isAudio ? 'audio' : 'image'
    const asset = buildAsset(material.id, kind as Asset['kind'], null, localSpec, 0)
    importMediaUrls.set(asset.id, URL.createObjectURL(file))
    db.putAssets(material.id, [asset], [])
  }
  return { material, capabilities: db.getCapabilities(material.id)! }
}

// ===== 资产构造 =====

function buildAsset(
  materialId: string,
  kind: Asset['kind'],
  variantId: string | null,
  _spec: DemoSpec,
  index: number,
): Asset {
  const m = db.getMaterial(materialId)
  const title = m?.title ?? 'material'
  const ext = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'svg'
  const duration = m?.duration ?? null
  const bytes =
    kind === 'video'
      ? 203423744
      : kind === 'audio'
        ? Math.max(1, Math.round(((duration ?? 300) * 320 * 1024) / 8))
        : 2097152 + index * 1024
  return {
    id: uid('asset'),
    material_id: materialId,
    variant_id: variantId,
    kind,
    relative_path: `${kind === 'image' ? 'images' : kind + 's'}/${hashString(title)}-${kind}-${index}.${ext}`,
    mime: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/svg+xml',
    bytes,
    sha256: hashString(`${materialId}:${kind}:${index}:${Math.random()}`),
    duration: kind === 'video' || kind === 'audio' ? duration : null,
    origin: kind === 'cover' && !m?.cover_url ? 'generated' : 'original',
  }
}

// ===== ③ 任务状态机引擎（site-spec §4.1 + §5.4 流转规则） =====

const cancelledJobs = new Set<string>()
const pausedJobs = new Set<string>()
/** 一次性场景标记：retry 后不再触发（演示「重试这一项」恢复） */
const consumedScenarios = new Set<string>()
/** 幂等键：同 idempotency_key 重复提交返回同一 Job（site-spec §5.3 ③） */
const idempotencyJobs = new Map<string, string>()

interface StageSpec {
  name: string
  progress?: boolean
  ms?: [number, number]
}

const OP_STAGES: Record<OperationKind, StageSpec[]> = {
  cover: [{ name: 'fetching', ms: [500, 900] }],
  transcript: [
    { name: 'transcribing', progress: true },
    { name: 'merging', ms: [400, 800] },
  ],
  video: [
    { name: 'fetching', ms: [500, 900] },
    { name: 'downloading', progress: true },
    { name: 'processing', ms: [500, 900] },
  ],
  images: [{ name: 'fetching', ms: [800, 1400] }],
  audio: [{ name: 'extracting', ms: [500, 900] }, { name: 'converting', progress: true }],
}

const TERMINAL_OP_STATES = ['succeeded', 'failed', 'cancelled']

interface OpPlan {
  outcome: 'ok' | 'fail' | 'skip_cancel'
  failCode?: ErrorCode
  failAt?: number
}

function planFor(job: Job, op: JobOperation, policy: VariantPolicy): OpPlan {
  const kind = op.kind
  const material = db.getMaterial(job.material_id)
  const spec = db.getMeta(job.material_id) ?? DEMO_SPEC_BY_KEY.generic
  const capabilities = db.getCapabilities(job.material_id)
  const cap = capabilities?.[kind]
  if (cap && !cap.available) {
    return { outcome: 'skip_cancel', failCode: 'ASSET_NOT_FOUND' }
  }
  const flags = material ? detectScenarios(material.source_url) : detectScenarios('')
  const consumed = consumedScenarios.has(`${job.id}:${kind}`)
  if (!consumed) {
    if (kind === 'video') {
      if (flags.failVideo) return { outcome: 'fail', failCode: 'NO_CLEAN_SOURCE', failAt: 0.55 }
      if (flags.diskfull) return { outcome: 'fail', failCode: 'DISK_FULL', failAt: 0.45 }
      if (flags.partial) return { outcome: 'fail', failCode: 'NO_CLEAN_SOURCE', failAt: 0.7 }
      // 仅无水印：无法确认无水印源时跳过这项（content-plan §2.2 策略 3）
      if (policy === 'no_watermark_only' && !spec.cleanVideoSource) {
        return { outcome: 'skip_cancel', failCode: 'NO_CLEAN_SOURCE' }
      }
    }
    if (kind === 'audio') {
      if (flags.partial) return { outcome: 'fail', failCode: 'TRANSCRIBE_FAILED', failAt: 0.6 }
      if (flags.diskfull) return { outcome: 'fail', failCode: 'DISK_FULL', failAt: 0.4 }
    }
  }
  return { outcome: 'ok' }
}

function updateJobProgress(job: Job): void {
  const total = job.operations.reduce((s, o) => s + o.progress, 0)
  job.progress = job.operations.length > 0 ? total / job.operations.length : 0
}

async function runOp(
  jobId: string,
  kind: OperationKind,
  policy: VariantPolicy,
  resume = false,
): Promise<void> {
  const job = db.getJob(jobId)
  if (!job) return
  const op = job.operations.find((o) => o.kind === kind)
  if (!op || TERMINAL_OP_STATES.includes(op.state)) return

  if (!resume) {
    op.state = 'running'
    emitJobEvent(jobId, { type: 'op_state', op: kind, state: 'running' })
  }
  const plan = planFor(job, op, policy)

  // 能力不可用 / 仅无水印无可确认源：立即跳过，不做任何下载
  if (plan.outcome === 'skip_cancel') {
    const material = db.getMaterial(job.material_id)
    const capabilities = db.getCapabilities(job.material_id)
    const capReason = capabilities?.[kind]?.reason
    const message =
      plan.failCode === 'NO_CLEAN_SOURCE'
        ? ERROR_MESSAGES.NO_CLEAN_SOURCE
        : capReason ?? ERROR_MESSAGES.ASSET_NOT_FOUND
    const error: ApiError = {
      code: plan.failCode ?? 'ASSET_NOT_FOUND',
      message,
      retryable: false,
    }
    void material
    op.error_code = error.code
    op.state = 'cancelled'
    op.stage = 'done'
    op.progress = 0
    emitJobEvent(jobId, { type: 'op_error', op: kind, error })
    emitJobEvent(jobId, { type: 'op_state', op: kind, state: 'cancelled' })
    maybeFinishJob(jobId)
    return
  }

  const stages = OP_STAGES[kind]
  for (const stage of stages) {
    if (cancelledJobs.has(jobId) || pausedJobs.has(jobId)) return
    if (op.stage !== stage.name) {
      op.stage = stage.name
      emitJobEvent(jobId, { type: 'op_stage', op: kind, stage: stage.name })
    }
    if (stage.progress) {
      while (op.progress < 1) {
        await wait(rand(400, 900))
        if (cancelledJobs.has(jobId) || pausedJobs.has(jobId)) return
        const jobNow = db.getJob(jobId)
        const opNow = jobNow?.operations.find((o) => o.kind === kind)
        if (!opNow || opNow.state !== 'running') return
        opNow.progress = Math.min(1, opNow.progress + rand(0.03, 0.12))
        if (jobNow) updateJobProgress(jobNow)
        if (plan.failCode && plan.failAt && opNow.progress >= plan.failAt) {
          opNow.progress = plan.failAt
          opNow.error_code = plan.failCode
          opNow.state = 'failed'
          emitJobEvent(jobId, { type: 'op_progress', op: kind, progress: opNow.progress })
          const error: ApiError = {
            code: plan.failCode,
            message: ERROR_MESSAGES[plan.failCode],
            retryable: false,
          }
          emitJobEvent(jobId, { type: 'op_error', op: kind, error })
          emitJobEvent(jobId, { type: 'op_state', op: kind, state: 'failed' })
          if (jobNow) updateJobProgress(jobNow)
          maybeFinishJob(jobId)
          return
        }
        emitJobEvent(jobId, { type: 'op_progress', op: kind, progress: opNow.progress })
      }
    } else if (stage.ms) {
      await wait(rand(stage.ms[0], stage.ms[1]))
      if (cancelledJobs.has(jobId) || pausedJobs.has(jobId)) return
      const jobNow = db.getJob(jobId)
      const opNow = jobNow?.operations.find((o) => o.kind === kind)
      if (!opNow || opNow.state !== 'running') return
    }
  }

  // 成功：落资产
  const jobDone = db.getJob(jobId)
  const opDone = jobDone?.operations.find((o) => o.kind === kind)
  if (!jobDone || !opDone) return
  const assets = createAssetsForOp(jobDone, kind, policy)
  opDone.progress = 1
  opDone.stage = 'done'
  opDone.state = 'succeeded'
  opDone.asset_ids = assets.map((a) => a.id)
  updateJobProgress(jobDone)
  emitJobEvent(jobId, { type: 'op_progress', op: kind, progress: 1 })
  emitJobEvent(jobId, { type: 'op_state', op: kind, state: 'succeeded' })
  maybeFinishJob(jobId)
}

function createAssetsForOp(job: Job, kind: OperationKind, policy: VariantPolicy): Asset[] {
  const spec = db.getMeta(job.material_id) ?? DEMO_SPEC_BY_KEY.generic
  const material = db.getMaterial(job.material_id)
  if (!material) return []

  if (kind === 'transcript') {
    ensureTranscript(material, spec)
    return []
  }
  if (kind === 'cover') {
    const asset = buildAsset(job.material_id, 'cover', null, spec, 0)
    const dims = spec.coverDims ?? [1920, 1080]
    asset.mime = 'image/svg+xml'
    asset.bytes = dims[0] * 3
    db.putAssets(job.material_id, [asset], [])
    return [asset]
  }
  if (kind === 'video') {
    const variant: MediaVariant = {
      id: uid('var'),
      material_id: job.material_id,
      quality: '1080p',
      watermark_state:
        policy === 'original' || policy === 'prefer_no_watermark'
          ? spec.cleanVideoSource
            ? 'declared_clean'
            : 'marked'
          : 'declared_clean',
      assertion_source: 'platform',
      expires_at: null,
      access_requirements: [],
    }
    const asset = buildAsset(job.material_id, 'video', variant.id, spec, 0)
    db.putAssets(job.material_id, [asset], [variant])
    return [asset]
  }
  if (kind === 'audio') {
    const asset = buildAsset(job.material_id, 'audio', null, spec, 0)
    db.putAssets(job.material_id, [asset], [])
    return [asset]
  }
  if (kind === 'images' && spec.images) {
    const assets: Asset[] = []
    for (let i = 0; i < spec.images.count; i++) {
      assets.push(buildAsset(job.material_id, 'image', null, spec, i))
    }
    db.putAssets(job.material_id, assets, [])
    return assets
  }
  return []
}

function ensureTranscript(material: Material, spec: DemoSpec): TranscriptVersion {
  const existing = db.getLatestTranscript(material.id)
  if (existing) return existing.version
  const version: TranscriptVersion = {
    id: uid('tv'),
    material_id: material.id,
    source: spec.transcriptSource,
    language: 'zh-CN',
    status: spec.coverage < 1 ? 'partial' : 'complete',
    coverage: spec.coverage,
    failed_ranges: spec.failedRanges,
    parent_version_id: null,
  }
  const total = spec.segments.length
  const segments: Segment[] = spec.segments.map((text, i) => {
    const hasTime = spec.transcriptSource !== 'post_text'
    const duration = material.duration ?? 0
    const startMs = hasTime ? Math.round((i * duration * 1000) / total) : null
    const endMs = hasTime ? Math.round(((i + 1) * duration * 1000) / total) : null
    return {
      id: `seg-${hashString(`${version.id}:${i}`)}`,
      transcript_version_id: version.id,
      start_ms: startMs,
      end_ms: endMs,
      text,
      source_chunk: null,
    }
  })
  db.putTranscript(version, segments)
  return version
}

function maybeFinishJob(jobId: string): void {
  const job = db.getJob(jobId)
  if (!job) return
  if (!job.operations.every((o) => TERMINAL_OP_STATES.includes(o.state))) return
  if (job.state === 'cancelled') return
  const succeeded = job.operations.filter((o) => o.state === 'succeeded').length
  let state: Job['state']
  if (succeeded === job.operations.length) state = 'succeeded'
  else if (succeeded === 0) state = 'failed'
  else state = 'partial'
  const failedOp = job.operations.find((o) => o.state === 'failed')
  job.state = state
  job.stage = 'done'
  if (state === 'failed' && failedOp) job.error_code = failedOp.error_code
  if (state === 'partial' && failedOp) job.error_code = failedOp.error_code
  updateJobProgress(job)
  emitJobEvent(jobId, { type: 'job_state', state })
  emitJobEvent(jobId, { type: 'job_done', state })
}

function startJobRunners(jobId: string, policy: VariantPolicy): void {
  const job = db.getJob(jobId)
  if (!job) return
  job.state = 'running'
  job.stage = 'running'
  emitJobEvent(jobId, { type: 'job_state', state: 'running' })
  const material = db.getMaterial(job.material_id)
  const flags = material ? detectScenarios(material.source_url) : { login: false }
  for (const kind of job.operation) {
    void runOp(jobId, kind, policy)
  }
  if (flags.login) {
    // 800ms 后进入 needs_action：需要登录（site-spec §5.4 魔法标记 login）
    setTimeout(() => {
      const jobNow = db.getJob(jobId)
      if (!jobNow || jobNow.state !== 'running' || cancelledJobs.has(jobId)) return
      pausedJobs.add(jobId)
      const firstRunning = jobNow.operations.find((o) => !TERMINAL_OP_STATES.includes(o.state))
      for (const op of jobNow.operations) {
        if (!TERMINAL_OP_STATES.includes(op.state)) {
          op.state = 'needs_action'
          emitJobEvent(jobId, { type: 'op_state', op: op.kind, state: 'needs_action' })
        }
      }
      if (firstRunning) {
        const error: ApiError = { code: 'LOGIN_REQUIRED', message: ERROR_MESSAGES.LOGIN_REQUIRED, retryable: true }
        emitJobEvent(jobId, { type: 'op_error', op: firstRunning.kind, error })
      }
      jobNow.state = 'needs_action'
      jobNow.error_code = 'LOGIN_REQUIRED'
      emitJobEvent(jobId, { type: 'job_state', state: 'needs_action' })
    }, 800)
  }
}

function handleCreateJobs(materialId: string, body: CreateJobsRequest): { job: Job } {
  const material = db.getMaterial(materialId)
  if (!material) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。请回到资料库重新选择。')
  const operations = body?.operations
  if (!Array.isArray(operations) || operations.length === 0) {
    fail('INVALID_INPUT', '输入有误，请检查后重试。')
  }
  const idem = idempotencyJobs.get(body.idempotency_key)
  if (idem) {
    const existing = db.getJob(idem)
    if (existing) return { job: existing }
  }
  const policy: VariantPolicy = body.variant_policy ?? 'original'
  const job: Job = {
    id: uid('job'),
    material_id: materialId,
    operation: operations,
    state: 'queued',
    stage: 'pending',
    progress: 0,
    error_code: null,
    retry_count: 0,
    lease_until: null,
    cancel_requested: false,
    operations: operations.map((kind) => ({
      kind,
      state: 'queued',
      stage: 'pending',
      progress: 0,
      error_code: null,
      retry_count: 0,
      asset_ids: [],
    })),
  }
  db.putJob(job)
  if (body.idempotency_key) idempotencyJobs.set(body.idempotency_key, job.id)
  emitJobEvent(job.id, { type: 'job_state', state: 'queued' })
  setTimeout(() => startJobRunners(job.id, policy), rand(300, 800))
  return { job }
}

function handleCancelJob(jobId: string): { job: Job } {
  const job = db.getJob(jobId)
  if (!job) fail('INVALID_INPUT', '任务不存在或已结束。')
  if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
    fail('INVALID_INPUT', '任务已结束，无需取消。')
  }
  cancelledJobs.add(jobId)
  pausedJobs.delete(jobId)
  job.cancel_requested = true
  for (const op of job.operations) {
    if (!TERMINAL_OP_STATES.includes(op.state)) {
      op.state = 'cancelled'
      op.stage = 'done'
      emitJobEvent(jobId, { type: 'op_state', op: op.kind, state: 'cancelled' })
    }
  }
  job.state = 'cancelled'
  job.stage = 'done'
  updateJobProgress(job)
  emitJobEvent(jobId, { type: 'job_state', state: 'cancelled' })
  emitJobEvent(jobId, { type: 'job_done', state: 'cancelled' })
  return { job }
}

function handleRetryJob(jobId: string, operations?: OperationKind[]): { job: Job } {
  const job = db.getJob(jobId)
  if (!job) fail('INVALID_INPUT', '任务不存在或已结束。')
  const retryable = job.operations.filter(
    (o) => ['failed', 'cancelled', 'needs_action'].includes(o.state),
  )
  const targets = operations
    ? retryable.filter((o) => operations.includes(o.kind))
    : retryable
  if (targets.length === 0) {
    fail('INVALID_INPUT', '没有可重试的项目。')
  }
  const material = db.getMaterial(job.material_id)
  const flags = material ? detectScenarios(material.source_url) : null
  const policy: VariantPolicy = 'original'
  // 演示语义：魔法标记触发的错误是一次性的，重试只补缺失部分且成功（能力不可用项除外）
  for (const op of targets) {
    if (flags && (flags.failVideo || flags.partial || flags.diskfull || flags.login)) {
      consumedScenarios.add(`${jobId}:${op.kind}`)
    }
    op.retry_count += 1
    op.state = 'queued'
    op.progress = 0
    op.stage = 'pending'
    op.error_code = null
    emitJobEvent(jobId, { type: 'op_state', op: op.kind, state: 'queued' })
  }
  cancelledJobs.delete(jobId)
  pausedJobs.delete(jobId)
  job.state = 'running'
  job.stage = 'running'
  job.retry_count += 1
  job.error_code = null
  emitJobEvent(jobId, { type: 'job_state', state: 'running' })
  setTimeout(() => {
    for (const op of targets) void runOp(jobId, op.kind, policy)
  }, 200)
  return { job }
}

// ===== ⑩ 笔记 =====

function handleCreateNote(materialId: string, _body: { transcript_version_id?: string }): { note: { id: string; material_id: string; transcript_version_id: string; markdown: string; provider: string; model: string; created_at: string } } {
  const material = db.getMaterial(materialId)
  if (!material) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。请回到资料库重新选择。')
  const transcript = db.getLatestTranscript(materialId)
  if (!transcript) {
    fail('INVALID_INPUT', '原文还未提取。请先获取完整文案，再生成笔记。')
  }
  if (!db.isTextAiConfigured()) {
    fail('MODEL_FAILED', '模型请求失败：服务未配置。请到设置页检查配置或换个模型后重试。')
  }
  const settings = db.getRawSettings().text_ai!
  return {
    note: {
      id: uid('note'),
      material_id: materialId,
      transcript_version_id: transcript.version.id,
      markdown: (db.getMeta(materialId) ?? DEMO_SPEC_BY_KEY.generic).note,
      provider: 'openai_compatible',
      model: settings.model,
      created_at: new Date().toISOString(),
    },
  }
}

// ===== ⑪ 问答 =====

function tokenize(question: string): string[] {
  return question
    .split(/[\s，。？！、；：""''（）,.?!;:'"()]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

function handleChat(materialId: string, body: { conversation_id?: string; question: string }): { conversation: Conversation } {
  const material = db.getMaterial(materialId)
  if (!material) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。请回到资料库重新选择。')
  const transcript = db.getLatestTranscript(materialId)
  if (!transcript) {
    fail('INVALID_INPUT', '原文还未提取。回答无法附上出处，建议先获取完整文案。')
  }
  if (!db.isTextAiConfigured()) {
    fail('MODEL_FAILED', '模型请求失败：服务未配置。请到设置页检查配置或换个模型后重试。')
  }
  const question = (body?.question ?? '').trim()
  if (!question) fail('INVALID_INPUT', '输入有误，请检查后重试。')

  const conversation = db.getConversation(materialId) ?? {
    id: uid('conv'),
    material_id: materialId,
    messages: [],
    source_version_ids: [transcript.version.id],
  }
  const userMessage: ChatMessage = { id: uid('msg'), role: 'user', content: question }
  conversation.messages.push(userMessage)

  const tokens = tokenize(question)
  const matched = transcript.segments
    .map((seg, index) => ({ seg, index }))
    .filter(({ seg }) => tokens.some((t) => seg.text.includes(t)))
    .slice(0, 3)

  let assistantMessage: ChatMessage
  if (matched.length === 0) {
    assistantMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: '这份资料中没有提到相关内容。',
      citations: [],
    }
  } else {
    const citations: Citation[] = matched.map(({ seg }) => ({
      transcript_version_id: transcript.version.id,
      segment_id: seg.id,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      quote: seg.text,
    }))
    const bullets = matched.map(({ seg }) => `- ${seg.text.length > 80 ? seg.text.slice(0, 80) + '…' : seg.text}`)
    assistantMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: `根据原文，可以归纳为：\n\n${bullets.join('\n')}`,
      citations,
    }
  }
  conversation.messages.push(assistantMessage)
  db.putConversation(conversation)
  return { conversation }
}

// ===== ⑫ 导出 =====

function handleExport(
  materialId: string,
  body: { scope: string; format: string },
): { export_id: string; download_url: string } {
  const material = db.getMaterial(materialId)
  if (!material) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。请回到资料库重新选择。')
  const { scope, format } = body ?? {}
  if (scope === 'note') {
    if (format !== 'md') fail('INVALID_INPUT', '笔记仅支持导出 Markdown。')
    const note = db.getNote(materialId)
    if (!note) fail('MATERIAL_NOT_FOUND', '暂无笔记，请先生成笔记后再导出。')
    const blob = makeTextBlob(note.markdown, 'text/markdown;charset=utf-8')
    return { export_id: uid('exp'), download_url: URL.createObjectURL(blob) }
  }
  if (scope === 'transcript') {
    const transcript = db.getLatestTranscript(materialId)
    if (!transcript) fail('MATERIAL_NOT_FOUND', '原文还未提取，请先获取完整文案。')
    const { version, segments } = transcript
    if (format === 'txt') {
      const content = segments
        .map((s) => (s.start_ms !== null ? `[${formatShort(s.start_ms)}] ${s.text}` : s.text))
        .join('\n\n')
      return { export_id: uid('exp'), download_url: URL.createObjectURL(makeTextBlob(content)) }
    }
    if (format === 'srt') {
      if (segments.some((s) => s.start_ms === null || s.end_ms === null)) {
        fail('INVALID_INPUT', '这份原文没有时间戳，无法生成 SRT。可导出 TXT 或 Markdown。')
      }
      const content = segments
        .map((s, i) => `${i + 1}\n${formatSrtTimecode(s.start_ms!)} --> ${formatSrtTimecode(s.end_ms!)}\n${s.text}\n`)
        .join('\n')
      return { export_id: uid('exp'), download_url: URL.createObjectURL(makeTextBlob(content, 'application/x-subrip;charset=utf-8')) }
    }
    if (format === 'md') {
      const lines = [`# ${material.title}`, '', `来源：${material.source_url}`, '']
      for (const s of segments) {
        lines.push(s.start_ms !== null ? `**[${formatShort(s.start_ms)}]** ${s.text}` : s.text)
        lines.push('')
      }
      lines.push(`---\n\n*覆盖率 ${Math.round(version.coverage * 100)}%*`)
      return { export_id: uid('exp'), download_url: URL.createObjectURL(makeTextBlob(lines.join('\n'), 'text/markdown;charset=utf-8')) }
    }
    fail('INVALID_INPUT', '不支持的导出格式。')
  }
  fail('INVALID_INPUT', '暂不支持该导出范围（演示版）。')
}

function formatShort(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

// ===== ⑧ 下载 =====

export function mockDownloadAsset(assetId: string, _inline: boolean): string {
  const asset = db.getAsset(assetId)
  if (!asset) fail('ASSET_NOT_FOUND', '这份素材不存在或已被删除。')
  // 本地导入的真实文件：预览、播放、下载都用原文件 object URL
  const imported = importMediaUrls.get(assetId)
  if (imported) return imported
  const spec = db.getMeta(asset.material_id)
  if (asset.kind === 'cover') {
    return demoCoverFor(spec?.coverDims ?? [1920, 1080])
  }
  if (asset.kind === 'video') {
    return aspectKindFor(spec?.coverDims ?? null) === '9x16'
      ? DEMO_MEDIA.video9x16
      : DEMO_MEDIA.video16x9
  }
  if (asset.kind === 'audio') {
    return DEMO_MEDIA.audio
  }
  if (asset.kind === 'image') {
    const dims = spec?.images?.dims ?? [1280, 1707]
    const blob = makePlaceholderImageBlob(dims[0], dims[1], `${dims[0]}×${dims[1]}`)
    return URL.createObjectURL(blob)
  }
  return URL.createObjectURL(
    makeTextBlob('EdayNote 演示字幕文件（占位）\n1\n00:00:01,000 --> 00:00:03,000\n演示文本\n'),
  )
}

// ===== ⑭⑮⑯ 设置 =====

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}

function handleGetProviders() {
  const settings = db.getRawSettings()
  return {
    text_ai: {
      base_url: settings.text_ai?.base_url ?? '',
      api_key_masked: maskKey(settings.text_ai?.api_key ?? ''),
      model: settings.text_ai?.model ?? '',
    },
    transcription: {
      engine: settings.transcription?.engine ?? 'local',
      base_url: settings.transcription?.base_url ?? '',
      api_key_masked: maskKey(settings.transcription?.api_key ?? ''),
      model: settings.transcription?.engine === 'remote' ? settings.transcription.model : LOCAL_TRANSCRIPTION_MODEL,
    },
  }
}

function handleSaveProviders(body: {
  text_ai?: { base_url?: string; api_key?: string; model?: string }
  transcription?: { engine?: string; base_url?: string; api_key?: string; model?: string }
}): { saved: true } {
  const settings = db.getRawSettings()
  if (body?.text_ai) {
    const { base_url = '', model = '' } = body.text_ai
    const api_key = body.text_ai.api_key || settings.text_ai?.api_key || ''
    if (!base_url.trim() || !api_key.trim() || !model.trim()) {
      fail('INVALID_INPUT', '保存失败：文本 AI 服务的三项配置均为必填。配置未生效，请重试。')
    }
    settings.text_ai = { base_url: base_url.trim(), api_key: api_key.includes('****') ? (settings.text_ai?.api_key ?? '') : api_key.trim(), model: model.trim() }
  }
  if (body?.transcription) {
    const t = body.transcription
    const engine = t.engine === 'remote' ? 'remote' : 'local'
    const model = engine === 'local' ? LOCAL_TRANSCRIPTION_MODEL : (t.model ?? '').trim()
    if (!model) {
      fail('INVALID_INPUT', '保存失败：模型名称不能为空。配置未生效，请重试。')
    }
    if (engine === 'remote' && (!(t.base_url ?? '').trim() || !(t.api_key || settings.transcription?.api_key || '').trim())) {
      fail('INVALID_INPUT', '保存失败：远程引擎需要填写接口地址与密钥。配置未生效，请重试。')
    }
    settings.transcription = {
      engine,
      base_url: engine === 'remote' ? (t.base_url ?? '').trim() : '',
      api_key: engine === 'remote' ? (t.api_key?.includes('****') ? (settings.transcription?.api_key ?? '') : (t.api_key || settings.transcription?.api_key || '').trim()) : '',
      model,
    }
  }
  db.putSettings({ ...settings })
  return { saved: true }
}

function handleTestConnection(
  kind: 'text_ai' | 'transcription',
  formValues?: { base_url?: string; api_key?: string; model?: string; engine?: 'local' | 'remote' },
): Promise<TestConnectionResult> {
  return (async () => {
    await wait(rand(800, 2000))
    const settings = db.getRawSettings()
    const saved = kind === 'text_ai' ? settings.text_ai : settings.transcription
    const savedTranscription = kind === 'transcription' ? settings.transcription : null
    const apiKey = formValues?.api_key || saved?.api_key || ''
    const engine = formValues?.engine ?? savedTranscription?.engine ?? 'local'
    const model = kind === 'transcription' && engine === 'local'
      ? LOCAL_TRANSCRIPTION_MODEL
      : (formValues?.model || saved?.model || '').trim()
    const latency = Math.round(rand(120, 900))
    if (apiKey === 'invalid') {
      return { ok: false, latency_ms: latency, model, message: '鉴权失败。密钥无效或已过期，请核对 API Key。' }
    }
    if (apiKey === 'timeout') {
      return { ok: false, latency_ms: latency, model, message: '连接超时（10s 无响应）。请检查地址是否正确、网络是否可达。' }
    }
    if (model.includes('bad')) {
      return { ok: false, latency_ms: latency, model, message: `模型「${model}」不存在。请核对模型名称。` }
    }
    if (kind === 'transcription' && engine === 'local') {
      return { ok: true, latency_ms: latency, model, message: `连接成功。本地引擎已就绪，模型「${model}」可用，耗时 ${latency}ms。` }
    }
    return { ok: true, latency_ms: latency, model, message: `连接成功。模型「${model}」响应正常，耗时 ${latency}ms。` }
  })()
}

// ===== 路由分发 =====

export async function mockRoute(
  method: string,
  path: string,
  body?: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const p = path.split('?')[0]

  if (method === 'GET' && p === '/api/materials') {
    return { materials: Object.values(db.getDb().materials) }
  }
  if (method === 'GET' && /^\/api\/materials\/[^/]+$/.test(p)) {
    const id = p.split('/')[3]
    const material = db.getMaterial(id)
    if (!material) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。')
    const capabilities = db.getCapabilities(id) ?? buildCapabilities(db.getMeta(id) ?? DEMO_SPEC_BY_KEY[specKeyForPlatform(material.platform)])
    return { material, capabilities, jobs: [], note: db.getNote(id) ?? null, conversation: db.getConversation(id) ?? null }
  }
  // ① resolve
  if (method === 'POST' && p === '/api/materials/resolve') {
    const b = body as { raw_input?: string; candidate_id?: string }
    // 模拟解析延迟（与真实流程一致：找到 URL 后还要获取作品信息）
    await wait(rand(400, 900))
    return handleResolve(b?.raw_input ?? '', b?.candidate_id)
  }
  // ② import
  if (method === 'POST' && p === '/api/materials/import') {
    await wait(rand(300, 700))
    return handleImport(body as File)
  }
  // 扩展：资产列表
  if (method === 'GET' && /^\/api\/materials\/[^/]+\/assets$/.test(p)) {
    const id = p.split('/')[3]
    if (!db.getMaterial(id)) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。')
    return db.listAssets(id)
  }
  // 扩展：删除资料
  if (method === 'DELETE' && /^\/api\/materials\/[^/]+$/.test(p)) {
    const id = p.split('/')[3]
    if (!db.getMaterial(id)) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。')
    db.removeMaterial(id)
    return { deleted: true }
  }
  // ③ 创建任务
  if (method === 'POST' && /^\/api\/materials\/[^/]+\/jobs$/.test(p)) {
    const id = p.split('/')[3]
    return handleCreateJobs(id, body as CreateJobsRequest)
  }
  // ④ 查询任务
  if (method === 'GET' && /^\/api\/jobs\/[^/]+$/.test(p)) {
    const job = db.getJob(p.split('/')[3])
    if (!job) fail('INVALID_INPUT', '任务不存在或已结束。')
    return { job }
  }
  // ⑥ 取消
  if (method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(p)) {
    return handleCancelJob(p.split('/')[3])
  }
  // ⑦ 重试
  if (method === 'POST' && /^\/api\/jobs\/[^/]+\/retry$/.test(p)) {
    const b = body as { operations?: OperationKind[] }
    return handleRetryJob(p.split('/')[3], b?.operations)
  }
  // ⑧ 下载（返回 blob: URL，由 <a download> 触发保存）
  if (method === 'GET' && /^\/api\/assets\/[^/]+\/download$/.test(p)) {
    return mockDownloadAsset(p.split('/')[3], path.includes('inline=1'))
  }
  // ⑨ 原文
  if (method === 'GET' && /^\/api\/materials\/[^/]+\/transcript$/.test(p)) {
    const id = p.split('/')[3]
    if (!db.getMaterial(id)) fail('MATERIAL_NOT_FOUND', '这份资料不存在或已被删除。')
    const transcript = db.getLatestTranscript(id)
    if (!transcript) fail('MATERIAL_NOT_FOUND', '原文还未提取。请先获取完整文案。')
    const params = new URLSearchParams(path.split('?')[1] ?? '')
    const page = Number(params.get('page') ?? '1')
    const pageSize = Number(params.get('page_size') ?? '100')
    const start = (page - 1) * pageSize
    return {
      version: transcript.version,
      segments: transcript.segments.slice(start, start + pageSize),
      total_segments: transcript.segments.length,
      page,
      page_size: pageSize,
    }
  }
  // ⑩ 笔记（2~5s 延迟，site-spec §5.4）
  if (method === 'POST' && /^\/api\/materials\/[^/]+\/notes$/.test(p)) {
    await wait(rand(2000, 5000))
    return handleCreateNote(p.split('/')[3], body as { transcript_version_id?: string })
  }
  // ⑪ 问答（1~3s 延迟）
  if (method === 'POST' && /^\/api\/materials\/[^/]+\/chat$/.test(p)) {
    await wait(rand(1000, 3000))
    return handleChat(p.split('/')[3], body as { conversation_id?: string; question: string })
  }
  // ⑫ 导出
  if (method === 'POST' && /^\/api\/materials\/[^/]+\/exports$/.test(p)) {
    return handleExport(p.split('/')[3], body as { scope: string; format: string })
  }
  // ⑭ 设置读取
  if (method === 'GET' && p === '/api/settings/providers') {
    return handleGetProviders()
  }
  // ⑮ 设置保存
  if (method === 'PUT' && p === '/api/settings/providers') {
    return handleSaveProviders(body as Parameters<typeof handleSaveProviders>[0])
  }
  // ⑯ 测试连接
  if (method === 'POST' && /^\/api\/settings\/providers\/(text_ai|transcription)\/test$/.test(p)) {
    const kind = p.split('/')[4] as 'text_ai' | 'transcription'
    return handleTestConnection(kind, body as Parameters<typeof handleTestConnection>[1])
  }
  // ⑬ 健康检查（Mock 恒为健康）
  if (method === 'GET' && p === '/api/health') {
    return {
      status: 'ok',
      checks: { backend: 'ok', database: 'ok', ffmpeg: 'ok', model: db.isTextAiConfigured() ? 'ok' : 'not_configured', disk: 'ok' },
    }
  }
  fail('INVALID_INPUT', '接口不存在（演示版）。')
}
