import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const output = new URL('./.quota.test.mjs',import.meta.url)
const browserOutput = new URL('./.browser.test.mjs',import.meta.url)
const companionOutput = new URL('./.companion.test.mjs',import.meta.url)
const setupOutput = new URL('./.setup.test.mjs',import.meta.url)
const taskOwnerOutput = new URL('./.task-owner.test.mjs',import.meta.url)
const companionOwnerOutput = new URL('./.companion-owner.test.mjs',import.meta.url)
try {
  await build({entryPoints:['tests/quota.test.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outfile:fileURLToPath(output),loader:{'.css':'empty'},define:{'import.meta.env.VITE_USE_MOCK':'"false"','import.meta.env.BASE_URL':'"/"'}})
  await import(output.href)
  await build({entryPoints:['tests/setup.test.tsx'],bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outfile:fileURLToPath(setupOutput),loader:{'.css':'empty'},define:{'import.meta.env.VITE_USE_MOCK':'"false"','import.meta.env.BASE_URL':'"/"'}})
  await import(setupOutput.href)
  await build({entryPoints:['tests/companion.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:fileURLToPath(companionOutput),define:{'import.meta.env.VITE_USE_MOCK':'"false"','import.meta.env.BASE_URL':'"/"'}})
  await import(companionOutput.href)
  await build({entryPoints:['tests/companion-owner.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:fileURLToPath(companionOwnerOutput),define:{'import.meta.env.VITE_USE_MOCK':'"false"','import.meta.env.BASE_URL':'"/"'}})
  await import(companionOwnerOutput.href)
  await build({entryPoints:['tests/task-owner.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:fileURLToPath(taskOwnerOutput),define:{'import.meta.env.VITE_USE_MOCK':'"false"','import.meta.env.BASE_URL':'"/"'}})
  await import(taskOwnerOutput.href)
  await build({entryPoints:['tests/browser.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:fileURLToPath(browserOutput)})
  await import(browserOutput.href)
} finally { await rm(output,{force:true}); await rm(setupOutput,{force:true}); await rm(companionOutput,{force:true}); await rm(companionOwnerOutput,{force:true}); await rm(taskOwnerOutput,{force:true}); await rm(browserOutput,{force:true}) }
