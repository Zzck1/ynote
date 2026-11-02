// Parameter experiment only. Native CPU results are never labelled browser results.
import {build} from 'esbuild'
import {readFile,writeFile,rm} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {env,pipeline} from '@huggingface/transformers'
await build({entryPoints:['../validation/experiments/asrCore-v2-not-enabled.ts'],bundle:true,format:'esm',platform:'node',packages:'external',outfile:'validation-asr-v2.mjs'})
try {
 const {recognizeLocal}=await import(pathToFileURL(resolve('validation-asr-v2.mjs')).href)
 env.allowRemoteModels=false;env.useFSCache=false
 globalThis.fetch=async()=>{throw new Error('Network disabled in native test')}
 const m=JSON.parse(await readFile('src/browser/models.json','utf8')).find(m=>m.kind==='asr')
 const asr=await pipeline('automatic-speech-recognition',resolve('public/models',m.id,'resolve',m.revision),{device:'cpu',dtype:'q8',local_files_only:true})
 const cases=['fixtures/chinese-short.wav','fixtures/mixed-short.wav','fixtures/chinese-noisy.wav','fixtures/noise-only.wav','fixtures/silence-short.wav','r2/aishell-human-38s.wav']
 const evidence={kind:'native-parameter-comparison-v2-not-browser',results:[]}
 for(const name of cases){
  const buffer=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i',resolve('../validation',name),'-f','f32le','-ac','1','-ar','16000','pipe:1'],{maxBuffer:32*1024*1024})
  const pcm=new Float32Array(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength))
  const start=performance.now()
  try { const result=await recognizeLocal(asr,pcm,()=>{});evidence.results.push({name,seconds:pcm.length/16000,elapsed_s:(performance.now()-start)/1000,result}) }
  catch(error){evidence.results.push({name,error:error.message})}
  await writeFile('../validation/r2/asr-v2-native.json',JSON.stringify(evidence,null,2));console.log('ASR V2 NATIVE',name,evidence.results.at(-1).error??evidence.results.at(-1).result.segments.map(x=>x.text).join(''))
 }
 await asr.dispose()
}finally{await rm('validation-asr-v2.mjs',{force:true})}
