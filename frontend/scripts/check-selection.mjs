import { env, pipeline } from '@huggingface/transformers'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
env.allowRemoteModels = false; env.useFSCache = false
globalThis.fetch = async () => { throw new Error('Network disabled in native model test') }
const model = JSON.parse(await readFile('src/browser/models.json','utf8')).find(m=>m.kind==='text')
const generator = await pipeline('text-generation',resolve('public/models',model.id,'resolve',model.revision),{device:'cpu',dtype:'q8',local_files_only:true})
const source = '1. 今天我們討論三個任務。\n2. 第一 先完成本地音頻轉寫。\n3. 第二 檢查每一句話的時間出。\n4. 第三 把合對後的內容整理成筆記。\n5. 不要上傳錄音。'
const prompts = [
 {system:'You select lines for extractive summarization. Return ONLY a JSON array of integer line IDs. Never return strings or explanations. Example format: [1,2,3].',user:'Select the important line IDs from this transcript. Include instructions and conclusions. Return integers between 1 and 5.\n'+source},
 {system:'你只返回行号，不返回文字。输出格式必须为 JSON 整数数组，例如 [1,2,3]。',user:'下面有5行原文，请选择要保留的行号，只能使用整数1到5，不能使用字符串。\n'+source},
]
const report=[]
for(const p of prompts){
 const r=await generator([{role:'system',content:p.system},{role:'user',content:p.user}],{max_new_tokens:40,do_sample:false,return_full_text:false,repetition_penalty:1.1})
 report.push({prompt:p,result:r})
}
await generator.dispose();await writeFile('../validation/selection-candidates-native.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
