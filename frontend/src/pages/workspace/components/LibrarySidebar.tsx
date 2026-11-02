import { useState } from 'react'
import { Search, Trash2, Library, Plus, FolderOpen } from 'lucide-react'
import { TaskBadge } from '../../../components/TaskBadge'
import { ProgressLine } from '../../../components/ProgressLine'
import { EmptyState } from '../../../components/EmptyState'
import { ConfirmDialog } from '../../../components/ConfirmDialog'
import { useWorkspaceStore } from '../../../stores/workspaceStore'
import { useUiStore } from '../../../stores/uiStore'
import { deleteMaterial } from '../../../api/materials'
import { relativeTime, platformLabel } from '../../../utils/format'
import type { Job, Material } from '../../../api/types'

const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'partial', 'needs_action']

/** F07/F14：左栏资料库 + 任务状态 */
export function LibrarySidebar() {
  const loading = useWorkspaceStore((s) => s.loading)
  const loadError = useWorkspaceStore((s) => s.loadError)
  const hydrate = useWorkspaceStore((s) => s.hydrate)
  const materials = useWorkspaceStore((s) => s.materials)
  const currentMaterialId = useWorkspaceStore((s) => s.currentMaterialId)
  const setCurrentMaterial = useWorkspaceStore((s) => s.setCurrentMaterial)
  const removeMaterial = useWorkspaceStore((s) => s.removeMaterial)
  const setActiveNarrowTab = useWorkspaceStore((s) => s.setActiveNarrowTab)
  const jobsByMaterial = useWorkspaceStore((s) => s.jobsByMaterial)
  const pushToast = useUiStore((s) => s.pushToast)
  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Material | null>(null)

  const filtered = search.trim()
    ? materials.filter(
        (m) =>
          m.title.toLowerCase().includes(search.toLowerCase()) ||
          m.author.toLowerCase().includes(search.toLowerCase()),
      )
    : materials

  function handleSelect(id: string) {
    setCurrentMaterial(id)
    setActiveNarrowTab('workspace')
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteMaterial(deleteTarget.id)
      removeMaterial(deleteTarget.id)
      pushToast('success', '已删除资料')
    } catch (e) {
      pushToast('danger', e instanceof Error ? e.message : '删除失败，请稍后重试')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <h2 className="library-heading"><Library size={17} className="text-accent" /> 资料库 <span className="ml-auto rounded bg-hov px-2 font-mono text-[11px] text-ink-3">{materials.length}</span></h2>
      <div className="px-4"><button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-hov text-[13px] text-ink transition-colors hover:border-accent" onClick={() => { setCurrentMaterial(null); setActiveNarrowTab('workspace'); document.querySelector<HTMLTextAreaElement>('textarea')?.focus() }}><Plus size={15} /> 新建资料</button></div>

      {/* 搜索框 */}
      <div className="shrink-0 px-4 pt-3">
        <div className="relative">
          <Search
            size={16}
            strokeWidth={1.5}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索标题或作者"
            className="h-8 w-full rounded-md border border-line-strong bg-page pl-8 pr-3 text-[13px] text-ink outline-none transition-colors duration-150 focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,23,0.12)]"
            aria-label="搜索标题或作者"
          />
        </div>
      </div>

      {/* 资料列表 */}
      <nav className="mt-5 flex-1 overflow-y-auto px-3 pb-4" aria-label="资料库列表">
        {loading ? <p className="p-6 text-center text-xs text-ink-3">正在加载资料库…</p> : loadError ? <EmptyState icon={Library} text={loadError} actionLabel="重新连接" onAction={() => void hydrate()} /> : materials.length === 0 ? <EmptyState icon={FolderOpen} text="还没有收藏的资料。导入第一份内容，开启你的研究。" /> : filtered.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-ink-3">
            {`没有匹配「${search}」的资料`}
          </p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((m) => {
              const isSelected = m.id === currentMaterialId
              const jobs = jobsByMaterial[m.id] ?? []
              const latestJob = getLatestActiveJob(jobs) ?? jobs[jobs.length - 1]
              return (
                <li key={m.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelect(m.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleSelect(m.id)
                      }
                    }}
                    className={`library-item group relative cursor-pointer rounded-md px-3 py-2.5 transition-colors duration-150 hover:bg-hov ${
                      isSelected ? 'selected' : ''
                    }`}
                  >

                    <div className="flex items-start justify-between gap-2">
                      {m.cover_url ? <img src={m.cover_url} alt="" className="library-thumb" /> : <div className="library-thumb flex items-center justify-center"><FolderOpen size={18} className="text-ink-3" /></div>}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{m.title}</p>
                        <p className="mt-0.5 truncate text-[11px] text-ink-3">
                          {platformLabel(m.platform)} · {m.author} · {relativeTime(m.created_at)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget(m)
                        }}
                        className="shrink-0 cursor-pointer rounded p-1 text-ink-3 opacity-0 transition-opacity duration-150 hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100"
                        aria-label={`删除「${m.title}」`}
                      >
                        <Trash2 size={12} strokeWidth={1.5} />
                      </button>
                    </div>

                    {/* 任务行 */}
                    {latestJob && (
                      <div className="mt-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] text-ink-2">
                            {getTaskRowText(latestJob)}
                          </span>
                          <TaskBadge state={latestJob.state} />
                        </div>
                        {latestJob.state === 'running' && (
                          <div className="mt-1">
                            <ProgressLine progress={latestJob.progress} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </nav>

      {/* 删除确认弹层 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={`删除「${deleteTarget?.title ?? ''}」？`}
        body="将从资料库移除这份资料及相关记录。真实模式会保留本地回收备份；演示模式不提供恢复。"
        confirmLabel="删除资料"
        cancelLabel="保留"
        confirmVariant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

/** 找到最近一个未终态的 job，没有则取最后一个 job */
function getLatestActiveJob(jobs: Job[]): Job | undefined {
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (!TERMINAL_STATES.includes(jobs[i].state)) return jobs[i]
  }
  return undefined
}

/** content-plan §4 任务行文案 */
function getTaskRowText(job: Job): string {
  const opNames = job.operation.map((o) => operationLabel(o)).join('、')
  switch (job.state) {
    case 'queued':
      return `${opNames} · 排队中`
    case 'running':
      return `${stageLabel(job.stage)}… ${Math.round(job.progress * 100)}%`
    case 'partial':
      return `${opNames} · 部分完成`
    case 'succeeded':
      return `${opNames} · 已完成`
    case 'failed':
      return `${opNames} · 失败`
    case 'cancelled':
      return `${opNames} · 已取消`
    case 'needs_action':
      return `${opNames} · 需要操作`
    default:
      return opNames
  }
}

function operationLabel(kind: string): string {
  switch (kind) {
    case 'cover': return '提取封面'
    case 'transcript': return '完整文案'
    case 'video': return '下载视频'
    case 'images': return '提取图片'
    case 'audio': return '导出MP3'
    default: return kind
  }
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'fetching': return '获取中'
    case 'downloading': return '下载中'
    case 'transcribing': return '转写中'
    case 'merging': return '合并中'
    case 'processing': return '处理中'
    case 'extracting': return '提取中'
    case 'converting': return '转换中'
    case 'running': return '处理中'
    case 'pending': return '排队中'
    default: return '处理中'
  }
}
