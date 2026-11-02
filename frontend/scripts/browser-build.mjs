import { cp, mkdir, readdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const runtime = resolve('public/runtime')
await mkdir(runtime,{recursive:true})
for (const name of ['ort-wasm-simd-threaded.wasm','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.jsep.wasm','ort-wasm-simd-threaded.jsep.mjs']) await cp(resolve('node_modules/onnxruntime-web/dist',name),resolve(runtime,name))
if (process.argv.includes('--after')) {
  const files = ['/index.html']
  let assets
  try { assets = JSON.parse(await readFile('dist/build-assets.json','utf8')) }
  catch { assets = (await readdir('dist/assets')).map(name=>'assets/'+name) }
  for (const name of assets) if (!name.endsWith('.wasm')) files.push('/'+name)
  for (const name of await readdir('dist/fonts')) if (!name.endsWith('.txt')) files.push('/fonts/'+name)
  for (const name of ['ynote-logo.jpg','quota-contact-qr.jpg','yuanshengzhe-contact-qr.jpg']) files.push('/'+name)
  // Runtime is cached only when requested after model consent, not during shell install.
  await writeFile('dist/offline-files.json', JSON.stringify(files,null,2))
  const id = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0,16)
  const worker = await readFile('public/browser-offline.js','utf8')
  await writeFile('dist/browser-offline.js',worker.replace('__YNOTE_BUILD__',id))
}
