import { Converter } from 'opencc-js/t2cn'
const convert = Converter({ from: 'tw', to: 'cn' })
/** Presentation-only character conversion. Never fixes recognition errors or mutates ASR originals. */
export const toSimplified = (text: string) => convert(text)
