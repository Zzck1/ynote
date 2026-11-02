import { useEffect, useRef, useState } from 'react'
import { Network, Download } from 'lucide-react'
import { createSafeMindmap } from '../safeMindmap'
import { Markmap } from 'markmap-view'
import { Button } from '../../../../components/Button'
import { EmptyState } from '../../../../components/EmptyState'
import { useWorkspaceStore } from '../../../../stores/workspaceStore'
import { useUiStore } from '../../../../stores/uiStore'
import { downloadUrl } from '../../../../utils/files'

interface MindmapTabProps {
  materialId: string
}

/** F10：思维导图标签（markmap-lib + markmap-view） */
export function MindmapTab({ materialId }: MindmapTabProps) {
  const note = useWorkspaceStore((s) => s.notesByMaterial[materialId] ?? null)
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab)
  const pushToast = useUiStore((s) => s.pushToast)
  const svgRef = useRef<SVGSVGElement>(null)
  const mmRef = useRef<Markmap | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!note || !svgRef.current) return

    const root = createSafeMindmap(note.markdown)

    if (mmRef.current) {
      mmRef.current.setData(root)
      mmRef.current.fit()
    } else {
      mmRef.current = Markmap.create(svgRef.current, {}, root)
    }
    setReady(true)

    return () => {
      mmRef.current?.destroy()
      mmRef.current = null
      setReady(false)
    }
  }, [note?.markdown])

  // 无笔记
  if (!note) {
    return (
      <EmptyState
        icon={Network}
        text="导图由笔记生成。先在「AI 笔记」里生成笔记，导图会随笔记版本更新。"
        actionLabel="去生成笔记"
        onAction={() => setActiveTab('note')}
      />
    )
  }

  function handleExportSvg() {
    if (!svgRef.current) return
    const svgString = new XMLSerializer().serializeToString(svgRef.current)
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    downloadUrl(url, 'mindmap.svg')
    pushToast('success', '已导出 SVG')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end gap-2 border-b border-line px-4 py-2">
        <Button variant="ghost" size="sm" onClick={handleExportSvg} disabled={!ready}>
          <Download size={12} strokeWidth={1.5} />
          导出 SVG
        </Button>
      </div>
      <div className="flex-1 overflow-hidden p-4">
        <svg
          ref={svgRef}
          className="markmap min-h-[420px] w-full"
          role="img"
          aria-label="思维导图"
        />
      </div>
    </div>
  )
}
