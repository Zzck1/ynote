import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowUpRight, Check, KeyRound, RefreshCw, Sparkles, X } from 'lucide-react'
import { useQuotaStore } from '../stores/quotaStore'
import { onQuotaExceeded } from '../api/quotaSignals'
import type { QuotaSnapshot } from '../api/quotaTypes'
import './quota-panel.css'
const CONTACT_SUPPORT_EVENT = 'ynote:contact-support'
const CONTACT_FEISHU_URL = 'https://wcno0em1rfbm.feishu.cn/docx/L77Wdwnbwo7kbwxU8bFcoFyznWg'
function remainingPercent(quota: QuotaSnapshot) {
  if (quota.status !== 'active' || quota.daily_limit_fen === null || quota.remaining_fen === null) return '—'
  const limit = BigInt(quota.daily_limit_nano_cny ?? quota.daily_limit_fen)
  const remaining = BigInt(quota.remaining_nano_cny ?? quota.remaining_fen)
  if (limit === 0n || remaining === 0n) return '0%'
  const tenths = remaining * 1000n / limit
  if (tenths === 0n) return '<0.1%'
  return `${Math.min(100, Number(tenths) / 10)}%`
}
function statusText(quota: QuotaSnapshot) {
  if (quota.status === 'preview') return '界面预览 · 额度未启用'
  if (quota.status === 'login_required') return '登录后可查看额度'
  if (quota.status !== 'active') return '后端未配置 · 额度未启用'
  return quota.platform_message
}
export function QuotaSummary() {
  const { mode, quota } = useQuotaStore()
  return <QuotaSummaryView mode={mode} quota={quota} />
}
export function QuotaSummaryView({ mode, quota }: { mode: 'platform' | 'byok'; quota: QuotaSnapshot }) {
  return <div className="quota-summary" aria-label="Ynote AI 用量模式">
    <span className="quota-summary-icon"><Sparkles size={16} aria-hidden="true" /></span>
    <div><strong>{mode === 'platform' ? `全站共享额度 · 还剩 ${remainingPercent(quota)}` : '自备 API Key'}</strong><span>{mode === 'platform' ? statusText(quota) : '个人密钥需服务端验证，不扣平台额度'}</span></div>
    <Link to="/settings#ai-billing">管理 <ArrowUpRight size={13} aria-hidden="true" /></Link>
  </div>
}
export function BillingSettings() {
  const { mode, quota, loading, setMode, refresh } = useQuotaStore()
  const balanceAvailable = quota.status === 'active'
  return <section id="ai-billing" className="quota-settings" aria-labelledby="billing-title">
    <div className="quota-section-heading"><div><p className="quota-kicker">SILICONFLOW</p><h2 id="billing-title">AI 使用方式</h2></div><span className="quota-status">{statusText(quota)}</span></div>
    <fieldset className="quota-mode-fieldset"><legend className="sr-only">选择 AI 计费方式</legend><div className="quota-mode-grid">
      <label className={mode === 'platform' ? 'quota-mode selected' : 'quota-mode'}><input type="radio" name="billing-mode" value="platform" checked={mode === 'platform'} onChange={() => setMode('platform')} /><Sparkles size={19} aria-hidden="true" /><span><strong>免费额度（默认）</strong><small>所有访客共享 · 无需登录</small></span>{mode === 'platform' && <Check size={17} aria-hidden="true" />}</label>
      <label className={mode === 'byok' ? 'quota-mode selected' : 'quota-mode'}><input type="radio" name="billing-mode" value="byok" checked={mode === 'byok'} onChange={() => setMode('byok')} /><KeyRound size={19} aria-hidden="true" /><span><strong>自备 API Key</strong><small>服务端验证通过后使用</small></span>{mode === 'byok' && <Check size={17} aria-hidden="true" />}</label>
    </div></fieldset>
    {mode === 'platform' ? <div className="quota-platform-card">
      <div className="quota-allowance" aria-live="polite"><strong>还剩 {remainingPercent(quota)}<small> · 全站共享</small></strong></div>
      {quota.capabilities && <div className="quota-explanation"><p>文本模型：{quota.capabilities.text_ai?.model || '未配置'} · {quota.capabilities.text_ai?.available ? '已启用' : '未启用'}</p><p>语音转写：{quota.capabilities.transcription?.model || '未配置'} · {quota.capabilities.transcription?.available ? '已启用' : '未启用'}</p><p>本地媒体助手负责下载、转换和存储；网站统一提供转写和文本模型，无需下载 ASR 模型或填写个人 Key。仅在服务返回真实时间戳时显示时间信息。</p></div>}
      {balanceAvailable && quota.resets_at && <p className="quota-explanation">下次重置：{new Date(quota.resets_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）</p>}
      <div className="quota-platform-footer"><button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13} aria-hidden="true" />{loading ? '正在读取' : '刷新状态'}</button></div>
    </div> : null}
  </section>
}
export function ContactSupportNotice() {
  const quota = useQuotaStore(state => state.quota)
  return <p className="quota-contact-notice">{quota.daily_limit_fen === null ? '共享免费额度尚未启用' : `全站共享免费额度还剩 ${remainingPercent(quota)}`}，如需帮助，请<button type="button" aria-haspopup="dialog" onClick={() => window.dispatchEvent(new Event(CONTACT_SUPPORT_EVENT))}>联系客服</button>。</p>
}
/** Voluntary contact is presentation-only; only actual quota errors mark exhaustion. */
export function QuotaExceededDialog() {
  const [open, setOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<'contact' | 'exhausted'>('contact')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const navigate = useNavigate()
  const setMode = useQuotaStore(state => state.setMode)
  useEffect(() => {
    const openContact = () => { setDialogMode('contact'); setOpen(true) }
    window.addEventListener(CONTACT_SUPPORT_EVENT, openContact)
    return () => window.removeEventListener(CONTACT_SUPPORT_EVENT, openContact)
  }, [])
  useEffect(() => onQuotaExceeded(() => {
    useQuotaStore.getState().markExhausted()
    setDialogMode('exhausted')
    setOpen(true)
    void useQuotaStore.getState().refresh()
  }), [])
  useEffect(() => {
    if (!open || !dialogRef.current) return
    previousFocus.current = document.activeElement as HTMLElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!dialogRef.current.open) dialogRef.current.showModal()
    return () => {
      document.body.style.overflow = previousOverflow
      if (dialogRef.current?.open) dialogRef.current.close()
      previousFocus.current?.focus({ preventScroll: true })
    }
  }, [open])
  function close() { setOpen(false) }
  function useOwnKey() {
    close()
    setMode('byok')
    navigate('/settings#byok-settings')
    requestAnimationFrame(() => document.getElementById('byok-settings')?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }
  const quota = useQuotaStore(state => state.quota)
  const exhausted = dialogMode === 'exhausted'
  return <dialog ref={dialogRef} className="quota-dialog" data-mode={dialogMode} aria-labelledby="quota-dialog-title" aria-describedby={exhausted ? "quota-dialog-description" : undefined} onCancel={event => { event.preventDefault(); close() }} onClose={close}>
    <div className="quota-dialog-heading"><span className="quota-dialog-icon"><Sparkles size={23} aria-hidden="true" /></span><button type="button" aria-label={exhausted ? '关闭额度提示' : '关闭客服窗口'} onClick={close} autoFocus><X size={19} aria-hidden="true" /></button></div>
    <h2 id="quota-dialog-title">{exhausted ? quota.platform_message : '联系客服'}</h2>{exhausted && <p id="quota-dialog-description">{quota.platform_message}。全站共享额度还剩 {remainingPercent(quota)}。继续使用，可填写并验证自己的 API Key。</p>}
    <div className="quota-contact"><h3>{exhausted ? '联系客服' : '微信客服'}</h3><p>使用微信扫描下方二维码</p><div className="quota-qr-plate"><img src="/quota-contact-qr.jpg" width="888" height="1245" alt="联系客服微信二维码，星期八" /></div><a href="/quota-contact-qr.jpg" target="_blank" rel="noopener noreferrer">查看二维码原图</a><a className="quota-feishu-link" href={CONTACT_FEISHU_URL} target="_blank" rel="noopener noreferrer">打开飞书链接<ArrowUpRight size={14} aria-hidden="true" /></a></div>
    {exhausted && <p className="quota-dialog-note">联系客服不代表充值、增加额度或解锁服务。{quota.resets_at ? `下次额度重置：${new Date(quota.resets_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）。` : ''}</p>}
    {exhausted && <button type="button" className="quota-own-key" onClick={useOwnKey}><KeyRound size={16} aria-hidden="true" />填写自己的 API Key</button>}<button type="button" className="quota-dismiss" onClick={close}>{exhausted ? '暂不使用' : '关闭'}</button>
  </dialog>
}
