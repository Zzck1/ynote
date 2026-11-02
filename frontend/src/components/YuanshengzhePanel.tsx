import { useEffect, useId, useRef, useState } from 'react'
import { BookOpen, ExternalLink, Globe, X } from 'lucide-react'

/** Brand links are separate from task data and never call the Ynote API. */
export function YuanshengzhePanel() {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const backdropPointerDown = useRef(false)
  const dialogId = useId()
  const titleId = useId()

  useEffect(() => {
    if (!isOpen) return
    const dialog = dialogRef.current
    if (!dialog) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    if (!dialog.open) dialog.showModal()
    return () => {
      document.body.style.overflow = previousOverflow
      if (dialog.open) dialog.close()
    }
  }, [isOpen])

  const close = () => {
    if (dialogRef.current?.open) dialogRef.current.close()
    setIsOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  // Native dialogs trap focus and make the underlying page inert while open.
  const isOutsidePanel = (event: React.PointerEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom
  }

  return <>
    <button
      ref={triggerRef}
      type="button"
      className="yuanshengzhe-trigger"
      aria-label="原生者：知识库、官网与联系我们"
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      aria-controls={dialogId}
      title="原生者 · 知识库与联系我们"
      onClick={() => setIsOpen(true)}
    >
      <img src="/yuanshengzhe-logo.jpg" width="2048" height="660" alt="原生者" />
    </button>

    <dialog
      ref={dialogRef}
      id={dialogId}
      className="yuanshengzhe-dialog"
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }}
      onClose={() => { if (!dialogRef.current?.open) setIsOpen(false) }}
      onPointerDown={event => { backdropPointerDown.current = isOutsidePanel(event) }}
      onPointerUp={event => {
        if (backdropPointerDown.current && isOutsidePanel(event)) close()
        backdropPointerDown.current = false
      }}
      onPointerCancel={() => { backdropPointerDown.current = false }}
    >
      <div className="yuanshengzhe-dialog-heading">
        <div><h2 id={titleId}>原生者</h2><p>连接知识，保持好奇。</p></div>
        <button type="button" className="yuanshengzhe-close" aria-label="关闭原生者面板" onClick={close} autoFocus><X size={19} aria-hidden="true" /></button>
      </div>

      <div className="yuanshengzhe-links">
        <a href="https://wcno0em1rfbm.feishu.cn/wiki/WgO2wYuL1iTYiBkg4S4cx0oknkb" target="_blank" rel="noopener noreferrer">
          <span className="yuanshengzhe-link-icon"><BookOpen size={20} aria-hidden="true" /></span>
          <span className="yuanshengzhe-link-copy"><strong>知识库</strong><span>前往飞书知识库</span></span>
          <ExternalLink size={15} aria-hidden="true" /><span className="sr-only">（在新标签页打开）</span>
        </a>
        <a href="https://yuanshengzhe.com/" target="_blank" rel="noopener noreferrer">
          <span className="yuanshengzhe-link-icon"><Globe size={20} aria-hidden="true" /></span>
          <span className="yuanshengzhe-link-copy"><strong>原生者官网</strong><span>yuanshengzhe.com</span></span>
          <ExternalLink size={15} aria-hidden="true" /><span className="sr-only">（在新标签页打开）</span>
        </a>
      </div>

      <section className="yuanshengzhe-contact" aria-label="联系我们">
        <h3>联系我们</h3>
        <p>使用微信扫一扫</p>
        <div className="yuanshengzhe-qr-plate"><img src="/yuanshengzhe-contact-qr.jpg" width="698" height="683" alt="原生者联系我们微信二维码" /></div>
        <a className="yuanshengzhe-qr-original" href="/yuanshengzhe-contact-qr.jpg" target="_blank" rel="noopener noreferrer">查看二维码原图 <ExternalLink size={12} aria-hidden="true" /><span className="sr-only">（在新标签页打开）</span></a>
      </section>
    </dialog>
  </>
}
