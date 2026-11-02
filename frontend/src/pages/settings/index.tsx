import { useSyncExternalStore } from 'react'
import { BillingSettings, ContactSupportNotice } from '../../components/QuotaPanel'
import { FirstUseButton } from '../../components/FirstUseSetup'
import { companionSnapshot, subscribeCompanion } from '../../api/companion'
import { useQuotaStore } from '../../stores/quotaStore'
import { ProviderForm } from './components/ProviderForm'
import { LocalCompanionDownload } from './components/LocalCompanionDownload'
import { LocalConnection } from './components/LocalConnection'
import { browserLocal } from '../../browser/mode'
import { BrowserSettings } from '../../browser/BrowserSettings'

export function SettingsPage(){
  const mode=useQuotaStore(state=>state.mode),quota=useQuotaStore(state=>state.quota)
  const connection=useSyncExternalStore(subscribeCompanion,companionSnapshot,companionSnapshot)
  if(browserLocal())return <div className="h-full overflow-y-auto"><BrowserSettings/></div>
  const advanced=typeof location!=='undefined'&&['#ai-billing','#byok-settings'].includes(location.hash)
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-[780px] px-6 py-10">
    <h1 className="text-3xl font-semibold leading-relaxed text-ink">设置</h1>
    <section className="mt-6 rounded-lg border border-line bg-subtle p-6" aria-labelledby="setup-main-title">
      <h2 id="setup-main-title" className="text-lg font-semibold">一键配置全部服务</h2>
      <p className="mt-3 text-sm text-ink-2">安装、启动检测、连接配对、媒体工具和网站模型授权都在同一个配置窗口完成。缺少助手时，该窗口提供下载和解压启动步骤；启动后会自动继续，无需分别寻找多个入口。</p>
      <div className="mt-5 flex [&_.first-use-button]:ml-0"><FirstUseButton/></div>
      <p className="mt-4 text-sm text-ink-2" role="status">媒体助手：{connection.state}<br/>网站模型：{quota.platform_message}</p>
      <p className="mt-3 text-sm text-ink-2">配置完成后，快速提取使用 SenseVoiceSmall，精准提取使用 Qwen3-ASR-1.7B；自动产出视频、音频、一张封面、文案、AI 笔记和导图。文案默认显示前三行，可展开查看完整内容。</p>
      <p className="mt-3 text-xs text-ink-3">原视频、封面和历史留在本地助手；仅准备后的音频与生成笔记所需文字发送到网站模型代理。不下载 ASR 模型，平台 Key 由管理员统一配置。配对和浏览器本地网络权限需要你本人确认。</p>
    </section>
    <details className="mt-6 rounded-lg border border-line p-5" open={advanced||undefined}>
      <summary className="cursor-pointer text-sm font-medium">高级设置：额度与手动检查</summary>
      <BillingSettings/>
      <ContactSupportNotice/>
      {mode==='byok'&&<section id="byok-settings" className="scroll-mt-5">
        <div className="mt-6 rounded-lg border border-line bg-subtle p-6"><ProviderForm kind="text_ai" title="个人文本 AI 服务" description="仅自备 API Key 模式使用"/></div>
        <div className="mt-6 rounded-lg border border-line bg-subtle p-6"><ProviderForm kind="transcription" title="个人转写服务" description="仅自备 API Key 模式使用"/></div>
      </section>}
      <LocalConnection/>
      <LocalCompanionDownload/>
    </details>
  </div></div>
}
