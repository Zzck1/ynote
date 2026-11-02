import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { runOneClickSetup, waitForSetup, SetupInstallInstructions, type OneClickSetupDependencies } from '../src/components/FirstUseSetup'
import { unavailableQuota } from '../src/api/quotaTypes'
import type { CompanionRelease } from '../src/api/companionRelease'

const origin='https://setup.test'
const health={application:'YnoteCompanion',protocol:1,capabilities:['cloud_model_relay']}
const readyTools={state:'ready',downloaded_bytes:81,total_bytes:81}
const readyPlatform={...unavailableQuota(),status:'active' as const,platform_available:true,capabilities:{text_ai:{available:true,model:'text'},transcription:{available:true,model:'asr'}}}
function fixture(){
  let now=1_000_000,paired=false,ready=0
  const actions:string[]=[]
  const deps:OneClickSetupDependencies={
    health:async()=>{actions.push('health');return health},paired:()=>paired,
    connect:async signal=>{assert(!signal.aborted);actions.push('pair');paired=true},
    tools:async()=>{actions.push('tools');return readyTools},
    prepareTools:async()=>{actions.push('prepare-tools');return readyTools},
    platform:async()=>{actions.push('platform');return readyPlatform},
    configureRelay:async()=>{actions.push('configure-relay')},
    relay:async()=>{actions.push('verify-relay');return {configured:true,origin,expires_at:now/1000+600}},
    ready:()=>{actions.push('ready');ready++},
    wait:async(ms,signal)=>{assert(!signal.aborted);actions.push('wait');now+=ms},now:()=>now,origin,
  }
  return {deps,actions,get ready(){return ready}}
}

{
  const f=fixture(),installs:(string|null)[]=[],progress:string[]=[]
  let checks=0,polls=0
  f.deps.health=async()=>{f.actions.push('health');return ++checks===1?null:checks===2?{...health,capabilities:['medium_cpu']}:health}
  f.deps.tools=async()=>{f.actions.push('tools');return ++polls===1?{state:'not_ready',downloaded_bytes:0,total_bytes:81}:readyTools}
  f.deps.prepareTools=async()=>{f.actions.push('prepare-tools');return {state:'downloading',downloaded_bytes:0,total_bytes:81}}
  await runOneClickSetup(f.deps,new AbortController().signal,value=>progress.push(value.label),reason=>installs.push(reason))
  assert.deepEqual(installs,['missing','outdated',null])
  assert.equal(f.actions.filter(action=>action==='pair').length,1)
  assert(f.actions.indexOf('prepare-tools')>f.actions.indexOf('pair'))
  assert(f.actions.indexOf('verify-relay')>f.actions.indexOf('prepare-tools'))
  assert.equal(f.actions.at(-1),'ready');assert.equal(f.ready,1)
  assert(progress.some(message=>message.includes('启动后自动继续')))
  console.log('PASS One-click setup waits for install/update, then automatically pairs, prepares tools, checks platform and verifies relay before ready')
}
{
  const f=fixture(),controller=new AbortController()
  let checks=0
  f.deps.health=async()=>{checks++;return null}
  f.deps.wait=async(_ms,signal)=>{controller.abort();await waitForSetup(60_000,signal)}
  await assert.rejects(runOneClickSetup(f.deps,controller.signal,()=>{},()=>{}),error=>(error as Error).name==='AbortError')
  assert.equal(checks,1);assert.equal(f.ready,0)
  assert(!f.actions.includes('pair'));assert(!f.actions.includes('configure-relay'))
  const timerController=new AbortController()
  const wait=waitForSetup(60_000,timerController.signal)
  timerController.abort()
  await assert.rejects(wait,error=>(error as Error).name==='AbortError')
  console.log('PASS Cancel stops detection before pairing/model authorization and clears the pending polling timer')
}
{
  const f=fixture();f.deps.paired=()=>true
  let first=true
  f.deps.tools=async()=>{if(first){first=false;throw new Error('expired session')}f.actions.push('tools');return readyTools}
  await runOneClickSetup(f.deps,new AbortController().signal,()=>{},()=>{})
  assert.equal(f.actions.filter(action=>action==='pair').length,1)
  assert(!f.actions.includes('prepare-tools'));assert.equal(f.ready,1)
  const wrong=fixture();wrong.deps.relay=async()=>({configured:true,origin:'https://wrong.test',expires_at:999999})
  await assert.rejects(runOneClickSetup(wrong.deps,new AbortController().signal,()=>{},()=>{}),/授权尚未就绪/)
  assert.equal(wrong.ready,0)
  console.log('PASS Expired pairing is repaired in the same workflow; invalid relay origin never marks setup ready')
}
{
  const release={platform:'windows',architecture:'x64',version:'dev',file_name:'YnoteCompanion-dev.zip',bytes:99000000,sha256:'b'.repeat(64),signature:'not_signed',protocol:1,built:true,installed:false,local_pipeline_verified:false,production_https_verified:false,clean_machine_verified:false,published:false,release_authorized:false,download_url:null,development_download_url:'/downloads/YnoteCompanion-dev.zip',release_notes:'Development test only'} satisfies CompanionRelease
  const markup=renderToStaticMarkup(<SetupInstallInstructions release={release} hostname="127.0.0.1" reason="missing"/>)
  assert(markup.includes('href="/downloads/YnoteCompanion-dev.zip"'))
  assert(markup.includes('全部解压'));assert(markup.includes('Start-YnoteCompanion.cmd'))
  assert(markup.includes('未签名开发测试包'));assert(markup.includes('由你本人允许'))
  const production=renderToStaticMarkup(<SetupInstallInstructions release={release} hostname="site.example" reason="missing"/>)
  assert(!production.includes('href="/downloads/'))
  const testing=renderToStaticMarkup(<SetupInstallInstructions release={{...release,release_channel:'testing',release_authorized:true,download_url:'/downloads/YnoteCompanion-dev.zip'}} hostname="site.example" reason="missing"/>)
  assert(testing.includes('href="/downloads/YnoteCompanion-dev.zip"'))
  assert(testing.includes('未签名测试包'));assert(testing.includes('尚未完成正式发布验收'))
  console.log('PASS The setup dialog itself provides the real manifest download and accurate manual launch/consent steps without enabling development downloads on production hosts')
}
