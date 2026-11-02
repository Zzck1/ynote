import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { models, infer, stopInference, modelCached, downloadModel, MODEL_CACHE } from '../src/browser/engine'
import { timestamp, validateNote } from '../src/browser/media'
import { browserRequest, browserAssetUrl } from '../src/browser/adapter'
import { read, write } from '../src/browser/storage'
import { parseSelection, requireFullSourceCoverage, requireAuditableSource } from '../src/browser/notePlan'
import { resolveObjectURL } from 'node:buffer'
import { unzipSync, strFromU8 } from 'fflate'
import { validateAsrText } from '../src/browser/asrValidation'
import { installLocalNetworkGuard } from '../src/browser/privacy'
import { updateModel, modelReady } from '../src/browser/modelState'
import { toSimplified } from '../src/utils/simplified'
const checks: string[] = []
const pass = (name: string) => { checks.push(name); console.log('PASS',name) }
Object.defineProperty(globalThis, 'location', { value: { origin: 'https://local.test', href:'https://local.test/' }, configurable: true })
const entries = new Map<string, Response>()
const cache = { match: async (key: string) => entries.get(String(key))?.clone(), put: async (key: string, r: Response) => { const b = await r.arrayBuffer(); entries.set(key,new Response(b,{headers:r.headers})) }, delete: async (key: string) => entries.delete(key) }
Object.defineProperty(globalThis, 'caches', { value: { open: async (name: string) => { assert.equal(name,MODEL_CACHE); return cache } }, configurable: true })
for (const m of models) for (const f of m.files) entries.set(`https://local.test/models/${m.id}/resolve/${m.revision}/${f.name}`,new Response('',{headers:{'x-ynote-bytes':String(f.bytes)}}))
class FakeWorker {
  static latest: FakeWorker
  static count = 0
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  message: { id: string } | null = null
  constructor() { FakeWorker.latest = this; FakeWorker.count++ }
  postMessage(value: { id: string }) { this.message = value }
  terminate() { this.terminated = true }
  emit(type: string, payload: unknown) { this.onmessage?.({data:{id:this.message!.id,type,payload}}) }
}
Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true })
const tick = () => new Promise(resolve => setTimeout(resolve,0))
const pendingAbort = new AbortController()
const beforeCount = FakeWorker.count
const preflight = infer('asr',{audio:new Float32Array(2)},()=>{},pendingAbort.signal)
pendingAbort.abort();await assert.rejects(preflight)
assert.equal(FakeWorker.count,beforeCount)
assert.equal(timestamp(3723123),'01:02:03,123')
assert(!validateNote('# 标题\n- <img src=x onerror=alert(1)>测试\n- [链接](https://evil.test)').includes('https://'))
assert(!validateNote('# 标题\n<script>bad</script>').includes('<script>'))
assert.throws(()=>validateNote(''))
assert.throws(()=>validateNote('# T\n'+'- x\n'.repeat(501)))
assert.deepEqual(parseSelection('[1,3,2,2]',5),[1,2,3])
requireFullSourceCoverage([[1,2],[1]],[2,1])
assert.throws(()=>requireFullSourceCoverage([[1,2,3]],[5]),/未选 2/)
assert.throws(()=>requireFullSourceCoverage([[2]],[3]),/未选 2/)
assert.throws(()=>requireFullSourceCoverage([],[1]),/分组不完整/)
const evidenceSegment=(text:string,start:number,end:number)=>({text,start_ms:start,end_ms:end,source_chunk:JSON.stringify({offset_samples:0,samples:160000,sample_rate:16000,raw_timestamp:[start/1000,end/1000]})})
requireAuditableSource([evidenceSegment('不同内容，数值17。',0,1000)],10)
assert.throws(()=>requireAuditableSource([evidenceSegment('任意原文',0,11000)],10),/音轨范围/)
assert.throws(()=>requireAuditableSource([evidenceSegment('任意原文',0,11000)],20),/输入块范围/)
assert.throws(()=>requireAuditableSource([evidenceSegment('甲',0,1000),evidenceSegment('乙',900,2000)],10),/重叠/)
assert.throws(()=>requireAuditableSource([0,1,2].map(i=>evidenceSegment('任意重复内容',i*1000,(i+1)*1000)),10),/连续重复/)
for (const value of ['[0]','[6]','["1"]','[]','{"segments":[1]}','[1] explanation','[1.5]']) assert.throws(()=>parseSelection(value,5))
validateAsrText('正常语句',0,2)
assert.throws(()=>validateAsrText('噪声',0,null))
assert.throws(()=>validateAsrText('鑑子'.repeat(10),0,8))
pass('Timestamp formatting and note/diagram boundary rejects empty or oversized trees and removes active markup/links')
for(const m of models) updateModel(m.kind as 'asr'|'text',{phase:'ready',message:'SIMULATED initialization for unit test only',fingerprint:m.revision})
assert(modelReady('asr'));assert.equal(toSimplified('代表著舊有格局。著作權。'),'代表着旧有格局。著作权。')
const first = infer('asr',{audio:new Float32Array(10)},()=>{})
await tick()
await assert.rejects(infer('text',{parts:['x']},()=>{}),/同一时间/)
const oldWorker = FakeWorker.latest
stopInference(); await assert.rejects(first,/取消/); assert(oldWorker.terminated)
const second = infer<string>('text',{parts:['actual transcript']},()=>{})
await tick(); oldWorker.emit('result','STALE')
FakeWorker.latest.emit('result','CURRENT'); assert.equal(await second,'CURRENT')
pass('Simulated Worker double-click exclusion, cancellation/termination, stale result isolation and retry')
const failed = infer('asr',{audio:new Float32Array(2)},()=>{})
await tick();FakeWorker.latest.onerror?.();await assert.rejects(failed,/Worker/)
const retry = infer<string>('text',{parts:['x']},()=>{})
await tick();FakeWorker.latest.emit('result','retry');assert.equal(await retry,'retry')
pass('Simulated Worker crash/low-memory error releases lock without remote fallback; retry succeeds')
entries.clear();assert.equal(await modelCached('asr'),false)
const count = FakeWorker.count
await assert.rejects(infer('asr',{audio:new Float32Array(2)},()=>{}),/模型未完整缓存/)
assert.equal(FakeWorker.count,count)
const controller = new AbortController();controller.abort()
Object.defineProperty(globalThis,'isSecureContext',{value:true,configurable:true})
Object.defineProperty(navigator,'storage',{value:{estimate:async()=>({quota:1e12,usage:0})},configurable:true})
await assert.rejects(downloadModel('asr',controller.signal,()=>{}))
Object.defineProperty(navigator,'storage',{value:{estimate:async()=>({quota:1,usage:0})},configurable:true})
await assert.rejects(downloadModel('text',new AbortController().signal,()=>{}),/空间不足/)
pass('Missing cache, aborted download and insufficient storage stop explicitly before model execution')
await write('roundtrip',{x:'local only'});assert.deepEqual(await read('roundtrip'),{x:'local only'})
const abortedWrite = new AbortController();abortedWrite.abort()
await assert.rejects(write('cancelled-result',{text:'stale'},abortedWrite.signal))
assert.equal(await read('cancelled-result'),undefined)
let networkCalls = 0
globalThis.fetch = async () => { networkCalls++;throw new Error('unexpected network') }
const form = new FormData();form.append('file',new File([new Uint8Array([1,2,3])],'unit.wav',{type:'audio/wav'}))
const imported = await (await browserRequest('/api/materials/import',{method:'POST',body:form})).json()
assert(imported.material.id)
const created = await (await browserRequest('/api/tasks',{method:'POST',body:JSON.stringify({source_id:imported.material.id,raw_input:'unit.wav'})})).json()
const detail = await (await browserRequest('/api/tasks/'+created.id)).json()
assert.equal(detail.assets[0].bytes,3);assert(browserAssetUrl('/api/assets/'+detail.assets[0].id+'/download').startsWith('blob:'))
const linkTask = await (await browserRequest('/api/tasks',{method:'POST',body:JSON.stringify({raw_input:'https://bilibili.com/video/example'})})).json()
const denied = await browserRequest('/api/tasks/'+linkTask.id+'/start',{method:'POST',body:'{}'})
assert.equal(denied.status,400);assert((await denied.json()).error.message.includes('本地文件'))
const unknown = await browserRequest('/api/ai/text',{method:'POST',body:'{"prompt":"private"}'})
assert.equal(unknown.status,400);assert.equal(networkCalls,0)
pass('IndexedDB roundtrip/local file adapter uses blob URLs; platform links and cloud AI routes are denied with zero fetch calls')
for (const m of models) for (const f of m.files) entries.set(`https://local.test/models/${m.id}/resolve/${m.revision}/${f.name}`,new Response('',{headers:{'x-ynote-bytes':String(f.bytes)}}))
for(const m of models) updateModel(m.kind as 'asr'|'text',{phase:'ready',message:'SIMULATED initialization for unit test only',fingerprint:m.revision})
const segment = {id:'source-1',transcript_version_id:'v1',...evidenceSegment('实际原文，不添加新事实。',1234,5678)}
await write('material:note-test',{material:{...imported.material,id:'note-test'},file:new File(['data'],'unit.wav'),assets:[],transcript:{version:{id:'v1'},segments:[segment]},note:null})
const noteRequest = browserRequest('/api/materials/note-test/notes',{method:'POST',body:'{}'})
await tick();await tick();FakeWorker.latest.emit('result',[[1]])
const noted = await (await noteRequest).json()
assert(noted.note.markdown.includes('实际原文，不添加新事实。'))
assert(noted.note.markdown.includes('00:00:01,234 → 00:00:05,678'))
assert(!noted.note.markdown.includes('STALE'))
const packaged = await (await browserRequest('/api/materials/note-test/exports',{method:'POST',body:'{}'})).json()
const archive=resolveObjectURL(packaged.download_url)!
const files=unzipSync(new Uint8Array(await archive.arrayBuffer()))
assert(strFromU8(files['transcript.srt']).includes('00:00:01,234 --> 00:00:05,678'))
assert(strFromU8(files['notes.md']).includes('实际原文'))
assert.equal(JSON.parse(strFromU8(files['transcript.json']))[0].text,segment.text)
assert.equal(networkCalls,0)
pass('Simulated selection is rendered exclusively from real source fields; local ZIP/SRT/JSON/Markdown roundtrip preserves exact facts and times')
const policies: unknown[]=[]
const fakeWindow={fetch:async()=>{networkCalls++;return new Response('static')}}
Object.defineProperty(globalThis,'window',{value:fakeWindow,configurable:true})
Object.defineProperty(globalThis,'document',{value:{createElement:()=>({}),head:{append:(policy:unknown)=>policies.push(policy)}},configurable:true})
Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null},configurable:true})
Object.defineProperty(globalThis,'XMLHttpRequest',{value:class {send(){}},configurable:true})
installLocalNetworkGuard()
const guarded=fakeWindow.fetch as typeof fetch
await guarded('/api/tasks',{method:'POST',body:'explicit server request'})
await guarded('/assets/app.js')
assert.equal(networkCalls,2);assert.equal(policies.length,0)
pass('Server processing mode leaves real API transport available and does not install the browser-only network guard or CSP')
console.log(JSON.stringify({kind:'automated-unit-and-simulated-worker',passed:checks.length,checks},null,2))
