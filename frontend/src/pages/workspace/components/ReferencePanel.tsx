import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { EmptyState } from '../../../components/EmptyState'
import { Spinner } from '../../../components/Spinner'
import { getCompleteTranscript as getTranscript } from './transcriptData'
import { seekMaterial } from './mediaPlayback'
import { useWorkspaceStore, EMPTY_JOBS } from '../../../stores/workspaceStore'
import { formatClockMs, transcriptSourceLabel, formatPercent } from '../../../utils/format'
import type { Segment, TranscriptVersion } from '../../../api/types'

interface ReferencePanelProps {
  materialId: string
}

/** F12：右侧原文参照 */
export function ReferencePanel({ materialId }: ReferencePanelProps) {
  const [version, setVersion] = useState<TranscriptVersion | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const highlightSegmentId = useWorkspaceStore((s) => s.highlightSegmentId)
  const setHighlightSegmentId = useWorkspaceStore((s) => s.setHighlightSegmentId)
  const jobs = useWorkspaceStore((s) => s.jobsByMaterial[materialId] ?? EMPTY_JOBS)
  const jobStateKey = jobs.map(j => `${j.id}:${j.state}:${j.operations.map(o => o.state).join()}`).join()
  const containerRef = useRef<HTMLDivElement>(null)

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
  }, [materialId, jobStateKey])

  // 高亮 + 滚动到指定段落
  useEffect(() => {
    if (!highlightSegmentId || !containerRef.current) return
    const el = containerRef.current.querySelector<HTMLElement>(
      `[data-segment-id="${CSS.escape(highlightSegmentId)}"]`,
    )
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    // 5 秒后清除高亮（点击其他区域时也清除）
    const timer = setTimeout(() => setHighlightSegmentId(null), 5000)
    return () => clearTimeout(timer)
  }, [highlightSegmentId, setHighlightSegmentId])

  return (
    <div className="reference-shell flex flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-[15px] font-semibold text-ink">原文参照</h2>
      </div>
      <p className="px-4 text-[12px] text-ink-3">点击时间戳跳转播放位置</p>

      <div ref={containerRef} className="mt-2 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Spinner className="text-info" />
          </div>
        ) : notFound ? (
          <EmptyState
            icon={FileText}
            text="原文还未提取。AI 笔记和问答都以完整原文为准，建议先获取文案。"
          />
        ) : version && segments.length > 0 ? (
          <div>
            {/* 覆盖率附注 */}
            <p className="mb-3 text-[12px] text-ink-3">
              {transcriptSourceLabel(version.source)} · 覆盖率 {formatPercent(version.coverage)}
            </p>
            {/* 分段原文 */}
            <div className="space-y-3">
              {segments.map((seg, i) => (
                <div
                  key={seg.id}
                  data-segment-id={seg.id}
                  className={`rounded-sm pl-3 transition-colors duration-150 ${
                    highlightSegmentId === seg.id
                      ? 'border-l-2 border-ink bg-sel'
                      : 'border-l-2 border-transparent'
                  }`}
                >
                  <div className="flex gap-2">
                    {seg.start_ms !== null ? (
                      <button
                        type="button"
                        className="mt-0.5 shrink-0 cursor-pointer font-mono text-[12px] text-ink-2 transition-colors duration-150 hover:text-ink hover:underline"
                        onClick={() => {
                          seekMaterial(materialId, seg.start_ms!)
                        }}
                        aria-label={`跳转到 ${formatClockMs(seg.start_ms)}`}
                      >
                        {formatClockMs(seg.start_ms)}
                      </button>
                    ) : (
                      <span className="mt-0.5 shrink-0 text-[12px] text-ink-3">
                        第 {i + 1} 段
                      </span>
                    )}
                    <p className="flex-1 text-sm leading-relaxed text-ink">{seg.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
