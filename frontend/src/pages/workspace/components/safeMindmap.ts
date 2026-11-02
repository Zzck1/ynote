import { Transformer } from 'markmap-lib'

/** Source text is untrusted. Markmap uses innerHTML, so only emit a tiny formatting subset. */
export function createSafeMindmap(markdown: string) {
  const transformer = new Transformer()
  transformer.md.set({ html: false })
  transformer.md.renderer.rules.image = () => '[图片已隐藏]'
  transformer.md.renderer.rules.link_open = () => ''
  transformer.md.renderer.rules.link_close = () => ''
  const { root } = transformer.transform(markdown.replace(/\s*\[[a-f0-9]{24,64}\]/gi, ''))
  const allowed = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'S', 'DEL', 'BR', 'SPAN', 'SUB', 'SUP', 'SMALL'])
  function clean(content: string) {
    const template = document.createElement('template')
    template.innerHTML = content
    for (const element of Array.from(template.content.querySelectorAll('*')).reverse()) {
      if (['SCRIPT', 'STYLE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK', 'META'].includes(element.tagName)) {
        element.remove()
      } else if (!allowed.has(element.tagName)) {
        element.replaceWith(...Array.from(element.childNodes))
      } else {
        for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name)
      }
    }
    return template.innerHTML
  }
  function visit(node: { content: string; children?: typeof root[] }) {
    node.content = clean(node.content)
    node.children?.forEach(visit)
  }
  visit(root)
  return root
}
