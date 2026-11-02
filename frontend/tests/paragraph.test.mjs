import { build } from 'esbuild'
import assert from 'node:assert/strict'
await build({entryPoints:['src/utils/transcriptParagraph.ts'],bundle:true,platform:'node',format:'esm',outfile:'tests/.paragraph.mjs'})
const { transcriptParagraph }=await import('./.paragraph.mjs')
const source=[{text:'这是一段测试',start_ms:0,end_ms:2000},{text:'我们继续介绍功能',start_ms:2300,end_ms:5000},{text:'最后欢迎使用。',start_ms:6000,end_ms:8000}]
const before=JSON.stringify(source);const text=transcriptParagraph(source)
assert(!text.includes('\n'));assert(text.includes('，'));assert(text.endsWith('。'));assert(!text.includes('。。'));assert.equal(JSON.stringify(source),before)
assert.equal(transcriptParagraph([{text:'Hello',start_ms:0,end_ms:200},{text:'world.',start_ms:200,end_ms:500}]),'Hello world.')
assert.equal(transcriptParagraph([]),'')
console.log('PASS paragraph punctuation, no hard line breaks, English spacing, original segments unchanged')
