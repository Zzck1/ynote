import { useEffect, useMemo, useRef, lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router'
import { PanelRightClose, PanelRightOpen, Library, LayoutGrid, BookOpen, Link2, Layers, Sparkles, ArrowUpRight } from 'lucide-react'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useWorkspaceJobStreams } from '../../hooks/useJobEvents'
import { useWorkspaceStore, type TabKey, type NarrowTabKey } from '../../stores/workspaceStore'
import { USE_MOCK } from '../../api/errors'
import { getTranscript, createNote } from '../../api/materials'
import { UnifiedInput } from './components/UnifiedInput'
import { MaterialHeader } from './components/MaterialHeader'
import { LibrarySidebar } from './components/LibrarySidebar'
import { ReferencePanel } from './components/ReferencePanel'
import { ChatPanel } from './components/ChatPanel'
import { TranscriptTab } from './components/tabs/TranscriptTab'
const NoteTab = lazy(() => import('./components/tabs/NoteTab').then(m => ({ default: m.NoteTab })))
const MindmapTab = lazy(() => import('./components/tabs/MindmapTab').then(m => ({ default: m.MindmapTab })))
import { AssetsTab } from './components/tabs/AssetsTab'

const TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'partial', 'needs_action']

const TAB_LABELS: { key: TabKey; label: string }[] = [
  { key: 'transcript', label: '完整文案' },
  { key: 'note', label: 'AI 笔记' },
  { key: 'mindmap', label: '思维导图' },
  { key: 'assets', label: '素材' },
]

const NARROW_TABS: { key: NarrowTabKey; label: string; icon: typeof Library }[] = [
  { key: 'library', label: '资料库', icon: Library },
  { key: 'workspace', label: '工作区', icon: LayoutGrid },
  { key: 'reference', label: '原文与问答', icon: BookOpen },
]

export function WorkspacePage() {
  const isDesktop = useMediaQuery('(min-width: 1100px)')
  const [searchParams, setSearchParams] = useSearchParams()

  const libraryLoading = useWorkspaceStore((s) => s.loading)
  const currentMaterialId = useWorkspaceStore((s) => s.currentMaterialId)
  const materials = useWorkspaceStore((s) => s.materials)
  const capabilitiesByMaterial = useWorkspaceStore((s) => s.capabilitiesByMaterial)
  const setCurrentMaterial = useWorkspaceStore((s) => s.setCurrentMaterial)
  const rightPanelOpen = useWorkspaceStore((s) => s.rightPanelOpen)
  const setRightPanel = useWorkspaceStore((s) => s.setRightPanel)
  const activeTab = useWorkspaceStore((s) => s.activeTab)
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab)
  const activeNarrowTab = useWorkspaceStore((s) => s.activeNarrowTab)
  const setActiveNarrowTab = useWorkspaceStore((s) => s.setActiveNarrowTab)
  const generateNote = useWorkspaceStore((s) => s.generateNote)
  const putNote = useWorkspaceStore((s) => s.putNote)

  // Preserve a deep link on startup, then synchronize user selections and browser navigation.
  const initialUrlRead = useRef(false)
  const lastUrlMaterial = useRef<string | null>(null)
  useEffect(() => {
    if (libraryLoading) return
    const urlM = searchParams.get('m')
    const validUrl = urlM && materials.some(m => m.id === urlM) ? urlM : null
    if (!initialUrlRead.current) {
      initialUrlRead.current = true
      lastUrlMaterial.current = urlM
      if (validUrl && validUrl !== currentMaterialId) { setCurrentMaterial(validUrl); return }
    } else if (urlM !== lastUrlMaterial.current) {
      lastUrlMaterial.current = urlM
      if (validUrl !== currentMaterialId) { setCurrentMaterial(validUrl); return }
    }
    if (urlM !== currentMaterialId) {
      lastUrlMaterial.current = currentMaterialId
      setSearchParams(currentMaterialId ? { m: currentMaterialId } : {}, { replace: true })
    }
  }, [searchParams, currentMaterialId, materials, setCurrentMaterial, setSearchParams, libraryLoading])

  // ===== SSE 订阅：自动订阅所有非终态任务 =====
  const activeJobIds = useWorkspaceStore((s) => {
    const ids: string[] = []
    for (const jobs of Object.values(s.jobsByMaterial)) {
      for (const j of jobs) {
        if (!TERMINAL_STATES.includes(j.state)) ids.push(j.id)
      }
    }
    return ids.join(',')
  })

  useWorkspaceJobStreams(activeJobIds)

  useEffect(() => {
    const onSeek = (event: Event) => {
      const detail = (event as CustomEvent<{materialId: string; timeMs: number}>).detail
      if (!detail?.materialId) return
      setCurrentMaterial(detail.materialId)
      setActiveTab('assets')
      setActiveNarrowTab('workspace')
    }
    window.addEventListener('enote:seek', onSeek)
    return () => window.removeEventListener('enote:seek', onSeek)
  }, [setCurrentMaterial, setActiveTab, setActiveNarrowTab])

  // ===== 自动生成笔记（同时生成笔记勾选 + 文案就绪时） =====
  const autoNoteRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!USE_MOCK || !generateNote) return
    const state = useWorkspaceStore.getState()
    for (const [matId, jobs] of Object.entries(state.jobsByMaterial)) {
      if (state.notesByMaterial[matId]) continue
      if (autoNoteRef.current.has(matId)) continue
      const hasTranscriptSuccess = jobs.some((j) =>
        j.operations.some((o) => o.kind === 'transcript' && o.state === 'succeeded'),
      )
      if (hasTranscriptSuccess) {
        autoNoteRef.current.add(matId)
        getTranscript(matId)
          .then((transcript) =>
            createNote(matId, { transcript_version_id: transcript.version.id }),
          )
          .then((resp) => putNote(resp.note))
          .catch(() => {
            /* 静默失败，用户可手动生成 */
          })
      }
    }
  }, [generateNote, activeJobIds, putNote])

  const currentMaterial = useMemo(
    () => materials.find((m) => m.id === currentMaterialId) ?? null,
    [materials, currentMaterialId],
  )
  const currentCapabilities = currentMaterialId
    ? capabilitiesByMaterial[currentMaterialId] ?? null
    : null

  // ===== 渲染 =====

  const libraryContent = <LibrarySidebar />

  const centerContent = (
    <div className="workspace-content mx-auto">
      <div className="workspace-heading"><div><p className="eyebrow">YOUR MEDIA, CONNECTED</p><h1>{currentMaterial ? '研究工作台' : '让每一份内容，成为你的知识'}</h1></div><span className="mode-label">{USE_MOCK ? '演示数据 · 不执行真实提取' : '本地工作空间'}</span></div>
      <UnifiedInput />
      {currentMaterial && currentCapabilities ? (
        <>
          <div className="pb-8">
            <MaterialHeader material={currentMaterial} capabilities={currentCapabilities} />
          </div>
          {/* tab 条 */}
          <div
            className="workspace-tabs sticky top-0 z-10"
            role="tablist"
            aria-label="工作区标签"
          >
            {TAB_LABELS.map((tab) => (
              <button
                key={tab.key}
                id={`tab-${tab.key}`}
                role="tab"
                aria-selected={activeTab === tab.key}
                tabIndex={activeTab === tab.key ? 0 : -1}
                aria-controls={`tabpanel-${tab.key}`}
                onClick={() => setActiveTab(tab.key)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault()
                    const idx = TAB_LABELS.findIndex((t) => t.key === activeTab)
                    const next =
                      e.key === 'ArrowRight'
                        ? (idx + 1) % TAB_LABELS.length
                        : (idx - 1 + TAB_LABELS.length) % TAB_LABELS.length
                    setActiveTab(TAB_LABELS[next].key)
                    document.getElementById(`tab-${TAB_LABELS[next].key}`)?.focus()
                  }
                }}
                className={`relative h-10 px-4 text-sm font-medium transition-colors duration-150 ${
                  activeTab === tab.key
                    ? 'text-ink'
                    : 'text-ink-2 hover:text-ink'
                }`}
              >
                {tab.label}
                {activeTab === tab.key && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-ink" />
                )}
              </button>
            ))}
          </div>
          {/* tab 内容 */}
          <div
            id={`tabpanel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`tab-${activeTab}`}
            className="pb-16"
          >
            {activeTab === 'transcript' && currentMaterialId && (
              <TranscriptTab materialId={currentMaterialId} />
            )}
            {activeTab === 'note' && currentMaterialId && (
              <Suspense fallback={<p className="py-8 text-ink-3">正在打开笔记…</p>}><NoteTab materialId={currentMaterialId} /></Suspense>
            )}
            {activeTab === 'mindmap' && currentMaterialId && (
              <Suspense fallback={<p className="py-8 text-ink-3">正在打开导图…</p>}><MindmapTab materialId={currentMaterialId} /></Suspense>
            )}
            {activeTab === 'assets' && currentMaterialId && (
              <AssetsTab materialId={currentMaterialId} />
            )}
          </div>
        </>
      ) : (
        <section className="pb-10">
          <div className="flex items-center justify-between"><p className="eyebrow">A CLEARER WAY TO LEARN</p><span className="text-[11px] text-ink-3">收集 · 理解 · 留存</span></div>
          <div className="workflow-grid">
            <div className="workflow-card"><Link2 size={23} strokeWidth={1.4} /><h3>01 / 收集你的资料</h3><p>粘贴视频与图文链接，或导入本地视频、音频和文字。</p></div>
            <div className="workflow-card"><Layers size={23} strokeWidth={1.4} /><h3>02 / 拆解内容细节</h3><p>将原文、封面和媒体素材集中整理，随时预览与下载。</p></div>
            <div className="workflow-card"><Sparkles size={23} strokeWidth={1.4} /><h3>03 / 建立知识连接</h3><p>配置模型后生成笔记与导图，带着问题回到原文。</p></div>
          </div>
          <div className="research-empty"><div className="flex items-center gap-2 text-accent"><BookOpen size={18} /><span className="text-xs">为深入思考留出空间</span></div><h2 className="mt-4">你的下一条灵感，从这里开始。</h2><p className="mt-2 text-[13px] text-ink-3">在上方粘贴第一条链接，或选择本地文件。所有资料都会收纳在左侧资料库。</p><p className="mt-6 flex items-center gap-1 text-xs text-ink-2">支持视频、音频、图片与字幕文件 <ArrowUpRight size={13} /></p></div>
        </section>
      )}
    </div>
  )

  const rightContent = (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {currentMaterialId ? (
          <ReferencePanel materialId={currentMaterialId} />
        ) : (
          <div className="px-5 py-6">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-ink"><BookOpen size={15} className="text-accent" /> 原文参照</h2><div className="mt-8 space-y-3 opacity-30" aria-hidden="true">{[90, 100, 75, 85].map((w, i) => <div key={i} className="h-1.5 rounded bg-line-strong" style={{width: `${w}%`}} />)}</div>
            <p className="mt-2 text-[13px] text-ink-3">
              选择一份资料后，原文段落会显示在这里。
            </p>
          </div>
        )}
      </div>
      <div className="h-px shrink-0 bg-line" />
      <div className="flex flex-1 flex-col overflow-hidden">
        {currentMaterialId ? (
          <ChatPanel materialId={currentMaterialId} />
        ) : (
          <div className="px-5 py-6">
            <h2 className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Sparkles size={15} className="text-accent" /> 与内容对话</h2>
            <p className="mt-2 text-[13px] text-ink-3">先选择一份资料，再检索关键词或使用已配置的 AI 模型提问。</p>
          </div>
        )}
      </div>
    </div>
  )

  // ===== 桌面三栏 =====
  if (isDesktop) {
    return (
      <div
        className="enote-workspace grid h-full"
        style={{
          gridTemplateColumns: rightPanelOpen ? '240px minmax(0, 1fr) 310px' : '240px minmax(0, 1fr) 0px',
          transition: 'grid-template-columns 200ms ease-out',
        }}
      >
        {/* 左栏 */}
        <nav
          className="h-full overflow-y-auto border-r border-line bg-subtle"
          aria-label="资料库"
        >
          {libraryContent}
        </nav>

        {/* 中央工作区 */}
        <main className="workspace-center relative h-full overflow-y-auto bg-page">
          {/* 折叠/展开按钮 */}
          <button
            type="button"
            onClick={() => setRightPanel(!rightPanelOpen)}
            className="absolute right-4 top-3 z-20 cursor-pointer rounded-md p-1 text-ink-3 transition-colors duration-150 hover:bg-hov hover:text-ink"
            aria-label={rightPanelOpen ? '折叠原文参照面板' : '展开原文参照面板'}
          >
            {rightPanelOpen ? (
              <PanelRightClose size={20} strokeWidth={1.5} />
            ) : (
              <PanelRightOpen size={20} strokeWidth={1.5} />
            )}
          </button>
          {centerContent}
        </main>

        {/* 右栏 */}
        <aside
          className="h-full overflow-hidden border-l border-line bg-subtle"
          aria-label="原文参照与AI问答"
          style={{
            opacity: rightPanelOpen ? 1 : 0,
            transition: 'opacity 200ms ease-out',
          }}
        >
          {rightPanelOpen ? rightContent : null}
        </aside>
      </div>
    )
  }

  // ===== 窄窗三标签 =====
  return (
    <div className="flex h-full flex-col">
      {/* 窄窗标签条 */}
      <div
        className="flex h-11 shrink-0 border-b border-line bg-page"
        role="tablist"
        aria-label="窄窗面板切换"
      >
        {NARROW_TABS.map((tab) => {
          const isActive = activeNarrowTab === tab.key
          const hasRunningJob = tab.key === 'library' && activeJobIds !== ''
          const Icon = tab.icon
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveNarrowTab(tab.key)}
              className={`relative flex flex-1 items-center justify-center gap-1.5 text-sm font-medium transition-colors duration-150 ${
                isActive ? 'text-ink' : 'text-ink-2'
              }`}
            >
              <Icon size={16} strokeWidth={1.5} />
              {tab.label}
              {hasRunningJob && (
                <span className="dot-breath h-1.5 w-1.5 rounded-full bg-info" />
              )}
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-ink" />
              )}
            </button>
          )
        })}
      </div>

      {/* 三面板（display:none 切换不卸载） */}
      <div className="relative flex-1 overflow-hidden">
        <nav
          className={`h-full overflow-y-auto border-r border-line bg-subtle ${
            activeNarrowTab === 'library' ? '' : 'hidden'
          }`}
          aria-hidden={activeNarrowTab !== 'library'}
        >
          {libraryContent}
        </nav>
        <main
          className={`h-full overflow-y-auto bg-page ${
            activeNarrowTab === 'workspace' ? '' : 'hidden'
          }`}
          aria-hidden={activeNarrowTab !== 'workspace'}
        >
          {centerContent}
        </main>
        <aside
          className={`h-full overflow-y-auto border-l border-line bg-subtle ${
            activeNarrowTab === 'reference' ? '' : 'hidden'
          }`}
          aria-hidden={activeNarrowTab !== 'reference'}
        >
          {rightContent}
        </aside>
      </div>
    </div>
  )
}
