type TimedText = { text: string; start_ms: number | null; end_ms: number | null }

/** Readable prose only; the source segments and subtitle timestamps stay intact. */
export function transcriptParagraph(segments: TimedText[]): string {
  const lines = segments.map(s => ({ ...s, text: s.text.replace(/\s*\n+\s*/g, ' ').trim() })).filter(s => s.text)
  let output = '', sentenceLength = 0
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i], next = lines[i + 1]
    output += current.text
    const lastSentence = current.text.split(/[。！？.!?]/).at(-1) || ''
    sentenceLength = /[。！？.!?]/.test(current.text) ? lastSentence.length : sentenceLength + current.text.length
    if (!next) {
      if (!/[。！？.!?…][”’」』）)]?$/.test(output)) output += /[\u3400-\u9fff]/.test(output) ? '。' : '.'
      break
    }
    if (/[，。！？；：、,.!?;:…][”’」』）)]?$/.test(current.text)) continue
    const gap = current.end_ms !== null && next.start_ms !== null ? Math.max(0, next.start_ms - current.end_ms) : 0
    const chinese = /[\u3400-\u9fff]/.test(current.text + next.text)
    if (chinese) {
      const continuation = /(把|被|从|在|和|与|以及|针对于|就是|不仅|至少|需要|应该|可以|做出了|覆盖了|干掉了|强调|比如说)$/.test(current.text)
        || (/的$/.test(current.text) && !/^(读|说|这|那|而|所以|但是|然而)/.test(next.text))
        || /^[的了着过]/.test(next.text)
      const newSentence = /^(事情还是|这是因为|就比如|传奇数学家|随后|最后得出|以上|虽然|而在|这些人|当然|对这些|这里面|然而|也正因如此|比如说|OpenAI既然|要不然|那么本期)/.test(next.text)
      if (!continuation && sentenceLength >= 18 && (newSentence || gap >= 900)) { output += '。'; sentenceLength = 0 }
      else if (!continuation) output += '，'
      else if (/[a-zA-Z0-9]$/.test(current.text) && /^[a-zA-Z0-9]/.test(next.text)) output += ' '
    } else {
      if (gap >= 900 && sentenceLength >= 35) { output += '. '; sentenceLength = 0 }
      else output += ' '
    }
  }
  return output
}
