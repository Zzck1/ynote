/// <reference lib="webworker" />
import { sha256 } from '@noble/hashes/sha256'
import { sha1 } from '@noble/hashes/sha1'
type Item={url:string;cache:string;bytes:number;sha256?:string|null;gitBlob?:string}
const scope=self as unknown as DedicatedWorkerGlobalScope
scope.onmessage=async({data}:{data:{id:string;items:Item[]}})=>{
 const {id,items}=data
 let completed=0
 const total=items.reduce((n,f)=>n+f.bytes,0)
 try {
  for(const f of items){
   const cache=await caches.open(f.cache),response=await cache.match(f.url)
   if(!response?.body)throw new Error('缓存资源缺失，请重新准备')
   const hash=f.sha256?sha256.create():sha1.create()
   if(!f.sha256)hash.update(new TextEncoder().encode(`blob ${f.bytes}\0`))
   const reader=response.body.getReader();let bytes=0,lastUpdate=0
   while(true){const r=await reader.read();if(r.done)break;hash.update(r.value);bytes+=r.value.length;const now=performance.now();if(now-lastUpdate>100||bytes===f.bytes){scope.postMessage({id,type:'progress',completed:completed+bytes,total});lastUpdate=now}}
   const digest=Array.from(hash.digest(),x=>x.toString(16).padStart(2,'0')).join('')
   if(bytes!==f.bytes||digest!==(f.sha256??f.gitBlob)){
    await cache.delete(f.url)
    throw new Error('缓存校验失败，已移除损坏的单个资源。请重试并确认实际新增下载量')
   }
   completed+=bytes
  }
  scope.postMessage({id,type:'verified'})
 }catch(error){scope.postMessage({id,type:'error',message:error instanceof Error?error.message:'缓存校验失败'})}
}
