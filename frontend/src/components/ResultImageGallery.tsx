import { Download } from 'lucide-react'
import type { Asset } from '../api/types'

export function ResultImageGallery({ assets, urlFor }: { assets: Asset[]; urlFor: (asset: Asset, save?: boolean) => string }) {
  return <div className="image-assets">{assets.filter(asset => asset.kind === 'cover').slice(0,1).map(asset => {
    const label = '视频封面'
    const extension = asset.mime === 'image/png' ? 'png' : asset.mime === 'image/webp' ? 'webp' : 'jpg'
    return <div className="image-asset" key={asset.id}>
      <a href={urlFor(asset)} target="_blank" rel="noreferrer"><img src={urlFor(asset)} alt={label} loading="lazy" /></a>
      <a href={urlFor(asset, true)} download={`${label}.${extension}`}><Download size={14} />下载{label}</a>
    </div>
  })}</div>
}
