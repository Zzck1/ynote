import { Check, X, AlertTriangle, Zap } from 'lucide-react'
import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { ProgressLine } from '../../../components/ProgressLine'
import { createJobs } from '../../../api/materials'
import { retryJob, cancelJob } from '../../../api/jobs'
import { ApiRequestError } from '../../../api/errors'
import { useWorkspaceStore, EMPTY_JOBS } from '../../../stores/workspaceStore'
import { useUiStore } from '../../../stores/uiStore'
import { formatDurationSec, platformLabel } from '../../../utils/format'
import type {
  Job,
  JobOperation,
  Material,
  MaterialCapabilities,
  OperationKind,
  VariantPolicy,
} from '../../../api/types'

/** content-plan §2.2 操作按钮文案 */
const OP_LABELS: Record<OperationKind, string> = {
  cover: '提取封面',
  transcript: '完整文案',
  video: '准备视频',
  images: '提取图片',
  audio: '导出 MP3',
}

/** content-plan §2.2 进行中文案 */
const OP_PROGRESS_LABELS: Record<OperationKind, string> = {
  cover: '正在保存封面…',
  transcript: '正在获取文案…',
  video: '正在准备视频…',
  images: '正在保存图片…',
  audio: '正在转换音频…',
}

const ALL_OPS: OperationKind[] = ['cover', 'transcript', 'video', 'images', 'audio']

/** content-plan §3 错误码 → 用户文案（前端映射，后端 message 以此为准） */
const ERROR_MESSAGES: Record<string, string> = {
  MATERIAL_NOT_FOUND: '这份资料不存在或已被删除。请回到资料库重新选择。',
  ASSET_NOT_FOUND: '这份作品没有对应素材。可改用其他提取项。',
  LOGIN_REQUIRED: '这项内容需要登录平台后才能获取。请在浏览器登录后重试，或导入已下载的本地文件。',
  RATE_LIMITED: '平台暂时限制了访问频率，请稍后重试。',
  LINK_EXPIRED: '链接已过期或内容被删除。请回到原作品重新分享，拿到新链接后再来。',
  NO_CLEAN_SOURCE: '仅处理原始媒体文件。',
  TRANSCRIBE_FAILED: '音频转写未完成，请检查转写服务配置，或导入已有字幕后重试。',
  MODEL_FAILED: '模型请求失败：服务未配置。请到设置页检查配置或换个模型后重试。',
  DISK_FULL: '磁盘空间不足，请清理空间后重试。',
  INVALID_INPUT: '输入有误，请检查后重试。',
}

/** 找到某操作最近一次的执行状态 */
function getOpStatus(jobs: Job[], kind: OperationKind): JobOperation | undefined {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const op = jobs[i].operations.find((o) => o.kind === kind)
    if (op) return op
  }
  return undefined
}

/** 判断某操作是否正在运行（用于禁用按钮） */
function isOpRunning(jobs: Job[], kind: OperationKind): boolean {
  const op = getOpStatus(jobs, kind)
  if (!op) return false
  return op.state === 'running' || op.state === 'queued' || op.state === 'needs_action'
}

interface MaterialHeaderProps {
  material: Material
  capabilities: MaterialCapabilities
}

export function MaterialHeader({ material, capabilities }: MaterialHeaderProps) {
  const jobs = useWorkspaceStore((s) => s.jobsByMaterial[material.id] ?? EMPTY_JOBS)
  const upsertJob = useWorkspaceStore((s) => s.upsertJob)
  const variantPolicy: VariantPolicy = 'original'
  const generateNote = useWorkspaceStore((s) => s.generateNote)
  const setGenerateNote = useWorkspaceStore((s) => s.setGenerateNote)
  const pushToast = useUiStore((s) => s.pushToast)

  const isImagePost = material.content_type === 'image_post'
  const hasDuration = material.duration !== null
  const hasCover = material.cover_url !== null

  // 检查是否有正在运行的任务（用于「一键全部提取」按钮）
  const hasRunningJob = jobs.some(
    (j) => j.state === 'running' || j.state === 'queued' || j.state === 'needs_action',
  )

  async function handleOperation(kind: OperationKind) {
    const idempotencyKey =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`
    const payload = {
      operations: [kind],
      idempotency_key: idempotencyKey,
      ...(kind === 'video' ? { variant_policy: variantPolicy } : {}),
    }
    try {
      const resp = await createJobs(material.id, payload)
      upsertJob(resp.job)
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : '操作失败，请稍后重试'
      pushToast('danger', msg)
    }
  }

  async function handleExtractAll() {
    const available = ALL_OPS.filter((k) => capabilities[k]?.available)
    if (available.length === 0) {
      pushToast('warning', '没有可提取的项目')
      return
    }
    const idempotencyKey =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`
    const payload = {
      operations: available,
      idempotency_key: idempotencyKey,
      ...(available.includes('video') ? { variant_policy: variantPolicy } : {}),
      ...(generateNote ? { generate_note: true } : {}),
    }
    try {
      const resp = await createJobs(material.id, payload)
      upsertJob(resp.job)
      pushToast('info', `已发起 ${available.length} 项提取`)
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : '操作失败，请稍后重试'
      pushToast('danger', msg)
    }
  }

  async function handleRetry(kind: OperationKind) {
    // 找到包含该操作的最近一个 job
    const job = [...jobs].reverse().find((j) => j.operations.some((o) => o.kind === kind))
    if (!job) return
    try {
      const resp = await retryJob(job.id, [kind])
      upsertJob(resp.job)
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : '重试失败，请稍后再试'
      pushToast('danger', msg)
    }
  }

  async function handleCancel(kind: OperationKind) {
    const job = [...jobs].reverse().find((j) => j.operations.some((o) => o.kind === kind))
    if (!job) return
    try {
      const resp = await cancelJob(job.id)
      upsertJob(resp.job)
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : '取消失败'
      pushToast('danger', msg)
    }
  }


  return (
    <div className="material-card rounded-lg border border-line bg-page p-6">
      {/* 封面 + 字段行 */}
      <div className="flex gap-4">
        {/* 封面缩略图 */}
        <div className="shrink-0">
          {hasCover ? (
            <img
              src={material.cover_url ?? undefined}
              alt={`${material.title} 封面`}
              className="rounded-sm border border-line"
              style={{
                width: isImagePost ? 42 : 96,
                height: isImagePost ? 74 : 54,
                objectFit: 'cover',
              }}
            />
          ) : (
            <div
              className="flex items-center justify-center rounded-sm border border-line bg-subtle"
              style={{ width: 96, height: 54 }}
            >
              <span className="font-mono text-[12px] text-ink-3">无封面</span>
            </div>
          )}
        </div>

        {/* 字段行 */}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium leading-relaxed text-ink">{material.title}</h3>
          <div className="mt-1 space-y-0 text-[13px] text-ink-2">
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span>平台 {platformLabel(material.platform)}</span>
              {material.author && <span>作者 {material.author}</span>}
              {hasDuration && (
                <span className="font-mono">时长 {formatDurationSec(material.duration)}</span>
              )}
            </div>
            <div className="truncate">
              <span className="text-ink-3">来源 </span>
              <a
                href={material.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[13px] text-ink-2 underline decoration-ink-4 underline-offset-2 transition-colors hover:text-ink"
              >
                {material.source_url}
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* 分隔线 */}
      <div className="my-5 border-t border-line" />

      {/* 分隔线 */}
      <div className="my-5 border-t border-line" />

      {/* 同时生成笔记 + 一键全部提取 + 五操作按钮 */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <input
            type="checkbox"
            checked={generateNote}
            onChange={(e) => setGenerateNote(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong accent-ink"
          />
          同时生成笔记
        </label>
        <span className="text-[13px] text-ink-3">提取完成后自动生成 AI 笔记，记住本次选择</span>

        <div className="flex-1" />

        {/* 一键全部提取 */}
        <Button
          variant="primary"
          className="!h-10"
          loading={hasRunningJob}
          loadingText="正在提取…"
          onClick={handleExtractAll}
        >
          <Zap size={16} strokeWidth={1.5} />
          一键全部提取
        </Button>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-3">跳过不可用的项目，完成后逐项显示结果</p>

      {/* 五操作按钮 */}
      <div className="mt-4 flex flex-wrap gap-2">
        {ALL_OPS.map((kind) => {
          const cap = capabilities[kind]
          const available = cap?.available ?? false
          const reason = cap?.reason
          const opStatus = getOpStatus(jobs, kind)
          const running = isOpRunning(jobs, kind)

          return (
            <Button
              key={kind}
              variant="secondary"
              size="sm"
              loading={running}
              loadingText={OP_PROGRESS_LABELS[kind]}
              progress={running ? opStatus?.progress : undefined}
              unavailableReason={!available ? (reason || '此来源暂不支持该操作') : undefined}
              onClick={() => !running && available && handleOperation(kind)}
            >
              {OP_LABELS[kind]}
            </Button>
          )
        })}
      </div>

      {/* 状态行 */}
      <div className="mt-4 space-y-1.5" aria-live="polite">
        {ALL_OPS.map((kind) => {
          const op = getOpStatus(jobs, kind)
          if (!op) return null
          const label = OP_LABELS[kind]

          if (op.state === 'succeeded') {
            return (
              <div key={kind} className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <Check size={16} strokeWidth={1.5} className="shrink-0 text-success" />
                <span>{label}已就绪</span>
                {kind === 'video' && (
                  <span className="text-ink-3">· {'原始媒体'}</span>
                )}
              </div>
            )
          }

          if (op.state === 'failed') {
            const errMsg = op.error_code ? ERROR_MESSAGES[op.error_code] ?? '操作失败' : '操作失败'
            return (
              <div key={kind} className="flex items-start gap-1.5 text-[13px] text-danger">
                <X size={16} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                <span className="flex-1">
                  {label}失败，{errMsg}
                </span>
                <Button variant="ghost" size="sm" onClick={() => handleRetry(kind)}>
                  重试这一项
                </Button>
              </div>
            )
          }

          if (op.state === 'cancelled') {
            return (
              <div key={kind} className="flex items-center gap-1.5 text-[13px] text-ink-3">
                <span className="h-1.5 w-1.5 rounded-full bg-ink-4" />
                {label}已取消。已完成的素材保留，未开始的不再执行。
              </div>
            )
          }

          if (op.state === 'running' || op.state === 'queued') {
            return (
              <div key={kind}>
                <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  <Spinner size={12} className="text-info" />
                  <span>{OP_PROGRESS_LABELS[kind]}</span>
                  {op.progress > 0 && (
                    <span className="font-mono text-[13px]">{`${Math.round(op.progress * 100)}%`}</span>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => handleCancel(kind)}>
                    取消
                  </Button>
                </div>
                {op.progress > 0 && (
                  <div className="mt-1">
                    <ProgressLine progress={op.progress} />
                  </div>
                )}
              </div>
            )
          }

          if (op.state === 'needs_action') {
            const errMsg = op.error_code ? ERROR_MESSAGES[op.error_code] ?? '需要操作' : '需要操作'
            return (
              <div key={kind} className="flex items-start gap-1.5 text-[13px] text-warning">
                <AlertTriangle size={16} strokeWidth={1.5} className="mt-0.5 shrink-0" />
                <span className="flex-1">
                  {label}：{errMsg}
                </span>
                <Button variant="ghost" size="sm" onClick={() => handleRetry(kind)}>
                  重试这一项
                </Button>
              </div>
            )
          }

          return null
        })}
      </div>
    </div>
  )
}
