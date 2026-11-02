export type Resource={url:string;cache:string;bytes:number;sha256?:string|null;gitBlob?:string}
/** One streaming downloader shared by the existing model cache and unified setup. */
export async function downloadResource(f:Resource,signal:AbortSignal,onProgress:(count:number)=>void){
 const integrity=f.sha256?'sha256-'+btoa(f.sha256.match(/../g)!.map(v=>String.fromCharCode(parseInt(v,16))).join('')):undefined
 const response=await fetch(f.url,{method:'GET',credentials:'omit',cache:'no-store',integrity,signal,headers:{'X-Ynote-Prepare':'1'}})
 if(!response.ok||!response.body)throw new Error(`资源下载失败（${response.status}），未改用云端`)
 const reader=response.body.getReader();let bytes=0,lastUpdate=0
 const body=new ReadableStream({async pull(controller){const r=await reader.read();if(r.done){if(bytes!==f.bytes){controller.error(new Error('资源长度不符'));return}onProgress(bytes);controller.close();return}bytes+=r.value.byteLength;const now=performance.now();if(now-lastUpdate>100||bytes===f.bytes){onProgress(bytes);lastUpdate=now}controller.enqueue(r.value)},cancel:()=>reader.cancel()})
 const cache=await caches.open(f.cache)
 try{await cache.put(f.url,new Response(body,{headers:{'content-type':f.url.endsWith('.mjs')?'text/javascript':f.url.endsWith('.wasm')?'application/wasm':'application/octet-stream','x-ynote-bytes':String(f.bytes)}}))}catch(error){await cache.delete(f.url);throw error}
}
