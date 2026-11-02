import { Focus, LoaderCircle, Zap } from 'lucide-react'
import type { ExtractionMode } from '../api/types'

export function ExtractionButtons({ disabled, busyMode, onExtract }: { disabled: boolean; busyMode: ExtractionMode | 'unknown' | null; onExtract: (mode: ExtractionMode) => void }) {
  return <div className="extraction-mode-actions" role="group" aria-label="选择提取方式">
    <button type="button" className="extract-start" disabled={disabled} aria-busy={busyMode === 'quick'} onClick={() => onExtract('quick')}>
      {busyMode === 'quick' ? <LoaderCircle size={18} className="icon-spin" /> : <Zap size={18} />}{busyMode === 'quick' ? '快速提取中…' : '快速提取'}
    </button>
    <button type="button" className="extract-start extract-precise" disabled={disabled} aria-busy={busyMode === 'precise'} onClick={() => onExtract('precise')}>
      {busyMode === 'precise' ? <LoaderCircle size={18} className="icon-spin" /> : <Focus size={18} />}{busyMode === 'precise' ? '精准提取中…' : '精准提取'}
    </button>
    {busyMode === 'unknown' && <span className="input-hint" role="status">正在提取…</span>}
  </div>
}
