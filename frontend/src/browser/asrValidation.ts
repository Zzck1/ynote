export function validateAsrText(text: string, start: number, end: number | null) {
  if (end === null || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('模型返回不完整时间戳，本次结果未保存，请缩短文件或检查噪声')
  if (text.includes('\uFFFD') || /(.{1,12})\1{5,}/u.test(text.replace(/\s/g,''))) throw new Error('识别结果疑似噪声幻觉或异常重复，未保存为可信转写；请检查原音频')
}
