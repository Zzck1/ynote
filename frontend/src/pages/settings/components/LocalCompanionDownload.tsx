import { useEffect, useState } from 'react'
import { Download, Info, Laptop, Monitor, Package } from 'lucide-react'
import { companionDownload, type CompanionRelease } from '../../../api/companionRelease'

const PLATFORMS = [
  {
    id: 'windows',
    name: 'Windows',
    description: '适用于 Windows 电脑',
    detail: 'Windows 安装包尚未提供，支持的系统版本与硬件要求将在发布时说明。',
    icon: Monitor,
  },
  {
    id: 'macos',
    name: 'macOS',
    description: '适用于 Mac 电脑',
    detail: 'macOS 安装包尚未提供。发布时需区分 Apple Silicon 与 Intel 芯片，选择与你的 Mac 匹配的版本。',
    icon: Laptop,
  },
] as const

/** A platform selector only: no compatible companion packages have been released. */
export function LocalCompanionDownload() {
  const [releases,setReleases]=useState<CompanionRelease[]>([])
  const [architecture,setArchitecture]=useState('arm64')
  useEffect(()=>{let mounted=true;void fetch(import.meta.env.BASE_URL+'companion-releases.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(d=>{if(mounted && d?.schema_version===1 && d?.protocol===1 && Array.isArray(d.releases))setReleases(d.releases)}).catch(()=>{});return()=>{mounted=false}},[])
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]['id']>('windows')
  const selected = PLATFORMS.find((item) => item.id === platform)!
  const release=releases.find(r=>r.platform===platform && r.architecture===(platform==='windows'?'x64':architecture))
  const choice=companionDownload(release,typeof location==='undefined'?'':location.hostname)
  const enabled=!!choice.url

  return (
    <section className="mt-6 rounded-lg border border-line bg-subtle p-4 sm:p-6" aria-labelledby="local-companion-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-page text-accent">
            <Package size={20} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <div>
            <h2 id="local-companion-title" className="text-[15px] font-semibold text-ink">本地助手下载</h2>
            <p className="text-[13px] text-ink-2">Ynote 配套安装包</p>
          </div>
        </div>
        <span className="rounded-full bg-warning-bg px-2.5 py-1 text-xs font-medium text-warning">{choice.testing ? '未签名测试包' : choice.development ? (release?.signature==='valid'?'开发测试包':'未签名开发测试包') : enabled ? '正式发布包' : release?.built ? '开发候选包 · 未发布' : '安装包尚未提供'}</span>
      </div>

      <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
        本地助手负责电脑上的视频下载、FFmpeg 转换、截图和资料存储；转写与文本模型由网站统一提供，不需要下载 ASR 模型。正式下载入口按实际验收与发布状态开放。
      </p>

      <fieldset className="mt-5" aria-describedby="local-companion-selection-help">
        <legend className="mb-2 text-sm font-medium text-ink">选择电脑系统</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PLATFORMS.map(({ id, name, description, icon: Icon }) => (
            <label key={id} className="relative block cursor-pointer">
              <input
                type="radio"
                name="local-companion-platform"
                value={id}
                checked={platform === id}
                onChange={() => setPlatform(id)}
                className="peer sr-only"
                aria-label={name}
              />
              <span className="flex items-center gap-3 rounded-md border border-line-strong bg-page p-4 text-ink transition-colors duration-150 hover:border-accent peer-checked:border-accent peer-checked:bg-sel peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
                <Icon size={22} strokeWidth={1.5} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{name}</span>
                  <span className="mt-0.5 block text-xs text-ink-2">{description}</span>
                </span>
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${platform === id ? 'border-accent' : 'border-line-strong'}`} aria-hidden="true">
                  {platform === id && <span className="h-2 w-2 rounded-full bg-accent" />}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p id="local-companion-selection-help" className="mt-2 text-xs leading-relaxed text-ink-3">选择系统只会切换安装包说明，不会启用本地转写。</p>
      </fieldset>
      {platform==='macos' && <label className="mt-3 block text-sm">Mac 芯片 <select className="ml-3 rounded border border-line bg-page px-2 py-1" value={architecture} onChange={e=>setArchitecture(e.target.value)}><option value="arm64">Apple Silicon · arm64</option><option value="x64">Intel · x86_64</option></select></label>}

      <div className="mt-4 rounded-md border border-line bg-page p-4">
        <div aria-live="polite" aria-atomic="true">
          <p className="text-sm font-medium text-ink">{selected.name} 版{release ? ` · ${release.architecture} · ${release.version}` : ''} · {enabled ? '可下载' : '暂不可下载'}</p>
          <p id="local-companion-package-status" className="mt-1 text-[13px] leading-relaxed text-ink-2">{release?.release_notes || selected.detail}</p>
          {release?.built && <details className="mt-3 text-xs text-ink-3"><summary>候选安装包信息</summary><p className="mt-2">系统要求：{release.minimum_os || '尚未验证'}</p><p className="mt-2 break-all">{release.file_name} · {release.bytes?.toLocaleString()} 字节 · {release.signature==='not_signed'?'未签名':release.signature}</p><p className="mt-1 break-all">SHA-256：{release.sha256}</p></details>}
        </div>
        <button
          type="button"
          disabled={!enabled}
          onClick={()=>{if(choice.url)window.location.assign(choice.url)}}
          aria-describedby="local-companion-package-status local-companion-release-help"
          className={`mt-4 inline-flex min-h-10 w-full ${enabled?'cursor-pointer':'cursor-not-allowed'} items-center justify-center gap-2 rounded-md border border-line bg-subtle px-4 py-2 text-sm font-medium text-ink-3 sm:w-auto`}
        >
          <Download size={16} strokeWidth={1.5} aria-hidden="true" />
          下载 {selected.name} {choice.testing ? '测试版' : choice.development ? '开发测试版' : '版'}{enabled ? '' : '（尚未发布）'}
        </button>
        <p id="local-companion-release-help" className="mt-2 text-xs leading-relaxed text-ink-3">{choice.testing ? '网站管理员已开启测试包分发。此包尚未完成正式签名、生产 HTTPS、干净机器等发布验收；版本与校验信息见上方。' : choice.development ? '仅在本机预览提供开发测试包。此包尚未通过生产 HTTPS、干净机器等正式发布验收；签名与校验信息见上方。' : '正式安装包通过连接、生产 HTTPS、干净机器和签名等发布验收后，才会开放正式下载。'}</p>
      </div>

      <p className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-ink-2">
        <Info size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>安装并连接媒体助手后，可使用网站统一的转写和文本模型；无需填写个人 API Key。</span>
      </p>
    </section>
  )
}
