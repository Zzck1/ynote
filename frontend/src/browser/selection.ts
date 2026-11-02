import { LogitsProcessor, type PreTrainedTokenizer, type Tensor } from '@huggingface/transformers'
/** Constrained decoding: the model can choose only valid source IDs, punctuation and EOS.
 * This constrains syntax, never supplies preselected source content or fabricated notes.
 */
export class SourceSelectionGrammar extends LogitsProcessor {
  private start: number | null = null
  private tokens = new Map<string, number>()
  constructor(private tokenizer: PreTrainedTokenizer, private count: number) {
    super()
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('编号选择仅支持每组 1–20 个原文片段')
    for (const char of '[],0123456789') {
      const encoded = tokenizer.encode(char, { add_special_tokens: false })
      if (encoded.length !== 1) throw new Error('候选模型不支持当前编号约束解码；未生成笔记')
      this.tokens.set(char, Number(encoded[0]))
    }
  }
  _call(inputIds: bigint[][], logits: Tensor) {
    if (inputIds.length !== 1) throw new Error('本地编号生成只支持单任务')
    if (this.start === null) this.start = inputIds[0].length
    const generated = inputIds[0].slice(this.start)
    const prefix = generated.length ? this.tokenizer.decode(generated, { skip_special_tokens: true, clean_up_tokenization_spaces: false }) : ''
    const chars = new Set<string>()
    const allowed = new Set<number>()
    if (!prefix) chars.add('[')
    else if (prefix.endsWith(']')) allowed.add(this.tokenizer.eos_token_id)
    else {
      if (!prefix.startsWith('[')) throw new Error('编号约束解码状态无效')
      const values = prefix.slice(1).split(',')
      const current = values.pop() ?? ''
      const selected = new Set(values.map(Number))
      const remaining = Array.from({ length: this.count }, (_, i) => String(i + 1)).filter(n => !selected.has(Number(n)))
      for (const n of remaining) if (n.startsWith(current) && n.length > current.length) chars.add(n[current.length])
      if (remaining.includes(current)) {
        chars.add(']')
        if (remaining.length > 1) chars.add(',')
      }
    }
    for (const char of chars) allowed.add(this.tokens.get(char)!)
    if (!allowed.size) throw new Error('编号约束解码无合法后续，笔记未生成')
    const scores = logits.data as Float32Array
    for (let i = 0; i < scores.length; i++) if (!allowed.has(i)) scores[i] = -Infinity
    return logits
  }
}
export { parseSelection } from './notePlan'
