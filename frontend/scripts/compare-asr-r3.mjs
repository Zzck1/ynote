// Native CPU parameter comparison only; never presented as a browser result.
import {env,pipeline} from '@huggingface/transformers'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
const m=JSON.parse(await readFile('src/browser/models.json','utf8')).find(m=>m.kind==='asr')
env.allowRemoteModels=false;env.useFSCache=false
globalThis.fetch=async()=>{throw new Error('Native comparison: network forbidden')}
const asr=await pipeline('automatic-speech-recognition',resolve('public/models',m.id,'resolve',m.revision),{device:'cpu',dtype:'q8',local_files_only:true})
const evidence={kind:'native-cpu-parameter-comparison-not-browser',model:m.id,revision:m.revision,profiles:[{id:'baseline-zh-25',language:'chinese',seconds:25},{id:'zh-20',language:'chinese',seconds:20},{id:'en-25',language:'english',seconds:25}],results:[]}
for(const name of ['fixtures/chinese-short.wav','fixtures/mixed-short.wav','fixtures/noise-only.wav','r2/aishell-human-38s.wav']){
 const buf=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',resolve('../validation',name),'-f','f32le','-ac','1','-ar','16000','pipe:1'],{maxBuffer:16*1024*1024})
 const pcm=new Float32Array(buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength))
 for(const profile of evidence.profiles){
  const row={name,profile:profile.id,sample_rate:16000,samples:pcm.length,chunks:[]}; const t=performance.now()
  for(let offset=0;offset<pcm.length;offset+=profile.seconds*16000){
   const chunk=pcm.subarray(offset,Math.min(pcm.length,offset+profile.seconds*16000))
   try{const raw=await asr(chunk,{language:profile.language,task:'transcribe',return_timestamps:true,num_beams:1,do_sample:false});row.chunks.push({offset_samples:offset,samples:chunk.length,raw})}
   catch(e){row.error=e.message;break}
  }
  row.elapsed_s=(performance.now()-t)/1000;evidence.results.push(row)
  await writeFile('../validation/r3/native-parameter-comparison.json',JSON.stringify(evidence,null,2));console.log(name,profile.id,row.error??row.chunks.map(c=>c.raw.text).join(' | '))
 }
}
await asr.dispose()
