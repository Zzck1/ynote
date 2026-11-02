import assert from 'node:assert/strict'
import { companionSnapshot, connectCompanion, disconnectCompanion, routeFetch, setCompanionPolicy, ensureCloudRelay, LOCAL_URL } from '../src/api/companion'
import { createJobs, importLocalFile } from '../src/api/materials'
import { useQuotaStore } from '../src/stores/quotaStore'
import { unavailableQuota } from '../src/api/quotaTypes'

const site='https://ynote-relay.test'
Object.defineProperty(globalThis,'location',{value:{origin:site,hostname:'ynote-relay.test'},configurable:true})
Object.defineProperty(globalThis,'window',{value:{confirm:()=>true,dispatchEvent:()=>true},configurable:true})
Object.defineProperty(globalThis,'navigator',{value:{serviceWorker:{register:async()=>({}),ready:Promise.resolve({}),controller:{},addEventListener:()=>{}}},configurable:true})
const originalNow=Date.now
let now=originalNow(),leaseCalls=0,configureCalls=0,helperWrites=0,badOrigin=false,oldHelper=false
Date.now=()=>now
const calls:{url:string;init:RequestInit}[]=[]
globalThis.fetch=async(resource,options={})=>{
  const url=String(resource);calls.push({url,init:options})
  if(url===LOCAL_URL+'/v1/health')return Response.json({application:'YnoteCompanion',protocol:1,tools_state:'ready',model_ready:false,capabilities:oldHelper?['medium_cpu']:['cloud_model_relay']})
  if(url===LOCAL_URL+'/v1/pair/start')return Response.json({pairing_id:'pair-id'})
  if(url===LOCAL_URL+'/v1/pair/claim')return Response.json({token:'local-pairing-only-token',expires_at:now/1000+3600})
  if(url==='/api/companion/lease'){
    leaseCalls++
    assert.equal(options.credentials,'same-origin')
    assert.equal(new Headers(options.headers).get('Authorization'),null)
    assert.deepEqual(JSON.parse(options.body as string),{tool:'ynote'})
    return Response.json({token:`temporary-website-lease-token-${leaseCalls}`,expires_at:now/1000+180,origin:badOrigin?'https://wrong-origin.test':site})
  }
  if(url===LOCAL_URL+'/v1/cloud/configure'){
    configureCalls++
    assert.equal(new Headers(options.headers).get('Authorization'),'Bearer local-pairing-only-token')
    const body=JSON.parse(options.body as string)
    assert.deepEqual(Object.keys(body).sort(),['expires_at','origin','token'])
    assert.equal(body.origin,site)
    return Response.json({configured:true,origin:body.origin,expires_at:body.expires_at})
  }
  if(url===LOCAL_URL+'/v1/session/revoke')return Response.json({ok:true})
  if(url.startsWith(LOCAL_URL+'/v1/local/api/')){
    if(options.method==='POST')helperWrites++
    return Response.json({job:{id:'local-job'}})
  }
  throw new Error('Unexpected network destination: '+url)
}

try{
  setCompanionPolicy({media:'companion',models:'gateway'})
  const blocked=await routeFetch('/api/tasks')
  assert.equal(blocked.status,409);assert.equal((await blocked.json()).error.code,'COMPANION_REQUIRED')
  await assert.rejects(importLocalFile(new File(['private local bytes'],'private.mp3')),/本地媒体助手/)
  assert.equal(calls.length,0)
  oldHelper=true
  await assert.rejects(connectCompanion(),/更新 Ynote 媒体助手/)
  assert.equal(calls.filter(call=>call.url===LOCAL_URL+'/v1/pair/start').length,0)
  oldHelper=false
  await connectCompanion()
  assert.equal(companionSnapshot().active,true)
  assert.equal(companionSnapshot().ready,true)
  assert.equal(companionSnapshot().relay,true)
  assert.equal(leaseCalls,1);assert.equal(configureCalls,1)
  assert(!calls.some(call=>call.url.includes('/v1/model')))
  assert(!JSON.stringify(companionSnapshot()).includes('temporary-website-lease-token'))
  console.log('PASS Pairing configures same-origin short-lived model authorization without downloading an ASR model or exposing relay tokens in public state')

  useQuotaStore.setState({mode:'platform',connections:{},quota:{...unavailableQuota(),status:'active',platform_available:true,capabilities:{text_ai:{available:true,model:'text-model'},transcription:{available:true,model:'Qwen/Qwen3-ASR-1.7B'}}}})
  now+=100_000 // The current lease has 80 seconds left: concurrent writes share one renewal.
  await Promise.all([
    createJobs('local-material',{operations:['transcript'],idempotency_key:'one'}),
    routeFetch('/api/tasks/batch',{method:'POST',body:JSON.stringify({tool:'ynote',billing_mode:'platform',entries:[]})}),
  ])
  assert.equal(leaseCalls,2);assert.equal(configureCalls,2);assert.equal(helperWrites,2)
  const jobWrite=calls.find(call=>call.url===LOCAL_URL+'/v1/local/api/materials/local-material/jobs')!
  assert.equal(JSON.parse(jobWrite.init.body as string).billing_mode,'platform')
  assert.equal(new Headers(jobWrite.init.headers).get('Authorization'),'Bearer local-pairing-only-token')
  assert(!calls.some(call=>call.url===site+'/api/materials/local-material/jobs'))
  assert(!calls.some(call=>call.url.includes('siliconflow')))
  console.log('PASS Managed model writes renew expiring leases once and send platform billing context only to the paired local helper')

  badOrigin=true
  await assert.rejects(ensureCloudRelay(true),/授权无效/)
  assert.equal(configureCalls,2)
  assert.equal(companionSnapshot().ready,false)
  await disconnectCompanion()
  assert.equal(companionSnapshot().relay,false)
  const afterDisconnect=await routeFetch('/api/materials/local-material')
  assert.equal(afterDisconnect.status,409)
  assert.equal(calls.filter(call=>call.url=== '/api/materials/local-material').length,0)
  console.log('PASS Origin mismatch and disconnect fail closed; managed reads and private uploads never fall back to the cloud')
}finally{
  Date.now=originalNow
  Reflect.deleteProperty(globalThis,'window')
}
