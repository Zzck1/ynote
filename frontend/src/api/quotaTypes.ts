/** Shared v1 contract. Money and identity are owned exclusively by the server. */
export type BillingMode = 'platform' | 'byok'
export type QuotaStatus = 'active' | 'login_required' | 'unavailable' | 'preview'
export interface QuotaSnapshot {
  tool: 'ynote'
  status: QuotaStatus
  billing_mode: BillingMode
  currency: 'CNY'
  timezone: 'Asia/Shanghai'
  daily_limit_fen: number | null
  quota_scope: 'site_shared'
  used_fen: number | null
  reserved_fen: number | null
  remaining_fen: number | null
  resets_at: string | null
  platform_available: boolean
  capabilities?: Partial<Record<'text_ai' | 'transcription', { available: boolean; model: string }>>
  processing?: {media:'companion';models:'gateway'}
  budget_state: 'available' | 'paused' | 'exhausted' | 'review' | 'unavailable'
  platform_message: string
  daily_limit_nano_cny?: string
  used_nano_cny?: string
  reserved_nano_cny?: string
  remaining_nano_cny?: string
}
export type ByokProvider = 'siliconflow' | 'deepseek' | 'kimi' | 'openai' | 'zhipu' | 'qwen' | 'vectide' | 'openai-compatible'
export function byokProviderForUrl(baseUrl: string): ByokProvider {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请使用不含账号密码的 HTTPS 服务地址。')
  const hosts: Record<string, ByokProvider> = {
    'api.siliconflow.cn': 'siliconflow', 'api.deepseek.com': 'deepseek', 'api.moonshot.cn': 'kimi',
    'api.openai.com': 'openai', 'open.bigmodel.cn': 'zhipu', 'dashscope.aliyuncs.com': 'qwen', 'vectide.cn': 'vectide',
  }
  return hosts[url.hostname] || 'openai-compatible'
}
export interface ByokConnection {
  connection_id: string
  kind: 'text_ai' | 'transcription'
  valid: true
  expires_at: string
  provider: ByokProvider
  model: string
  verification: 'provider'
}
export const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
export function unavailableQuota(status: 'unavailable' | 'preview' = 'unavailable'): QuotaSnapshot {
  return { tool: 'ynote', status, billing_mode: 'platform', currency: 'CNY', timezone: 'Asia/Shanghai', daily_limit_fen: null, budget_state: 'unavailable', platform_message: '后端未配置 · 额度未启用', quota_scope: 'site_shared', used_fen: null, reserved_fen: null, remaining_fen: null, resets_at: null, platform_available: false }
}
export function parseQuota(data: unknown): QuotaSnapshot {
  if (!data || typeof data !== 'object') return unavailableQuota()
  const q = data as QuotaSnapshot
  if (q.tool !== 'ynote' || q.quota_scope !== 'site_shared' || !['active', 'login_required', 'unavailable', 'preview'].includes(q.status) || !['platform', 'byok'].includes(q.billing_mode) || q.currency !== 'CNY' || q.timezone !== 'Asia/Shanghai' || typeof q.platform_available !== 'boolean') return unavailableQuota()
  if (q.status !== 'active') return { ...unavailableQuota(q.status === 'preview' ? 'preview' : 'unavailable'), status: q.status, billing_mode: q.billing_mode }
  if (!Number.isSafeInteger(q.daily_limit_fen) || q.daily_limit_fen! < 0) return unavailableQuota()
  const money = [q.used_fen, q.reserved_fen, q.remaining_fen]
  if (!money.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) || (q.remaining_fen ?? 0) > q.daily_limit_fen! || !q.resets_at || !Number.isFinite(Date.parse(q.resets_at))) return unavailableQuota()
  if (!['available','paused','exhausted','review','unavailable'].includes(q.budget_state) || typeof q.platform_message !== 'string' || !q.platform_message.trim() || q.platform_message.length > 240) return unavailableQuota()
  if ((q.daily_limit_fen === 0 && (q.platform_available || q.budget_state !== 'paused')) || (q.budget_state === 'paused' && q.daily_limit_fen !== 0)) return unavailableQuota()
  const nanoKeys = ['daily_limit_nano_cny','used_nano_cny','reserved_nano_cny','remaining_nano_cny'] as const
  if (q.processing !== undefined && (!q.processing || q.processing.media !== 'companion' || q.processing.models !== 'gateway')) return unavailableQuota()
  if (q.capabilities !== undefined) {
    if (!q.capabilities || typeof q.capabilities !== 'object') return unavailableQuota()
    for (const kind of ['text_ai','transcription'] as const) {
      const capability = q.capabilities[kind]
      if (!capability || typeof capability.available !== 'boolean' || typeof capability.model !== 'string' || capability.model.length > 200 || (capability.available && (!q.platform_available || !capability.model.trim()))) return unavailableQuota()
    }
  }
  const hasNano = nanoKeys.some(k => q[k] !== undefined)
  if (hasNano) {
    if (!nanoKeys.every(k => typeof q[k] === 'string' && /^[0-9]{1,30}$/.test(q[k]!))) return unavailableQuota()
    const [limit, used, reserved, remaining] = nanoKeys.map(k => BigInt(q[k]!))
    if (limit !== BigInt(q.daily_limit_fen!) * 10_000_000n || used / 10_000_000n !== BigInt(q.used_fen!) || reserved / 10_000_000n !== BigInt(q.reserved_fen!) || remaining / 10_000_000n !== BigInt(q.remaining_fen!) || remaining !== (limit > used + reserved ? limit - used - reserved : 0n)) return unavailableQuota()
  }
  return { tool: 'ynote', status: 'active', billing_mode: q.billing_mode, currency: 'CNY', timezone: 'Asia/Shanghai', daily_limit_fen: q.daily_limit_fen, budget_state: q.budget_state, platform_message: q.platform_message, quota_scope: 'site_shared', used_fen: q.used_fen, reserved_fen: q.reserved_fen, remaining_fen: q.remaining_fen, resets_at: q.resets_at, platform_available: q.platform_available, ...(q.processing?{processing:{media:'companion' as const,models:'gateway' as const}}:{}), ...(q.capabilities ? {capabilities: Object.fromEntries((['text_ai','transcription'] as const).map(kind => [kind,{available:q.capabilities![kind]!.available,model:q.capabilities![kind]!.model}]))} : {}), ...Object.fromEntries(['daily_limit_nano_cny','used_nano_cny','reserved_nano_cny','remaining_nano_cny'].flatMap(k => { const v=(q as unknown as Record<string,unknown>)[k]; return typeof v === 'string' && /^\d+$/.test(v) && v.length <= 30 ? [[k,v]] : [] })) }
}
