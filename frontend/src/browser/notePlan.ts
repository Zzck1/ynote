/** The small model chooses source IDs; it never supplies facts or timestamps to the renderer. */
export function parseSelection(output: string, count: number): number[] {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')
  let data: unknown
  try { data = JSON.parse(trimmed) } catch { throw new Error('本地文本模型未返回可校验的要点编号，本次笔记未生成；没有使用模拟或云端结果') }
  if (!Array.isArray(data) || data.length === 0 || data.length > count || !data.every(n => Number.isInteger(n) && n >= 1 && n <= count)) throw new Error('本地模型引用了不存在的原文段落，本次笔记未生成')
  return [...new Set(data as number[])].sort((a,b) => a-b)
}

/** Fail closed until the candidate model can justify omissions. This is a coverage
 * safety gate, not a claim that selecting every line produces a useful summary. */
export function requireFullSourceCoverage(selected: number[][], counts: number[]) {
  if (selected.length !== counts.length) throw new Error('摘录失败：模型返回的原文分组不完整；转写仍可查看和导出')
  const missing = counts.flatMap((count, group) => Array.from({length: count}, (_, i) => i + 1)
    .filter(id => !selected[group].includes(id)).map(id => `${group + 1}:${id}`))
  if (missing.length) throw new Error(`摘录失败：模型未选 ${missing.length} 个原文片段（组:编号 ${missing.join('、')}），目前无法可靠确认这些省略不会丢失任务、条件或结论。本次不保存摘录或生成导图；请查看及导出原文。未入选核对区不代表质量通过`)
}

/** Structural prerequisites only. Passing does not prove ASR word accuracy. */
export function requireAuditableSource(segments: Array<{start_ms:number|null;end_ms:number|null;text:string;source_chunk:string|null}>, duration:number|null) {
  let previousEnd=-1, previousText='', repeated=0
  for (const [index,s] of segments.entries()) {
    const fail=(reason:string):never=>{throw new Error(`摘录失败：原文第${index+1}段${reason}；原始转写已保留，请核对或重新转写，不能据此生成摘录和导图`)}
    if(s.start_ms===null||s.end_ms===null||!Number.isFinite(s.start_ms)||!Number.isFinite(s.end_ms)||s.start_ms<0||s.end_ms<=s.start_ms)fail('时间戳无效')
    const start=s.start_ms as number,end=s.end_ms as number
    if(start<previousEnd)fail('与前段时间重叠')
    if(duration!==null&&end>duration*1000+20)fail('时间超过音轨范围')
    let c:{offset_samples:number;samples:number;sample_rate:number;raw_timestamp:[number,number]}
    try{c=JSON.parse(s.source_chunk??'null')}catch{fail('缺少有效的分块来源')}
    if(!c!||!Number.isInteger(c.offset_samples)||c.offset_samples<0||!Number.isInteger(c.samples)||c.samples<=0||c.sample_rate!==16000||!Array.isArray(c.raw_timestamp)||c.raw_timestamp.length!==2||!c.raw_timestamp.every(Number.isFinite))fail('缺少有效的分块来源，需要重新转写')
    if(c!.raw_timestamp[0]<0||c!.raw_timestamp[1]*1000>c!.samples/16+20)fail('模型时间超出实际输入块范围')
    if(Math.abs(start-(c!.offset_samples/16+c!.raw_timestamp[0]*1000))>1||Math.abs(end-(c!.offset_samples/16+c!.raw_timestamp[1]*1000))>1)fail('时间与原始模型来源不一致')
    const text=s.text.replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase()
    repeated=text===previousText?repeated+1:1
    if(text&&repeated>=3)fail('连续重复，无法确认是真实复述还是识别幻觉')
    previousText=text;previousEnd=end
  }
}
