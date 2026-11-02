import assert from 'node:assert/strict'
import { startTaskInCurrentSource } from '../src/api/tasks'
import { ApiRequestError } from '../src/api/errors'
import { setCompanionPolicy } from '../src/api/companion'
import { useQuotaStore } from '../src/stores/quotaStore'
import { unavailableQuota } from '../src/api/quotaTypes'

const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window')
const originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location')
const originalFetch=globalThis.fetch
Object.defineProperty(globalThis,'location',{value:{origin:'http://127.0.0.1:8792',hostname:'127.0.0.1'},configurable:true})
Object.defineProperty(globalThis,'window',{value:{dispatchEvent:()=>true},configurable:true})
setCompanionPolicy(undefined)
useQuotaStore.setState({mode:'platform',quota:unavailableQuota(),connections:{}})

const calls:{path:string;method:string;body:any}[]=[]
let scenario='missing'
globalThis.fetch=async(resource,init={})=>{
  const path=String(resource),method=init.method||'GET',body=typeof init.body==='string'?JSON.parse(init.body):undefined
  calls.push({path,method,body})
  if(method==='GET') {
    if(scenario==='missing')return Response.json({error:{code:'TASK_NOT_FOUND',message:'任务不存在',retryable:false}},{status:404})
    if(scenario==='legacy')return Response.json({error:{code:'INVALID_INPUT',message:'任务不存在',retryable:false}},{status:404})
    if(scenario==='network')return Response.json({error:{code:'PROVIDER_UNAVAILABLE',message:'连接暂不可用',retryable:false}},{status:503})
    if(scenario==='owner')return Response.json({error:{code:'TASK_SOURCE_CHANGED',message:'来源已切换',retryable:true}},{status:409})
    return Response.json({id:'existing-local'})
  }
  if(path==='/api/tasks')return Response.json({id:'new-local',state:'draft'})
  return Response.json({id:path.split('/')[3],state:'queued'})
}
const input={raw_input:'https://www.bilibili.com/video/public-example',source_id:null,extraction_mode:'quick' as const}
for(const kind of ['missing','legacy']) {
  scenario=kind;calls.length=0;let adopted=''
  const task=await startTaskInCurrentSource<{id:string}>('old-cloud-id',input,draft=>{adopted=draft.id})
  assert.equal(task.id,'new-local');assert.equal(adopted,'new-local')
  assert.deepEqual(calls.map(call=>[call.method,call.path]),[['GET','/api/tasks/old-cloud-id'],['POST','/api/tasks'],['POST','/api/tasks/new-local/start']])
  assert.equal(calls[1].body.raw_input,input.raw_input)
  assert.equal(calls[2].body.extraction_mode,'quick');assert.equal(calls[2].body.billing_mode,'platform')
}
console.log('PASS Missing legacy/cloud task IDs are resolved before starting; only a new local draft is started and input is retained')

for(const kind of ['network','owner']) {
  scenario=kind;calls.length=0
  await assert.rejects(()=>startTaskInCurrentSource('old-id',input),(error:unknown)=>error instanceof ApiRequestError && (error.status===503||error.code==='TASK_SOURCE_CHANGED'))
  assert.equal(calls.length,1)
}
scenario='existing';calls.length=0
await startTaskInCurrentSource('existing-local',{...input,extraction_mode:'precise'})
assert.deepEqual(calls.map(call=>call.path),['/api/tasks/existing-local','/api/tasks/existing-local/start'])
assert.equal(calls[1].body.extraction_mode,'precise')
console.log('PASS Network/source changes never recreate or replay tasks; valid current-owner tasks retain their selected extraction mode')
if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow)
else Reflect.deleteProperty(globalThis,'window')
if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation)
else Reflect.deleteProperty(globalThis,'location')
globalThis.fetch=originalFetch
