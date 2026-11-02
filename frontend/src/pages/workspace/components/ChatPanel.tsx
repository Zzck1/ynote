import { useState, useRef, useEffect } from 'react'
import { MessageCircle, Send } from 'lucide-react'
import { Button } from '../../../components/Button'
import { Spinner } from '../../../components/Spinner'
import { EmptyState } from '../../../components/EmptyState'
import { chat } from '../../../api/materials'
import { getCompleteTranscript as getTranscript } from './transcriptData'
import { useWorkspaceStore, EMPTY_JOBS } from '../../../stores/workspaceStore'
import { useUiStore } from '../../../stores/uiStore'
import { useQuotaStore, isManagedAiReady } from '../../../stores/quotaStore'
import { formatClockMs } from '../../../utils/format'
import { ApiRequestError } from '../../../api/errors'
import type { ChatMessage, Segment } from '../../../api/types'

interface ChatPanelProps {
  materialId: string
}

/** F13：右侧 AI 问答 */
export function ChatPanel({ materialId }: ChatPanelProps) {
  const conversation = useWorkspaceStore((s) => s.conversationsByMaterial[materialId] ?? null)
  const putConversation = useWorkspaceStore((s) => s.putConversation)
  const setHighlightSegmentId = useWorkspaceStore((s) => s.setHighlightSegmentId)
  const setActiveNarrowTab = useWorkspaceStore((s) => s.setActiveNarrowTab)
  const pushToast = useUiStore((s) => s.pushToast)
  useQuotaStore()
  const configured = isManagedAiReady()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [segments, setSegments] = useState<Segment[]>([])
  const jobs = useWorkspaceStore((s) => s.jobsByMaterial[materialId] ?? EMPTY_JOBS)
  const jobStateKey = jobs.map(j => `${j.id}:${j.state}`).join()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 获取原文段落（用于确定无时间戳引用的段号）
  useEffect(() => {
    getTranscript(materialId)
      .then((resp) => setSegments(resp.segments))
      .catch(() => setSegments([]))
  }, [materialId, jobStateKey])

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation?.messages.length, loading])

  async function handleSend() {
    const question = input.trim()
    if (!question || loading) return
    setInput('')
    setLoading(true)
    try {
      const resp = await chat(materialId, {
        question,
        ...(!configured ? { provider: 'extractive' } : {}),
        conversation_id: conversation?.id,
      })
      putConversation(resp.conversation)
    } catch (e) {
      setInput(question)
      if (e instanceof ApiRequestError) {
        if (e.code === 'MODEL_FAILED') {
          pushToast('danger', '当前模型不可用。请在设置中查看平台额度或个人密钥验证状态。')
        } else if (e.code === 'INVALID_INPUT') {
          pushToast('danger', '原文还没提取，回答无法附上出处。建议先获取完整文案。')
        } else {
          pushToast('danger', e.message)
        }
      } else {
        pushToast('danger', '提问失败，请稍后重试')
      }
    } finally {
      setLoading(false)
    }
  }

  function getCitationLabel(msg: ChatMessage): string {
    if (!msg.citations || msg.citations.length === 0) return ''
    return `本文回答引用 ${msg.citations.length} 段原文 · 点击查看`
  }

  function handleCitationClick(segmentId: string) {
    setHighlightSegmentId(segmentId)
    setActiveNarrowTab('reference')
  }

  function getSegmentIndex(segmentId: string): number {
    const idx = segments.findIndex((s) => s.id === segmentId)
    return idx >= 0 ? idx + 1 : 0
  }

  const messages = conversation?.messages ?? []

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center px-4 py-3">
        <h2 className="text-[15px] font-semibold text-ink">{configured ? 'AI 问答' : '原文检索'}</h2>{!configured && <span className="ml-auto text-[10px] text-ink-3">本地 · 无需模型</span>}
      </div>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto px-4">
        {messages.length === 0 && !loading ? (
          <EmptyState
            icon={MessageCircle}
            text={configured ? "向这份资料提问，回答附带原文出处。" : "输入关键词，在原文中查找相关段落。这是本地检索，不是 AI 回答。"}
          />
        ) : (
          <div className="space-y-4 py-2">
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === 'user' ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-lg bg-hov px-3 py-2 text-sm leading-relaxed text-ink">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm leading-relaxed text-ink">
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                    {msg.citations && msg.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {msg.citations.map((c, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => handleCitationClick(c.segment_id)}
                            className="cursor-pointer rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hov hover:text-ink"
                            aria-label={`查看原文 ${c.start_ms !== null ? formatClockMs(c.start_ms) : `第${getSegmentIndex(c.segment_id)}段`}`}
                          >
                            {c.start_ms !== null
                              ? `原文 ${formatClockMs(c.start_ms)}`
                              : `原文 · 第 ${getSegmentIndex(c.segment_id)} 段`}
                          </button>
                        ))}
                      </div>
                    )}
                    {getCitationLabel(msg) && (
                      <p className="mt-2 text-[12px] text-ink-3">{getCitationLabel(msg)}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-ink-2" aria-live="polite">
                <Spinner className="text-info" />
                正在查阅原文…
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* 输入区（钉底） */}
      <div className="shrink-0 border-t border-line px-4 py-3">
        <div className="flex items-end gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={configured ? "就这份资料提问" : "搜索原文关键词"}
            className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-page px-3 text-sm text-ink outline-none transition-colors duration-150 focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,23,0.12)]"
            aria-label="就这份资料提问"
          />
          <Button
            variant="primary"
            size="sm"
            loading={loading}
            loadingText="提问中"
            onClick={handleSend}
            disabled={!input.trim()}
          >
            <Send size={12} strokeWidth={1.5} />
            {configured ? '提问' : '检索'}
          </Button>
        </div>
      </div>
    </div>
  )
}
