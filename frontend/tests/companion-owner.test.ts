import assert from 'node:assert/strict'
import { companionSnapshot, connectCompanion, disconnectCompanion, ensureCloudRelay, getTaskSourceVersion, routeFetch, setCompanionPolicy, LOCAL_URL } from '../src/api/companion'

const site='https://owner-race.test'
const saved={window:Object.getOwnPropertyDescriptor(globalThis,'window'),navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),location:Object.getOwnPropertyDescriptor(globalThis,'location'),fetch:globalThis.fetch,setTimeout:globalThis.setTimeout,now:Date.now}
let now=Date.now(),pair=0,leaseNumber=0,holdPairDelay=false
Date.now=()=>now
globalThis.setTimeout=((callback:TimerHandler,delay?:number,...args:unknown[])=>saved.setTimeout(callback as (...args:unknown[])=>void,delay===1000?(holdPairDelay?10000:0):delay,...args)) as typeof setTimeout
const ownership:{active:boolean;ready:boolean;version:number}[]=[]
Object.defineProperty(globalThis,'window',{value:{dispatchEvent:(event:Event)=>{if(event.type==='ynote:task-source-changed')ownership.push({active:companionSnapshot().active,ready:companionSnapshot().ready,version:getTaskSourceVersion()});return true}},configurable:true})
Object.defineProperty(globalThis,'location',{value:{origin:site,hostname:'owner-race.test'},configurable:true})
const controllerListeners=new Set<()=>void>()
const worker={register:async()=>({}),ready:Promise.resolve({}),controller:{} as unknown,addEventListener:(kind:string,callback:()=>void)=>{if(kind==='controllerchange')controllerListeners.add(callback)},removeEventListener:(kind:string,callback:()=>void)=>{if(kind==='controllerchange')controllerListeners.delete(callback)}}
Object.defineProperty(globalThis,'navigator',{value:{serviceWorker:worker},configurable:true})

function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
type Gate=ReturnType<typeof deferred<Response>>
let healthGate:Gate|null=null,claimGate:Gate|null=null,leaseGate:Gate|null=null,configureGate:Gate|null=null,managedGate:Gate|null=null,cloudGate:Gate|null=null
let configure401=false,managedFailure=false
const calls:{url:string;init:RequestInit}[]=[]
const health=()=>Response.json({application:'YnoteCompanion',protocol:1,tools_state:'ready',capabilities:['cloud_model_relay']})
const lease=()=>({token:`website-lease-token-${++leaseNumber}`.padEnd(43,'x'),expires_at:now/1000+600,origin:site})
const claimed=()=>({token:`paired-local-token-${++pair}`,expires_at:now/1000+1800})
function count(path:string){return calls.filter(call=>call.url===path).length}
async function until(test:()=>boolean){for(let i=0;i<1000;i++){if(test())return;await new Promise<void>(resolve=>saved.setTimeout(resolve,1))}assert.fail('Mock flow did not reach expected stage')}
globalThis.fetch=async(resource,init={})=>{
  const url=String(resource);calls.push({url,init})
  if(url===LOCAL_URL+'/v1/health'){const gate=healthGate;healthGate=null;return gate?gate.promise:health()}
  if(url===LOCAL_URL+'/v1/pair/start')return Response.json({pairing_id:'pairing-test'})
  if(url===LOCAL_URL+'/v1/pair/claim'){const gate=claimGate;claimGate=null;return gate?gate.promise:Response.json(claimed())}
  if(url==='/api/companion/lease'){const gate=leaseGate;leaseGate=null;return gate?gate.promise:Response.json(lease())}
  if(url===LOCAL_URL+'/v1/cloud/configure'){
    const gate=configureGate;configureGate=null
    if(gate)return gate.promise
    if(configure401){configure401=false;return Response.json({error:{message:'pairing expired'}},{status:401})}
    const body=JSON.parse(init.body as string);return Response.json({configured:true,origin:body.origin,expires_at:body.expires_at})
  }
  if(url===LOCAL_URL+'/v1/session/revoke')return Response.json({revoked:true})
  if(url.startsWith(LOCAL_URL+'/v1/local/api/')){
    const gate=managedGate;managedGate=null
    if(gate)return gate.promise
    if(managedFailure){managedFailure=false;throw new TypeError('Mock helper disconnected')}
    return Response.json({id:'local-task',tasks:[]})
  }
  if(url.startsWith('/api/')){const gate=cloudGate;cloudGate=null;return gate?gate.promise:Response.json({id:'cloud-task'})}
  throw new Error('Unexpected mock destination '+url)
}

try {
  setCompanionPolicy({media:'companion',models:'gateway'})
  const firstLease=deferred<Response>();leaseGate=firstLease
  const firstConnect=connectCompanion()
  await until(()=>count('/api/companion/lease')===1)
  assert.equal(companionSnapshot().active,false)
  assert.equal(ownership.length,0)
  const early=await routeFetch('/api/tasks/old-cloud-id/start',{method:'POST',body:'{}'})
  assert.equal((await early.json()).error.code,'COMPANION_REQUIRED')
  assert.equal(count(LOCAL_URL+'/v1/local/api/tasks/old-cloud-id/start'),0)
  firstLease.resolve(Response.json(lease()));await firstConnect
  assert.equal(companionSnapshot().active,true);assert.equal(companionSnapshot().ready,true)
  assert.equal(ownership.length,1);assert.equal(ownership[0].ready,true)
  console.log('PASS Source ownership activates once after pairing, worker and relay are all ready; old cloud IDs never route during staged connection')

  await disconnectCompanion();setCompanionPolicy(undefined)
  const cloud=deferred<Response>();cloudGate=cloud
  const cloudCreate=routeFetch('/api/tasks',{method:'POST',body:'{}'})
  await until(()=>count('/api/tasks')>0)
  await connectCompanion()
  cloud.resolve(Response.json({id:'old-cloud-draft'}))
  const staleCloud=await cloudCreate
  assert.equal(staleCloud.status,409);assert.equal((await staleCloud.json()).error.code,'TASK_SOURCE_CHANGED')
  setCompanionPolicy({media:'companion',models:'gateway'})
  console.log('PASS In-flight cloud task responses are rejected after helper ownership changes instead of adopting the old cloud ID')

  const old=deferred<Response>();managedGate=old
  const staleRead=routeFetch('/api/tasks/old-helper-task')
  await until(()=>count(LOCAL_URL+'/v1/local/api/tasks/old-helper-task')===1)
  const previousToken=companionSnapshot().token;await connectCompanion()
  const newToken=companionSnapshot().token;const newVersion=getTaskSourceVersion();const eventsAfterReconnect=ownership.length
  assert.notEqual(newToken,previousToken)
  old.resolve(Response.json({error:{code:'PAIRING_REQUIRED'}},{status:401}))
  assert.equal((await (await staleRead).json()).error.code,'TASK_SOURCE_CHANGED')
  assert.equal(companionSnapshot().token,newToken);assert.equal(companionSnapshot().active,true)
  assert.equal(getTaskSourceVersion(),newVersion);assert.equal(ownership.length,eventsAfterReconnect)
  console.log('PASS Late 401 from the previous helper session cannot clear the newly paired owner')

  now+=550000
  const oldLease=deferred<Response>();leaseGate=oldLease
  const leaseCount=count('/api/companion/lease')
  const staleStart=routeFetch('/api/tasks/stale-owner/start',{method:'POST',body:'{}'})
  await until(()=>count('/api/companion/lease')===leaseCount+1)
  await connectCompanion();const afterRenewalReconnect=companionSnapshot().token
  const configureCount=count(LOCAL_URL+'/v1/cloud/configure')
  oldLease.resolve(Response.json(lease()))
  assert.equal((await (await staleStart).json()).error.code,'TASK_SOURCE_CHANGED')
  assert.equal(count(LOCAL_URL+'/v1/local/api/tasks/stale-owner/start'),0)
  assert.equal(count(LOCAL_URL+'/v1/cloud/configure'),configureCount)
  assert.equal(companionSnapshot().token,afterRenewalReconnect);assert.equal(companionSnapshot().relay,true)
  console.log('PASS A write waiting on an old lease never crosses into the new helper session or configures it using stale authorization')

  const oldConfigure=deferred<Response>();configureGate=oldConfigure
  const beforeConfigure=count(LOCAL_URL+'/v1/cloud/configure')
  const staleRenewal=ensureCloudRelay(true).then(()=>null,error=>error as Error)
  await until(()=>count(LOCAL_URL+'/v1/cloud/configure')===beforeConfigure+1)
  await connectCompanion();const safeToken=companionSnapshot().token
  oldConfigure.resolve(Response.json({error:{message:'old request failed'}},{status:503}))
  assert(await staleRenewal instanceof Error)
  assert.equal(companionSnapshot().token,safeToken);assert.equal(companionSnapshot().ready,true)
  console.log('PASS Late renewal failures do not overwrite the replacement owner relay or ready state')

  configure401=true
  const beforeExpired=ownership.length
  await assert.rejects(ensureCloudRelay(true),/来源已改变/)
  assert.equal(companionSnapshot().active,false);assert.equal(ownership.length,beforeExpired+1)
  const afterAuthFailure=await routeFetch('/api/tasks/from-expired-owner')
  assert.equal((await afterAuthFailure.json()).error.code,'COMPANION_REQUIRED')
  assert.equal(count('/api/tasks/from-expired-owner'),0)
  await connectCompanion();managedFailure=true
  const lost=await routeFetch('/api/tasks/lost-helper')
  assert.equal((await lost.json()).error.code,'TASK_SOURCE_CHANGED')
  assert.equal(companionSnapshot().active,false)
  console.log('PASS Current-session authorization and transport loss invalidate ownership and cannot fall back to cloud task routes')

  await connectCompanion();const expiry=companionSnapshot().expires;const beforeExpiry=ownership.length
  now=expiry*1000+1
  const expired=await routeFetch('/api/tasks/expired-id')
  assert.equal((await expired.json()).error.code,'COMPANION_REQUIRED')
  assert.equal(ownership.length,beforeExpiry+1);assert.equal(count(LOCAL_URL+'/v1/local/api/tasks/expired-id'),0)
  console.log('PASS Local pairing expiry clears task ownership before a managed request can use an expired token')

  const cancelConnection=async(stage:'health'|'delay'|'claim'|'worker'|'lease'|'configure')=>{
    const abort=new AbortController();const gate=deferred<Response>();const before=ownership.length
    const pairClaims=count(LOCAL_URL+'/v1/pair/claim');const pairedStarts=count(LOCAL_URL+'/v1/pair/start')
    const leases=count('/api/companion/lease');const configurations=count(LOCAL_URL+'/v1/cloud/configure')
    if(stage==='health')healthGate=gate
    if(stage==='claim')claimGate=gate
    if(stage==='worker')worker.controller=null
    if(stage==='lease')leaseGate=gate
    if(stage==='configure')configureGate=gate
    holdPairDelay=stage==='delay'
    const result=connectCompanion(abort.signal).then(()=>null,error=>error as Error)
    if(stage==='health')await until(()=>healthGate===null)
    if(stage==='delay')await until(()=>count(LOCAL_URL+'/v1/pair/start')>pairedStarts && companionSnapshot().state.includes('允许配对'))
    if(stage==='claim')await until(()=>count(LOCAL_URL+'/v1/pair/claim')>pairClaims)
    if(stage==='worker')await until(()=>controllerListeners.size>0)
    if(stage==='lease')await until(()=>count('/api/companion/lease')>leases)
    if(stage==='configure')await until(()=>count(LOCAL_URL+'/v1/cloud/configure')>configurations)
    const last=calls.at(-1)!
    abort.abort()
    const error=await result;assert(error instanceof Error);assert.equal(error.name,'AbortError')
    assert.equal(companionSnapshot().active,false);assert.equal(ownership.length,before)
    if(['health','claim','lease','configure'].includes(stage))assert.equal(last.init.signal?.aborted,true)
    if(stage==='delay')assert.equal(count(LOCAL_URL+'/v1/pair/claim'),pairClaims)
    if(stage==='worker')assert.equal(controllerListeners.size,0)
    gate.resolve(stage==='health'?health():stage==='claim'?Response.json(claimed()):stage==='lease'?Response.json(lease()):Response.json({configured:true,origin:site,expires_at:now/1000+600}))
    await new Promise<void>(resolve=>saved.setTimeout(resolve,1))
    assert.equal(companionSnapshot().active,false);assert.equal(ownership.length,before)
    worker.controller={};holdPairDelay=false
  }
  for(const stage of ['health','delay','claim','worker','lease','configure'] as const)await cancelConnection(stage)
  const alreadyAborted=new AbortController();alreadyAborted.abort();const beforeCalls=calls.length
  await assert.rejects(connectCompanion(alreadyAborted.signal),error=>(error as Error).name==='AbortError')
  assert.equal(calls.length,beforeCalls)
  console.log('PASS Abort signals stop health, polling delay, claim, worker wait, lease and configure; cancelled connections never change task ownership')
} finally {
  await disconnectCompanion()
  Date.now=saved.now;globalThis.fetch=saved.fetch;globalThis.setTimeout=saved.setTimeout
  for(const key of ['window','navigator','location'] as const){const descriptor=saved[key];if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key)}
}
