import { useEffect, useState } from 'react'
import { FileText, Copy, Download } from 'lucide-react'
import { Button } from '../../../../components/Button'
import { EmptyState } from '../../../../components/EmptyState'
import { Skeleton } from '../../../../components/Skeleton'
import { Spinner } from '../../../../components/Spinner'
import { getCompleteTranscript as getTranscript } from '../transcriptData'
import { createJobs } from '../../../../api/materials'
import { createExport } from '../../../../api/materials'
import { useWorkspaceStore, EMPTY_JOBS } from '../../../../stores/workspaceStore'
import { useUiStore } from '../../../../stores/uiStore'
import { copyText, downloadUrl } from '../../../../utils/files'
import {
  formatClockMs,
  formatPercent,
  transcriptSourceLabel,
} from '../../../../utils/format'
import type { Segment, TranscriptVersion } from '../../../../api/types'

interface TranscriptTabProps {
  materialId: string
}

/** F08：完整文案标签 */
export function TranscriptTab({ materialId }: TranscriptTabProps) {
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState<TranscriptVersion | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [notFound, setNotFound] = useState(false)
  const jobs = useWorkspaceStore((s) => s.jobsByMaterial[materialId] ?? EMPTY_JOBS)
  const transcriptRunning = jobs.some((j) =>
    j.operations.some((o) => o.kind === 'transcript' && (o.state === 'running' || o.state === 'queued')),
  )
  const pushToast = useUiStore((s) => s.pushToast)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    getTranscript(materialId)
      .then((resp) => {
        if (cancelled) return
        setVersion(resp.version)
        setSegments(resp.segments)
      })
      .catch(() => {
        if (cancelled) return
        setNotFound(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [materialId, transcriptRunning])

  async function handleCopyAll() {
    const text = segments
      .map((s) => (s.start_ms !== null ? `[${formatClockMs(s.start_ms)}] ${s.text}` : s.text))
      .join('\n\n')
    const ok = await copyText(text)
    pushToast(ok ? 'success' : 'danger', ok ? '已复制完整文案' : '复制失败，浏览器可能限制了剪贴板。可改用「选中后 Ctrl+C」复制全文。')
  }

  async function handleExport(format: 'txt' | 'srt' | 'md') {
    try {
      const resp = await createExport(materialId, { scope: 'transcript', format })
      downloadUrl(resp.download_url, `transcript.${format}`)
      pushToast('success', `已导出 ${format.toUpperCase()}`)
    } catch (e) {
      pushToast('danger', e instanceof Error ? e.message : '导出失败，请稍后重试')
    }
  }

  if (loading) {
    return (
      <div className="space-y-3 py-6">
        <Skeleton width="40%" height={16} />
        <Skeleton width="100%" height={14} />
        <Skeleton width="90%" height={14} />
        <Skeleton width="60%" height={14} />
      </div>
    )
  }

  if (notFound && !transcriptRunning) {
    return (
      <EmptyState
        icon={FileText}
        text="还没有文案。配置转写服务后，点击「完整文案」转写当前音视频；已有文字稿也可以作为本地资料导入。"
        actionLabel="获取完整文案"
        onAction={async () => {
          try {
            const response = await createJobs(materialId, { operations: ['transcript'], idempotency_key: crypto.randomUUID() })
            useWorkspaceStore.getState().upsertJob(response.job)
          } catch (error) { pushToast('danger', error instanceof Error ? error.message : '无法提取原文') }
        }}
      />
    )
  }

  if ((!version || segments.length === 0) && !transcriptRunning) {
    return <EmptyState icon={FileText} text="这份资料暂时没有可阅读的原文。可以导入字幕或文字文件，或配置转写服务后提取。" />
  }

  if (!version || segments.length === 0) {
    return (
      <div className="flex h-full items-center justify-center py-6">
        <Spinner className="text-info" />
        <span className="ml-2 text-sm text-ink-2">正在获取文案…</span>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[720px] py-6">
      {/* 覆盖率 + 来源 */}
      <div className="mb-4 flex items-center gap-4 text-[12px] text-ink-3">
        <span>来源 {transcriptSourceLabel(version.source)}</span>
        <span>覆盖率 {formatPercent(version.coverage)}</span>
        {version.status === 'partial' && (
          <span className="text-warning">
            缺失区间{' '}
            {version.failed_ranges
              .map((r) => `${formatClockMs(r.start_ms)}–${formatClockMs(r.end_ms)}`)
              .join('、')}
          </span>
        )}
      </div>

      {/* 分段原文 */}
      <div className="space-y-3">
        {segments.map((seg) => (
          <div key={seg.id} className="flex gap-3 leading-relaxed">
            {seg.start_ms !== null ? (
              <span className="mt-0.5 shrink-0 font-mono text-[12px] text-ink-2">
                {formatClockMs(seg.start_ms)}
              </span>
            ) : (
              <span className="mt-0.5 shrink-0 text-[12px] text-ink-3">—</span>
            )}
            <span className="flex-1 text-sm text-ink">{seg.text}</span>
          </div>
        ))}
      </div>

      {/* 操作按钮 */}
      <div className="mt-6 flex items-center gap-2 border-t border-line pt-4">
        <Button variant="secondary" size="sm" onClick={handleCopyAll}>
          <Copy size={12} strokeWidth={1.5} />
          复制全文
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleExport('txt')}>
          <Download size={12} strokeWidth={1.5} />
          导出 TXT
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleExport('srt')}>
          导出 SRT
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleExport('md')}>
          导出 Markdown
        </Button>
      </div>
    </div>
  )
}
