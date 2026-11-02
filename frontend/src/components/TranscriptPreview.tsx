import { useId, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

/** Clamp the presentation only. Copy/export keep using the complete source text. */
export function TranscriptPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  return <div className="text-surface transcript-text">
    <div id={contentId} className={`transcript-preview-content${expanded ? '' : ' transcript-preview-collapsed'}`}>{text}</div>
    <button type="button" className="card-action transcript-preview-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
      {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}{expanded ? '收起文案' : '展开完整文案'}
    </button>
  </div>
}
