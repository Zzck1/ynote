import assert from 'node:assert/strict'
import fs from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { parseQuota, unavailableQuota } from '../src/api/quotaTypes'
import { getQuota, validateByok } from '../src/api/quota'
import { useQuotaStore, billingContext, isManagedAiReady } from '../src/stores/quotaStore'
import { inspectQuotaHttpError, inspectQuotaJob, onQuotaExceeded } from '../src/api/quotaSignals'
import { request } from '../src/api/client'
import { SettingsPage } from '../src/pages/settings'
import { QuotaSummaryView } from '../src/components/QuotaPanel'
import { TranscriptPreview } from '../src/components/TranscriptPreview'
import { ResultImageGallery } from '../src/components/ResultImageGallery'
import { ExtractionButtons } from '../src/components/ExtractionButtons'
import { requestTask } from '../src/api/tasks'
import { companionDownload, type CompanionRelease } from '../src/api/companionRelease'
import type { Asset } from '../src/api/types'
import { createNote, chat, createJobs } from '../src/api/materials'
import { setCompanionPolicy } from '../src/api/companion'
setCompanionPolicy(undefined) // Legacy contract fixtures in this file intentionally lack a processing policy.
Object.defineProperty(globalThis,'window',{value:{confirm:()=>true},configurable:true})
Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=> 'remote'},configurable:true})
Object.defineProperty(globalThis,'location',{value:{origin:'https://legacy.test'},configurable:true})
const checks: string[] = []
const pass = (name: string) => { checks.push(name); console.log('PASS', name) }
const active = { ...unavailableQuota(), status: 'active' as const, daily_limit_fen: 1250, budget_state: 'available' as const, platform_message: '服务端预算已就绪', platform_available: true, used_fen: 120, reserved_fen: 30, remaining_fen: 1100, resets_at: '2026-10-24T00:00:00+08:00' }
const connection = { kind: 'text_ai' as const, valid: true as const, connection_id: 'test-opaque-id', expires_at: new Date(Date.now() + 3600_000).toISOString(), provider: 'siliconflow' as const, model: 'test-model', verification: 'provider' as const }
const calls: { path: string; options?: RequestInit }[] = []
let responder: (path: string, options?: RequestInit) => Response = () => new Response(JSON.stringify(active))
globalThis.fetch = async (resource, options) => { const path = String(resource); calls.push({ path, options }); return responder(path, options) }
const initial = useQuotaStore.getState()
assert.equal(initial.mode, 'platform'); assert.equal(initial.quota.remaining_fen, null)
for (const invalid of [null, {}, {...active, tool:'ytran'}, {...active, daily_limit_fen:-1}, {...active,daily_limit_fen:1.5}, {...active, remaining_fen:1251}, {...active, remaining_fen:-1}, {...active, used_fen:NaN}, {...active,resets_at:'invalid'}]) assert.equal(parseQuota(invalid).status, 'unavailable')
for (const status of ['preview', 'unavailable', 'login_required']) assert.equal(parseQuota({...active,status}).remaining_fen, null)
assert.equal(parseQuota(active).remaining_fen, 1100)
pass('Platform defaults without a fake balance; contract validation rejects mismatched tools, invalid money and untrusted unavailable balances')

let events = 0
const unsubscribe = onQuotaExceeded(() => events++)
for (const status of [400,401,403,429,500,503]) inspectQuotaHttpError(status,'QUOTA_EXCEEDED')
inspectQuotaHttpError(402,'BYOK_INVALID'); assert.equal(events,0)
inspectQuotaHttpError(402,'QUOTA_EXCEEDED'); assert.equal(events,1)
inspectQuotaJob({id:'a',error_code:'QUOTA_EXCEEDED'}); inspectQuotaJob({id:'a',error_code:'QUOTA_EXCEEDED'}); assert.equal(events,2)
inspectQuotaJob({id:'b',operations:[{error_code:'QUOTA_EXCEEDED'}]}); assert.equal(events,3)
inspectQuotaJob({job_id:'c',error:{code:'QUOTA_EXCEEDED'}}); assert.equal(events,4)
inspectQuotaJob({id:'d',stage:'QUOTA_EXCEEDED'}); assert.equal(events,4)
pass('Only real-shaped 402/QUOTA_EXCEEDED and typed job errors notify; polling repeats and text messages cannot manufacture exhaustion')

responder = () => new Response(JSON.stringify({error:{code:'QUOTA_EXCEEDED',message:'Quota full'}}),{status:402})
await assert.rejects(request('POST','/api/tasks/test/start',{})); assert.equal(events,5)
responder = () => new Response(JSON.stringify({result_job:{id:'task-result',error_code:'QUOTA_EXCEEDED'}}))
await request('GET','/api/tasks/test'); assert.equal(events,6)
responder = () => new Response(JSON.stringify({error:{code:'LOGIN_REQUIRED'}}),{status:401})
assert.equal((await getQuota()).status,'login_required')
responder = () => new Response('<!doctype html>',{status:200})
assert.equal((await getQuota()).status,'unavailable')
pass('Shared transport covers task polling, actual HTTP errors, login-required and static-host HTML failure without claiming quota is active')

useQuotaStore.setState({mode:'platform',quota:active})
assert.equal(isManagedAiReady(),true); assert.equal(isManagedAiReady('transcription'),false)
assert.deepEqual(billingContext('text_ai'),{tool:'ynote',billing_mode:'platform'})
assert.throws(()=>billingContext('transcription'),/平台转写尚未启用/)
useQuotaStore.setState({quota:{...active,remaining_fen:0,used_fen:1000,reserved_fen:0}})
assert.doesNotThrow(()=>billingContext('text_ai'))
useQuotaStore.setState({mode:'byok',connections:{}})
assert.throws(()=>billingContext('text_ai'),/不会自动改用免费额度/)
assert.equal(useQuotaStore.getState().mode,'byok')
useQuotaStore.getState().setConnection(connection)
assert.deepEqual(billingContext('text_ai'),{tool:'ynote',billing_mode:'byok',connection_id:'test-opaque-id'})
useQuotaStore.getState().invalidateConnection('text_ai')
assert.throws(()=>billingContext('text_ai'))
assert.deepEqual(billingContext().connections,{})
useQuotaStore.getState().setConnection({...connection,expires_at:'2020-01-01T00:00:00Z'})
assert.throws(()=>billingContext('text_ai')); assert.deepEqual(billingContext().connections,{})
pass('Platform needs no personal key, zero rounded display does not enforce balance, legacy servers do not claim ASR readiness, invalid/expired BYOK never falls back')

const platformReady = { ...active, capabilities: {
  text_ai: {available:true,model:'deepseek-ai/DeepSeek-V4.1-Flash'},
  transcription: {available:true,model:'Qwen/Qwen3-ASR-1.7B'},
} }
const parsedReady = parseQuota(platformReady)
assert.deepEqual(parsedReady.capabilities,platformReady.capabilities)
assert.deepEqual(parseQuota({...platformReady,processing:{media:'companion',models:'gateway'}}).processing,{media:'companion',models:'gateway'})
assert.equal(parseQuota({...platformReady,processing:{media:'cloud',models:'gateway'}}).status,'unavailable')
for (const capabilities of [null,{}, {...platformReady.capabilities,transcription:{available:'true',model:'fake'}}, {...platformReady.capabilities,transcription:{available:true,model:''}}]) {
  assert.equal(parseQuota({...platformReady,capabilities}).status,'unavailable')
}
assert.equal(parseQuota({...platformReady,platform_available:false}).status,'unavailable')
useQuotaStore.setState({mode:'platform',quota:parsedReady,connections:{}})
assert.equal(isManagedAiReady('transcription'),true);assert.equal(isManagedAiReady('text_ai'),true)
assert.deepEqual(billingContext('transcription'),{tool:'ynote',billing_mode:'platform'})
useQuotaStore.setState({quota:{...parsedReady,capabilities:{...parsedReady.capabilities,transcription:{available:false,model:'Qwen/Qwen3-ASR-1.7B'}}}})
assert.equal(isManagedAiReady('transcription'),false);assert.equal(isManagedAiReady('text_ai'),true)
assert.throws(()=>billingContext('transcription'),/平台转写尚未启用/)
useQuotaStore.setState({quota:parsedReady})
responder = () => new Response(JSON.stringify({job:{},note:{},conversation:{}}))
await createJobs('material',{operations:['transcript'],idempotency_key:'platform-asr'})
await createNote('material',{transcript_version_id:'v1'})
await chat('material',{question:'test'})
for (const call of calls.slice(-3)) {
  const body=JSON.parse(call.options!.body as string)
  assert.equal(body.billing_mode,'platform');assert.equal(body.tool,'ynote')
  assert(!('api_key' in body));assert(!('connection_id' in body));assert(!('connections' in body))
}
pass('Server capability flags enable platform ASR, notes and chat without personal keys; partial/invalid capabilities fail closed')

for (const extractionMode of ['quick','precise'] as const) {
  await requestTask('/mode-task/start',{raw_input:'https://www.bilibili.com/video/example',extraction_mode:extractionMode})
  assert.equal(JSON.parse(calls.at(-1)!.options!.body as string).extraction_mode,extractionMode)
  assert.equal(calls.at(-1)!.path,'/api/tasks/mode-task/start')
  await requestTask('/batch',{extraction_mode:extractionMode,entries:[{raw_input:'https://www.bilibili.com/video/example'}]})
  const batchBody=JSON.parse(calls.at(-1)!.options!.body as string)
  assert.equal(batchBody.extraction_mode,extractionMode);assert.equal(batchBody.billing_mode,'platform')
  await createJobs('material',{operations:['transcript'],idempotency_key:'mode-'+extractionMode,extraction_mode:extractionMode})
  assert.equal(JSON.parse(calls.at(-1)!.options!.body as string).extraction_mode,extractionMode)
}
await requestTask('/mode-task/transcript',{})
assert(!('extraction_mode' in JSON.parse(calls.at(-1)!.options!.body as string))) // Server retains the task's selected mode.
for (const busyMode of ['quick','precise'] as const) {
  const controls=renderToStaticMarkup(<ExtractionButtons disabled busyMode={busyMode} onExtract={()=>{}} />)
  assert(controls.includes('快速提取'));assert(controls.includes('精准提取'))
  assert(controls.includes(busyMode==='quick'?'快速提取中…':'精准提取中…'))
  assert(!controls.includes(busyMode==='quick'?'精准提取中…':'快速提取中…'))
  assert.equal((controls.match(/aria-busy="true"/g) ?? []).length,1)
}
pass('Quick and precise single/batch requests preserve extraction mode and platform context; transcript retry lets the server retain mode and only the running button claims activity')

responder = path => new Response(JSON.stringify(path.startsWith('/api/quota') ? active : connection))
const validated = await validateByok({kind:'text_ai',base_url:'https://api.siliconflow.cn/v1',model:'test-model',api_key:'unit-test-secret-not-real'})
assert.equal(validated.connection_id,'test-opaque-id')
const validationBody = JSON.parse(calls.at(-1)!.options!.body as string)
assert.equal(validationBody.tool,'ynote'); assert.equal(validationBody.capability,'text_ai')
assert.equal(validationBody.api_key,'unit-test-secret-not-real'); assert(!('api_key' in validated))
for (const invalid of [{...connection,valid:false},{...connection,verification:'syntax'},{...connection,connection_id:''},{...connection,model:'wrong-model'},{...connection,expires_at:'2020-01-01T00:00:00Z'}]) {
 responder = path => new Response(JSON.stringify(path.startsWith('/api/quota') ? active : invalid))
 await assert.rejects(validateByok({kind:'text_ai',base_url:'https://api.siliconflow.cn/v1',model:'test-model',api_key:'unit-test-secret-not-real'}))
}
pass('BYOK requires a real-server provider verification contract bound to model and expiry; syntax-only, empty, stale and mismatched results are rejected')

responder = () => new Response(JSON.stringify({note:{},conversation:{},job:{}}))
useQuotaStore.setState({mode:'byok',quota:active,connections:{text_ai:connection}})
await createNote('material',{transcript_version_id:'v1'}); await chat('material',{question:'test'})
for (const call of calls.slice(-2)) { const body=JSON.parse(call.options!.body as string); assert.equal(body.billing_mode,'byok'); assert.equal(body.connection_id,'test-opaque-id'); assert(!('api_key' in body)) }
await assert.rejects(createJobs('material',{operations:['transcript'],idempotency_key:'test'}))
pass('Generation requests send explicit mode + opaque connection, never raw keys; unverified remote transcription is blocked')

useQuotaStore.setState({mode:'platform',quota:unavailableQuota('preview'),connections:{}})
const html = renderToStaticMarkup(<SettingsPage />)
assert(html.includes('免费额度（默认）')); assert(!html.includes('¥10')); assert(html.includes('未启用')); assert(!html.includes('¥10.00'))
assert(!html.includes('id="text_ai-api-key"'))
assert(!html.includes('id="transcription-api-key"'))
assert.equal((html.match(/class="first-use-button"/g) ?? []).length,1)
assert(html.includes('一键配置全部服务'))
assert(html.indexOf('class="first-use-button"')<html.indexOf('<details'))
assert(html.indexOf('连接本地助手')>html.indexOf('<details'))
for (const removed of ['WORKSPACE / CONNECTIONS','提取与笔记设置','无法读取当前配置：','密钥安全','每位登录用户 · Ynote 独立额度','每日北京时间 00:00 重置（Asia/Shanghai）','适用于平台文本 AI','不代表已经发放','平台文本模型由服务端统一管理','当日免费额度不足时，弹窗提供客服二维码']) assert(!html.includes(removed))
assert(html.includes('还剩 —')); assert(!html.includes('处理中预留')); assert(html.includes('刷新状态'));
assert(html.includes('Windows')); assert(html.includes('macOS')); assert(html.includes('尚未提供'))
assert(html.includes('共享免费额度尚未启用，如需帮助，请<button'))
assert.match(html, /type="button" aria-haspopup="dialog">联系客服<\/button>。/)
assert(!fs.readFileSync('src/pages/TaskWorkbench.tsx','utf8').includes('YNOTE WORKSPACE'))
if (fs.existsSync('public/preview-guard.js')) {
 const guard = fs.readFileSync('public/preview-guard.js','utf8')
 assert(guard.includes('Promise.reject')); assert(guard.includes('__YNOTE_PREVIEW__')); assert(!guard.includes('createElement'))
} else assert(!fs.readFileSync('index.html','utf8').includes('preview-guard.js'))
assert.equal(fs.readFileSync('public/quota-contact-qr.jpg').length, fs.statSync('public/quota-contact-qr.jpg').size)
pass('Settings has one main setup entry, keeps manual controls under advanced settings, and exposes no personal key fields in default platform mode')
useQuotaStore.setState({mode:'platform',quota:active,connections:{},exhausted:true})
responder = () => new Response(JSON.stringify(active))
await useQuotaStore.getState().refresh()
assert.equal(useQuotaStore.getState().exhausted,false)
const dynamicHtml=renderToStaticMarkup(<MemoryRouter><QuotaSummaryView mode="platform" quota={active} /></MemoryRouter>)
assert(dynamicHtml.includes('还剩 88%')); assert(dynamicHtml.includes('服务端预算已就绪')); assert(!dynamicHtml.includes('¥'))
const paused={...active,daily_limit_fen:0,remaining_fen:0,platform_available:false,budget_state:'paused' as const,platform_message:'平台免费调用已由管理员暂停'}
assert.equal(parseQuota(paused).daily_limit_fen,0)
assert.equal(parseQuota({...paused,platform_available:true}).status,'unavailable')
useQuotaStore.setState({quota:paused})
assert.throws(()=>billingContext('text_ai'))
const pausedHtml=renderToStaticMarkup(<MemoryRouter><QuotaSummaryView mode="platform" quota={paused} /></MemoryRouter>)
assert(pausedHtml.includes('还剩 0%'));assert(pausedHtml.includes('平台免费调用已由管理员暂停')); assert(!pausedHtml.includes('¥'))
const precise={...active,daily_limit_fen:1,used_fen:0,reserved_fen:0,remaining_fen:0,daily_limit_nano_cny:'10000000',used_nano_cny:'1',reserved_nano_cny:'0',remaining_nano_cny:'9999999'}
assert.equal(parseQuota(precise).daily_limit_fen,1)
assert.equal(parseQuota({...precise,remaining_nano_cny:'10000000'}).status,'unavailable')
assert.equal(parseQuota({...active,daily_limit_fen:100,remaining_fen:0,budget_state:'exhausted',platform_available:false}).used_fen,120)
useQuotaStore.setState({mode:'byok',quota:paused,connections:{text_ai:connection}})
assert.equal(billingContext('text_ai').billing_mode,'byok')
pass('Server budgets and messages render dynamically; zero pauses platform only, same-day raises clear stale exhaustion, nano balances remain exact')

const completeTranscript = '第一行完整原文。\n第二行原文。\n第三行原文。\n第四行仍用于复制和导出。\n最后一句原文不能丢失。'
const transcriptMarkup = renderToStaticMarkup(<><TranscriptPreview text={completeTranscript} /><TranscriptPreview text="另一个任务的文案。" /></>)
assert(transcriptMarkup.includes(completeTranscript))
assert.equal((transcriptMarkup.match(/aria-expanded="false"/g) ?? []).length,2)
const transcriptIds = [...transcriptMarkup.matchAll(/id="([^"]+)" class="transcript-preview-content/g)].map(match=>match[1])
assert.equal(new Set(transcriptIds).size,2)
for (const id of transcriptIds) assert(transcriptMarkup.includes(`aria-controls="${id}"`))
assert.equal((transcriptMarkup.match(/展开完整文案/g) ?? []).length,2)
const imageAssets = [
  {id:'cover',kind:'cover',mime:'image/jpeg'},
  {id:'shot-a',kind:'image',mime:'image/png'},
  {id:'video',kind:'video',mime:'video/mp4'},
  {id:'shot-b',kind:'image',mime:'image/webp'},
] as Asset[]
const gallery = renderToStaticMarkup(<ResultImageGallery assets={imageAssets} urlFor={(asset,save)=>`/assets/${asset.id}${save?'?download=1':''}`} />)
assert.equal((gallery.match(/<img /g) ?? []).length,1)
assert(gallery.includes('alt="视频封面"'));assert(gallery.includes('download="视频封面.jpg"'))
assert(!gallery.includes('/assets/video'));assert(!gallery.includes('/assets/shot-a'));assert(!gallery.includes('/assets/shot-b'))
pass('Transcript preview keeps full source text; image content displays only one cover and excludes saved screenshots')

const developmentRelease={platform:'windows',architecture:'x64',version:'dev-test',file_name:'Ynote-helper-dev.zip',bytes:99000000,sha256:'a'.repeat(64),signature:'not_signed',protocol:1,built:true,installed:false,local_pipeline_verified:false,production_https_verified:false,clean_machine_verified:false,published:false,release_authorized:false,download_url:null,development_download_url:'/downloads/Ynote-helper-dev.zip',release_notes:'Unsigned local test fixture'} satisfies CompanionRelease
assert.deepEqual(companionDownload(developmentRelease,'127.0.0.1'),{url:'/downloads/Ynote-helper-dev.zip',development:true})
assert.equal(companionDownload(developmentRelease,'localhost').development,true)
assert.equal(companionDownload(developmentRelease,'production.example').url,null)
for (const development_download_url of ['https://other.test/helper.zip','//other.test/helper.zip','/downloads/../private.zip','/downloads/helper.exe']) {
  assert.equal(companionDownload({...developmentRelease,development_download_url},'localhost').url,null)
}
assert.equal(companionDownload({...developmentRelease,sha256:null},'localhost').url,null)
const signedRelease={...developmentRelease,installed:true,local_pipeline_verified:true,production_https_verified:true,clean_machine_verified:true,published:true,release_authorized:true,signature:'valid',download_url:'https://downloads.example/Ynote.zip'}
assert.deepEqual(companionDownload(signedRelease,'production.example'),{url:'https://downloads.example/Ynote.zip',development:false})
assert.equal(companionDownload({...signedRelease,clean_machine_verified:false},'production.example').url,null)
const testingRelease={...developmentRelease,release_channel:'testing' as const,release_authorized:true,download_url:'/downloads/Ynote-helper-dev.zip'}
assert.deepEqual(companionDownload(testingRelease,'production.example'),{url:'/downloads/Ynote-helper-dev.zip',development:false,testing:true})
assert.equal(companionDownload({...testingRelease,release_authorized:false},'production.example').url,null)
assert.equal(companionDownload({...testingRelease,sha256:null},'production.example').url,null)
for(const download_url of ['https://other.test/helper.zip','//other.test/helper.zip','/downloads/../secret.zip','/downloads/helper.zip?token=anything'])assert.equal(companionDownload({...testingRelease,download_url},'production.example').url,null)
pass('Local preview can download manifest-backed unsigned development ZIPs without relaxing production signature/HTTPS/clean-machine gates or accepting remote/traversal development URLs')
unsubscribe()
console.log(JSON.stringify({passed:checks.length,checks},null,2))

Reflect.deleteProperty(globalThis,'window');Reflect.deleteProperty(globalThis,'localStorage')
