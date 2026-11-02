import { useEffect, useState } from 'react'
import {
  Image as ImageIcon,
  Video,
  Music,
  FileImage,
  FileText,
  Download,
  Package,
} from 'lucide-react'
import { Button } from '../../../../components/Button'
import { EmptyState } from '../../../../components/EmptyState'
import { Spinner } from '../../../../components/Spinner'
import { listAssets, downloadAssetUrl } from '../../../../api/materials'
import { useMediaSeek } from '../mediaPlayback'
import { useWorkspaceStore, EMPTY_JOBS } from '../../../../stores/workspaceStore'
import { useUiStore } from '../../../../stores/uiStore'
import { downloadUrl, sanitizeFilename } from '../../../../utils/files'
import { formatBytes, formatDurationSec } from '../../../../utils/format'
import type { Asset, AssetKind } from '../../../../api/types'

interface AssetsTabProps {
  materialId: string
}

/** F11：素材标签（视频/音频/封面内嵌预览播放，对齐 anytocopy 式直接预览） */
export function AssetsTab({ materialId }: AssetsTabProps) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const jobs = useWorkspaceStore((s) => s.jobsByMaterial[materialId] ?? EMPTY_JOBS)
  const material = useWorkspaceStore((s) => s.materials.find((m) => m.id === materialId))
  const jobStateKey = jobs.map((j) => `${j.id}:${j.state}`).join(',')
  const pushToast = useUiStore((s) => s.pushToast)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setAssets([])
    listAssets(materialId)
      .then((resp) => {
        if (cancelled) return
        setAssets(resp.assets)
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

  async function handleDownload(asset: Asset) {
    try {
      const url = await downloadAssetUrl(asset)
      const pathExtension = asset.relative_path.split('?')[0].match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]
      const mimeExtensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'text/vtt': 'vtt', 'application/x-subrip': 'srt', 'text/plain': 'txt' }
      const ext = pathExtension ?? mimeExtensions[asset.mime.split(';')[0]] ?? 'bin' 
      const name = `${sanitizeFilename(material?.title ?? 'asset')}-${asset.kind}.${ext}`
      downloadUrl(url, name)
      pushToast('success', '已开始下载')
    } catch (e) {
      pushToast('danger', e instanceof Error ? e.message : '下载失败，请稍后重试')
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center py-6">
        <Spinner className="text-info" />
      </div>
    )
  }

  if (notFound) return <EmptyState icon={Package} text="素材暂时无法加载，请检查服务连接后重试。" actionLabel="重试加载" onAction={() => { setLoading(true); listAssets(materialId).then(r => { setAssets(r.assets); setNotFound(false) }).catch(() => pushToast('danger', '素材加载失败')).finally(() => setLoading(false)) }} />

  if (assets.length === 0) {
    return (
      <EmptyState
        icon={Package}
        text="还没有素材。从上方任选一项开始提取，或点「一键全部提取」。"
      />
    )
  }

  // 按类型分组
  const allGroups: { kind: AssetKind; items: Asset[] }[] = [
    { kind: 'video', items: assets.filter((a) => a.kind === 'video') },
    { kind: 'cover', items: assets.filter((a) => a.kind === 'cover') },
    { kind: 'image', items: assets.filter((a) => a.kind === 'image') },
    { kind: 'audio', items: assets.filter((a) => a.kind === 'audio') },
    { kind: 'subtitle', items: assets.filter((a) => a.kind === 'subtitle') },
  ]
  const grouped = allGroups.filter((g) => g.items.length > 0)

  return (
    <div className="py-6">
      {grouped.map((group) => (
        <AssetGroup
          key={group.kind}
          kind={group.kind}
          items={group.items}
          poster={material?.cover_url ?? null}
          onDownload={handleDownload}
        />
      ))}
    </div>
  )
}

const GROUP_ICONS: Record<AssetKind, typeof Video> = {
  cover: FileImage,
  video: Video,
  image: ImageIcon,
  audio: Music,
  subtitle: FileText,
}

const GROUP_LABELS: Record<AssetKind, string> = {
  cover: '封面',
  video: '视频',
  image: '图片',
  audio: '音频',
  subtitle: '字幕',
}

function AssetGroup({
  kind,
  items,
  poster,
  onDownload,
}: {
  kind: AssetKind
  items: Asset[]
  poster: string | null
  onDownload: (asset: Asset) => void
}) {
  const Icon = GROUP_ICONS[kind]
  const label = GROUP_LABELS[kind]
  return (
    <div className="mb-6">
      <h3 className="mb-3 text-sm font-medium text-ink">{label}</h3>
      {kind === 'image' ? (
        // 图片网格（保持原帖顺序）
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {items.map((asset, i) => (
            <ImageCard key={asset.id} asset={asset} index={i + 1} onDownload={onDownload} />
          ))}
        </div>
      ) : kind === 'cover' ? (
        // 封面：直接显示图片预览
        <div className="flex flex-wrap gap-3">
          {items.map((asset) => (
            <CoverCard key={asset.id} asset={asset} onDownload={onDownload} />
          ))}
        </div>
      ) : kind === 'video' ? (
        // 视频：内嵌播放器（带封面 poster）
        <div className="space-y-3">
          {items.map((asset) => (
            <VideoCard key={asset.id} asset={asset} poster={poster} onDownload={onDownload} />
          ))}
        </div>
      ) : kind === 'audio' ? (
        // 音频：内嵌播放条
        <div className="space-y-2">
          {items.map((asset) => (
            <AudioCard key={asset.id} asset={asset} onDownload={onDownload} />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((asset) => (
            <MediaCard key={asset.id} asset={asset} icon={Icon} onDownload={onDownload} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 获取素材的预览 URL（mock 为演示媒体路径，真实环境为内联下载接口） */
function useAssetUrl(asset: Asset): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    downloadAssetUrl(asset, true)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [asset.id, asset.relative_path])
  return url
}

function CoverCard({ asset, onDownload }: { asset: Asset; onDownload: (asset: Asset) => void }) {
  const url = useAssetUrl(asset)
  return (
    <div className="inline-block max-w-xs overflow-hidden rounded-lg border border-line bg-subtle">
      <div className="flex items-center justify-center bg-subtle">
        {url ? (
          <img src={url} alt="封面" className="max-h-64 w-auto object-contain" />
        ) : (
          <div className="flex h-40 w-64 items-center justify-center">
            <FileImage size={20} strokeWidth={1.5} className="text-ink-4" />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="font-mono text-[12px] text-ink-3">
          {formatBytes(asset.bytes)}
          {asset.origin === 'generated' && ' · 生成封面'}
        </span>
        <Button variant="ghost" size="sm" onClick={() => onDownload(asset)}>
          <Download size={12} strokeWidth={1.5} />
          下载
        </Button>
      </div>
    </div>
  )
}

function VideoCard({
  asset,
  poster,
  onDownload,
}: {
  asset: Asset
  poster: string | null
  onDownload: (asset: Asset) => void
}) {
  const url = useAssetUrl(asset)
  const mediaRef = useMediaSeek<HTMLVideoElement>(asset.material_id, url)
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-subtle">
      {url ? (
        <video
          ref={mediaRef}
          src={url}
          poster={poster ?? undefined}
          controls
          preload="metadata"
          className="block max-h-[420px] w-full bg-black"
        />
      ) : (
        <div className="flex h-56 items-center justify-center">
          <Video size={20} strokeWidth={1.5} className="text-ink-4" />
        </div>
      )}
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="font-mono text-[12px] text-ink-3">
          {formatBytes(asset.bytes)}
          {asset.duration && ` · ${formatDurationSec(asset.duration)}`}
        </span>
        <Button variant="secondary" size="sm" onClick={() => onDownload(asset)}>
          <Download size={12} strokeWidth={1.5} />
          下载
        </Button>
      </div>
    </div>
  )
}

function AudioCard({ asset, onDownload }: { asset: Asset; onDownload: (asset: Asset) => void }) {
  const url = useAssetUrl(asset)
  const mediaRef = useMediaSeek<HTMLAudioElement>(asset.material_id, url)
  return (
    <div className="rounded-lg border border-line bg-page p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-subtle">
          <Music size={20} strokeWidth={1.5} className="text-ink-3" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[12px] text-ink-3">
            {formatBytes(asset.bytes)}
            {asset.duration && ` · ${formatDurationSec(asset.duration)}`}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onDownload(asset)}>
          <Download size={12} strokeWidth={1.5} />
          下载
        </Button>
      </div>
      {url && (
        <audio ref={mediaRef} src={url} controls preload="metadata" className="mt-3 h-10 w-full" />
      )}
    </div>
  )
}

function ImageCard({
  asset,
  index,
  onDownload,
}: {
  asset: Asset
  index: number
  onDownload: (asset: Asset) => void
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    downloadAssetUrl(asset, true)
      .then(setPreviewUrl)
      .catch(() => setPreviewUrl(null))
  }, [asset.id, asset.relative_path])

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-subtle">
      <div className="relative flex aspect-[3/4] items-center justify-center bg-subtle">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={`图片 ${index}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <ImageIcon size={20} strokeWidth={1.5} className="text-ink-4" />
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="font-mono text-[12px] text-ink-3">{formatBytes(asset.bytes)}</span>
        <Button variant="ghost" size="sm" onClick={() => onDownload(asset)}>
          <Download size={12} strokeWidth={1.5} />
          下载
        </Button>
      </div>
    </div>
  )
}

function MediaCard({
  asset,
  icon: Icon,
  onDownload,
}: {
  asset: Asset
  icon: typeof Video
  onDownload: (asset: Asset) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-page p-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-subtle">
        <Icon size={20} strokeWidth={1.5} className="text-ink-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12px] text-ink-3">
          {formatBytes(asset.bytes)}
          {asset.duration && ` · ${formatDurationSec(asset.duration)}`}
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={() => onDownload(asset)}>
        <Download size={12} strokeWidth={1.5} />
        下载
      </Button>
    </div>
  )
}
