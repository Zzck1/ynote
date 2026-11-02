import { PrivacyDetails } from './PrivacyDetails'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { browserLocal, switchProcessingMode } from './mode'
import { cancelBrowserTasks, browserHistoryInfo, clearBrowserHistory } from './adapter'
import { ModelPreparation, bytesLabel, useModelStates, phaseLabel } from './ModelPreparation'
import { cacheUsage, clearModel, clearRuntime, preparationBusy } from './preparation'
import models from './models.json'
import runtime from './runtime.json'
import './browser.css'
export function BrowserStatus(){
 const [progress,setProgress]=useState('')
 useEffect(()=>{const update=(e:Event)=>setProgress((e as CustomEvent<string>).detail);window.addEventListener('ynote:browser-progress',update);return()=>window.removeEventListener('ynote:browser-progress',update)},[])
 if(!progress)return null
 return <><section className="quota-summary browser-status"><div><strong>浏览器本地计算</strong><span>{progress||'内容在本机处理；模型下载仍会联网。完整隐私抓包验收状态见说明。'}</span></div><Link to="/settings#privacy-local">隐私与本地数据</Link><button className="card-action" onClick={()=>{void cancelBrowserTasks();setProgress('已停止本地计算')}}>停止本地计算</button></section></>
}
export function BrowserSettings(){
 const clearDialog=useRef<HTMLDialogElement>(null),cleaning=useRef(false)
 const [clearRequest,setClearRequest]=useState<{action:()=>Promise<void>;scope:string}|null>(null)
 const states=useModelStates(),[usage,setUsage]=useState<Record<string,number>>({}),[history,setHistory]=useState({tasks:0,materials:0,bytes:0}),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 async function refresh(){const [asr,text,info]=await Promise.all([cacheUsage('asr'),cacheUsage('text'),browserHistoryInfo()]);setUsage({asr,text});setHistory(info)}
 useEffect(()=>{void refresh().catch(e=>setMessage(e.message))},[states.asr.phase,states.text.phase])
 useEffect(()=>{if(location.hash==='#privacy-local')document.getElementById('privacy-local')?.scrollIntoView()},[])
 function clean(action:()=>Promise<void>,scope:string){if(busy||preparationBusy())return;setClearRequest({action,scope});clearDialog.current?.showModal()}
 function dismissClear(){if(cleaning.current)return;clearDialog.current?.close();setClearRequest(null)}
 async function confirmClear(){if(!clearRequest||cleaning.current)return;cleaning.current=true;setBusy(true);try{await clearRequest.action();await refresh();setMessage('已完成所说明范围内的清理；其他数据未删除')}catch(e){setMessage((e as Error).message)}finally{cleaning.current=false;setBusy(false);clearDialog.current?.close();setClearRequest(null)}}
 return <section className="browser-settings"><dialog ref={clearDialog} className="model-prepare-dialog" aria-labelledby="data-clear-title" onCancel={e=>{e.preventDefault();dismissClear()}}><h2 id="data-clear-title">确认清理范围</h2><p>{clearRequest?.scope}</p><div className="preparation-actions"><button className="extract-start" disabled={busy} onClick={()=>void confirmClear()}>确认清理</button><button className="card-action" disabled={busy} onClick={dismissClear}>取消</button></div></dialog><ModelPreparation/>
  <h2>模型与本地数据管理</h2>{models.map(m=><article className="browser-model" key={m.kind}><h3>{m.kind==='asr'?'转写模型':'笔记模型'} · {phaseLabel[states[m.kind as 'asr'|'text'].phase]}</h3><p>{m.id} · 固定版本 <code>{m.revision}</code></p><p>该版本已缓存 {bytesLabel(usage[m.kind]??0)} / {bytesLabel(m.bytes)}。状态：{states[m.kind as 'asr'|'text'].message}</p><button className="card-action" disabled={busy||preparationBusy()} onClick={()=>void clean(()=>clearModel(m.kind as 'asr'|'text'),`只清除${m.kind==='asr'?'转写':'笔记'}模型的所有版本缓存。不会删除另一模型、任务、转写、摘录、电脑原始音视频或已下载文件。清理后此模型需要重新下载并启用，是否继续？`)}>清除{m.kind==='asr'?'转写':'笔记'}模型缓存</button></article>)}
  <p>共享运行资源：ONNX Runtime Web {runtime.version}，固定资源总量 {bytesLabel(runtime.files.reduce((n,f)=>n+f.bytes,0))}。清理共享运行资源会使两种模型都需要重新准备运行环境，但不会删除权重或任务。</p><button className="card-action" disabled={busy||preparationBusy()} onClick={()=>void clean(clearRuntime,'只清除共享推理运行缓存，两种模型都将不再显示就绪；保留模型权重、任务、转写、摘录、电脑原文件和导出文件。是否继续？')}>清除共享运行缓存</button>
  <p>当前浏览器工作台：{history.tasks} 个任务，{history.materials} 份导入文件副本，副本文件合计 {bytesLabel(history.bytes)}。</p><button className="card-action" disabled={busy||preparationBusy()} onClick={()=>void clean(clearBrowserHistory,'永久删除本网站当前浏览器工作台的任务、转写、摘录、失败内容记录，以及存入 IndexedDB 的导入文件副本。不会删除电脑上的原始文件、已下载导出文件、模型缓存、其他站点数据或旧服务器/助手数据。删除后无法从网页恢复。是否继续？')}>删除本地任务与内容记录</button><button className="card-action" onClick={()=>void refresh().catch(e=>setMessage(e.message))}>刷新占用与状态</button><p role="status">{message}</p>
  <PrivacyDetails/><p>B站、抖音、小红书链接解析保持原有限制：本地模式不绕过访问限制、不索取 Cookie、不用服务器中转，请选择合法取得的本地文件。</p>
  <details><summary>旧远程／桌面助手模式（默认关闭）</summary><p>此入口不会自动迁移浏览器资料，发送内容前需另行确认。</p><button className="card-action" onClick={()=>{void cancelBrowserTasks().then(()=>switchProcessingMode(browserLocal()))}}>查看并切换旧模式</button></details>
 </section>
}
