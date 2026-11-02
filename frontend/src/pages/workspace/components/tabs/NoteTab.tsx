import { useState } from 'react'
import { useNavigate } from 'react-router'
import { NotebookPen } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '../../../../components/Button'
import { EmptyState } from '../../../../components/EmptyState'
import { Spinner } from '../../../../components/Spinner'
import { createNote, getTranscript } from '../../../../api/materials'
import { useWorkspaceStore } from '../../../../stores/workspaceStore'
import { useUiStore } from '../../../../stores/uiStore'
import { useQuotaStore, isManagedAiReady } from '../../../../stores/quotaStore'
import { copyText } from '../../../../utils/files'
import { formatDateTime } from '../../../../utils/format'

interface NoteTabProps {
  materialId: string
}

/** F09：AI 笔记标签 */
export function NoteTab({ materialId }: NoteTabProps) {
  const note = useWorkspaceStore((s) => s.notesByMaterial[materialId] ?? null)
  const putNote = useWorkspaceStore((s) => s.putNote)
  const pushToast = useUiStore((s) => s.pushToast)
  useQuotaStore()
  const configured = isManagedAiReady()
  const navigate = useNavigate()
  const [generating, setGenerating] = useState(false)

  async function handleGenerate(local = !configured) {
    setGenerating(true)
    try {
      const transcript = await getTranscript(materialId)
      const resp = await createNote(materialId, {
        transcript_version_id: transcript.version.id,
        ...(local ? { provider: 'extractive' } : {}),
      })
      putNote(resp.note)
      pushToast('success', local ? '本地摘录已整理' : '笔记已生成')
    } catch (e) {
      const msg = e instanceof Error ? e.message : '笔记生成失败，请稍后重试'
      pushToast('danger', msg)
    } finally {
      setGenerating(false)
    }
  }

  // 正在生成
  if (generating) {
    return (
      <div className="mx-auto max-w-[720px] py-6">
        <div className="flex items-center gap-2 text-sm text-ink-2" aria-live="polite">
          <Spinner className="text-info" />
          正在生成笔记…
          <span className="text-ink-3">（可先切到「完整文案」标签阅读）</span>
        </div>
      </div>
    )
  }

  // 有笔记
  if (note) {
    return (
      <div className="mx-auto max-w-[720px] py-6">
        <div className="mb-4 flex items-center gap-2 text-[12px] text-ink-3">
          <span>{note.provider === 'extractive' ? '本地原文摘录 · 非 AI 生成' : 'AI 笔记 · 基于原文生成'}</span>
          <span>· {note.model}</span>
          <span>· {formatDateTime(note.created_at)}</span>
        </div>
        <div className="md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            img: ({ alt }) => <span className="text-xs text-ink-3">[图片已隐藏{alt ? `：${alt}` : ''}]</span>,
            a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          }}>{note.markdown}</ReactMarkdown>
        </div>
        <div className="mt-6 flex items-center gap-2 border-t border-line pt-4">
          <Button variant="secondary" size="sm" onClick={() => void handleGenerate()}>
            <NotebookPen size={12} strokeWidth={1.5} />
            重新生成
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const ok = await copyText(note.markdown)
              pushToast(
                ok ? 'success' : 'danger',
                ok
                  ? '已复制当前笔记'
                  : '复制失败，浏览器可能限制了剪贴板。可改用「选中后 Ctrl+C」复制全文。',
              )
            }}
          >
            复制 Markdown
          </Button>
        </div>
      </div>
    )
  }

  // 无笔记
  return (
    <div><EmptyState
      icon={NotebookPen}
      text={configured ? "将原文整理为清晰的结构化笔记，保留内容脉络。" : "无需 API Key 即可整理本地原文摘录。AI 总结与问答需启用平台额度或验证个人 API Key。"}
      actionLabel={configured ? "生成 AI 笔记" : "整理本地摘录"}
      onAction={() => void handleGenerate()}
    />{!configured && <div className="-mt-6 pb-8 text-center"><Button variant="ghost" onClick={() => navigate('/settings')}>查看 AI 使用方式</Button></div>}</div>
  )
}
