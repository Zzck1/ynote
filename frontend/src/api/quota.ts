import { request } from './client'
import { setCompanionPolicy } from './companion'
import { USE_MOCK, ApiRequestError } from './errors'
import { isHostedPreview } from './quotaSignals'
import { parseQuota, unavailableQuota, byokProviderForUrl, type QuotaSnapshot, type ByokConnection } from './quotaTypes'
export async function getQuota(): Promise<QuotaSnapshot> {
  if (isHostedPreview() || USE_MOCK) return unavailableQuota('preview')
  try { const quota = parseQuota(await request('GET', '/api/quota?tool=ynote'));if(quota.status==='active')setCompanionPolicy(quota.processing);return quota }
  catch (error) { return error instanceof ApiRequestError && error.code === 'LOGIN_REQUIRED' ? { ...unavailableQuota(), status: 'login_required' } : unavailableQuota() }
}
export async function validateByok(input: { kind: 'text_ai' | 'transcription'; base_url: string; model: string; api_key: string }): Promise<ByokConnection> {
  if (isHostedPreview() || USE_MOCK) throw new Error('界面预览不接收、保存或验证 API Key。')
  if (!input.api_key.trim() || /[*•＊]/.test(input.api_key) || !input.model.trim()) throw new Error('请填写有效的个人密钥与模型名称，不能使用显示掩码。')
  const quota = await getQuota()
  if (quota.status !== 'active') throw new Error('安全验证服务尚未启用，不能提交 API Key。')
  const expectedProvider = byokProviderForUrl(input.base_url)
  const { kind, ...credentials } = input
  const result = await request<Omit<ByokConnection, 'kind'>>('POST', '/api/byok/validate', { tool: 'ynote', ...credentials, capability: kind })
  if (result.valid !== true || result.verification !== 'provider' || result.provider !== expectedProvider || result.model !== input.model || typeof result.connection_id !== 'string' || !result.connection_id || result.connection_id.length > 512 || result.connection_id.includes(input.api_key) || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) throw new Error('服务端未返回有效的密钥验证凭据，配置未启用。')
  return { connection_id: result.connection_id, kind, valid: true, expires_at: result.expires_at, provider: result.provider, model: result.model, verification: 'provider' }
}
