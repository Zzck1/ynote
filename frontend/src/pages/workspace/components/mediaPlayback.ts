import { useEffect, useRef } from 'react'

export interface MediaSeek { materialId: string; timeMs: number }
const pendingSeeks = new Map<string, number>()
export function seekMaterial(materialId: string, timeMs: number) {
  pendingSeeks.set(materialId, Math.max(0, timeMs))
  window.dispatchEvent(new CustomEvent<MediaSeek>('enote:seek', { detail: { materialId, timeMs } }))
}

export function useMediaSeek<T extends HTMLMediaElement>(materialId: string, url: string | null) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const player = ref.current
    if (!player) return
    const seek = () => {
      const milliseconds = pendingSeeks.get(materialId)
      if (milliseconds === undefined || !player.readyState) return
      const seconds = milliseconds / 1000
      player.currentTime = Number.isFinite(player.duration) ? Math.min(seconds, player.duration) : seconds
    }
    const onSeek = (event: Event) => {
      const detail = (event as CustomEvent<MediaSeek>).detail
      if (detail.materialId !== materialId) return
      pendingSeeks.set(materialId, detail.timeMs)
      seek()
      player.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    player.addEventListener('loadedmetadata', seek)
    window.addEventListener('enote:seek', onSeek)
    seek()
    return () => { player.removeEventListener('loadedmetadata', seek); window.removeEventListener('enote:seek', onSeek) }
  }, [materialId, url])
  return ref
}
