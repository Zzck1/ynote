import { useRef, useState } from 'react'
import { AlertCircle, FileUp, Search, Link2, ArrowUpRight } from 'lucide-react'
import { Button } from '../../../components/Button'
import { resolveMaterial, importLocalFile } from '../../../api/materials'
import { extractUrls } from '../../../api/client'
import { ApiRequestError } from '../../../api/errors'
import { useWorkspaceStore } from '../../../stores/workspaceStore'
import { useUiStore } from '../../../stores/uiStore'
import type { ResolveCandidate } from '../../../api/types'

/** content-plan §2.1 行内异常提示文案 */
function resolveErrorMessage(code: string, fallback: string): string {
  if (code === 'LINK_EXPIRED') return '链接已过期或被删除。分享链接有时效，请回到原作品重新分享一次。'
  if (code === 'LOGIN_REQUIRED') return '该链接需要登录后才能访问。请在浏览器登录平台后重试，或直接导入本地文件。'
  if (code === 'INVALID_INPUT') {
    // 区分空输入与纯口令
    return fallback
  }
  if (code === 'RATE_LIMITED') return '平台暂时限制了访问频率。请稍后再试，或导入本地文件。'
  return fallback
}

/** F01-F03：统一输入区 */
export function UnifiedInput() {
  const [rawInput, setRawInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ResolveCandidate[] | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addMaterial = useWorkspaceStore((s) => s.addMaterial)
  const pushToast = useUiStore((s) => s.pushToast)
  const setActiveNarrowTab = useWorkspaceStore((s) => s.setActiveNarrowTab)
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab)

  async function handleResolve(candidateId?: string) {
    if (resolving || importing) return
    setError(null)
    setCandidates(null)

    if (!candidateId && (!rawInput || !rawInput.trim())) {
      setError('没有检测到内容。粘贴分享链接、整段分享文字或视频网址后再试。')
      return
    }

    setResolving(true)
    try {
      const resp = await resolveMaterial({ raw_input: rawInput, candidate_id: candidateId })
      if (resp.status === 'needs_selection' && resp.candidates) {
        setCandidates(resp.candidates)
        setResolving(false)
        return
      }
      if (resp.status === 'resolved' && resp.material && resp.capabilities) {
        addMaterial(resp.material, resp.capabilities)
        pushToast('success', '解析完成，已建立资料')
        setActiveNarrowTab('workspace')
        setActiveTab('transcript')
      }
    } catch (e) {
      if (e instanceof ApiRequestError) {
        const isPureCode = !candidateId && extractUrls(rawInput).length === 0
        const fallback =
          isPureCode && rawInput.trim()
            ? '这段文字里没有链接。纯口令无法解析，请在原平台打开分享，复制完整链接后再来。'
            : e.message
        setError(resolveErrorMessage(e.code, fallback))
      } else {
        setError('解析失败，请稍后重试')
      }
    } finally {
      setResolving(false)
    }
  }

  async function handleImport() {
    fileInputRef.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setError(null)
    try {
      const resp = await importLocalFile(file)
      addMaterial(resp.material, resp.capabilities)
      pushToast('success', '解析完成，已建立资料')
      setActiveNarrowTab('workspace')
      setActiveTab('assets')
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message)
      } else {
        setError('导入失败，请稍后重试')
      }
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const candidateCount = candidates?.length ?? 0

  return (
    <div className="import-card">
      <div className="mb-4 flex items-center gap-2 text-[13px] font-medium text-ink-2"><Link2 size={15} className="text-accent" /> 从一条链接，开始整理灵感</div>
      <div className="flex flex-col gap-3">
        <textarea
          className="min-h-[88px] max-h-[200px] flex-1 resize-y rounded-md border border-line-strong bg-page px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition-colors duration-150 focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,23,0.12)]"
          placeholder="粘贴分享链接、整段分享文字或视频网址"
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              handleResolve()
            }
          }}
          aria-label="粘贴分享链接、整段分享文字或视频网址"
        />
        <div className="input-actions"><span className="text-[11px] text-ink-3">⌘ / Ctrl + Enter 解析</span><div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={resolving}
            loadingText="正在解析链接…"
            onClick={() => handleResolve()}
          >
            解析链接 <ArrowUpRight size={14} />
          </Button>
          <Button
            variant="secondary"
            loading={importing}
            loadingText="正在导入…"
            onClick={handleImport}
          >
            <FileUp size={16} strokeWidth={1.5} className="mr-1" />
            导入本地文件
          </Button>
        </div></div>
      </div>

      <p className="mt-3 text-[11px] text-ink-3">
        支持多行粘贴，分享文字里的标题、表情不用删，会自动找出链接
      </p>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="video/*,audio/*,image/*,.srt,.vtt,.txt"
        onChange={handleFileChange}
      />

      {/* 行内异常提示 */}
      {error && (
        <div
          className="mt-3 flex items-start gap-1.5 text-[13px] text-danger"
          role="alert"
          aria-live="polite"
        >
          <AlertCircle size={16} strokeWidth={1.5} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      {/* 多链接候选内联卡 */}
      {candidates && candidateCount > 0 && (
        <div className="mt-3 rounded-lg border border-line bg-page p-4">
          <h3 className="text-[15px] font-semibold text-ink">{`检测到 ${candidateCount} 个链接`}</h3>
          <p className="mt-1 text-[13px] text-ink-2">选择要解析的一条，其余不会被处理</p>
          <ul className="mt-3 flex flex-col gap-1">
            {candidates.map((c) => (
              <li
                key={c.candidate_id}
                className="flex items-center justify-between rounded-md px-3 py-2 transition-colors duration-150 hover:bg-hov"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Search size={16} strokeWidth={1.5} className="shrink-0 text-ink-3" />
                  <span className="truncate font-mono text-[13px] text-ink-2">{c.url}</span>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={resolving}
                  loadingText="解析中"
                  onClick={() => handleResolve(c.candidate_id)}
                >
                  解析这条
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setCandidates(null)}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
