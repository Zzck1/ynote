import { create } from 'zustand'
import { getQuota } from '../api/quota'
import { isHostedPreview } from '../api/quotaSignals'
import { USE_MOCK } from '../api/errors'
import { unavailableQuota, type BillingMode, type ByokConnection, type QuotaSnapshot } from '../api/quotaTypes'
interface QuotaState {
  mode: BillingMode
  quota: QuotaSnapshot
  loading: boolean
  exhausted: boolean
  markExhausted: () => void
  connections: Partial<Record<'text_ai' | 'transcription', ByokConnection>>
  refresh: () => Promise<void>
  setMode: (mode: BillingMode) => void
  setConnection: (connection: ByokConnection) => void
  invalidateConnection: (kind: 'text_ai' | 'transcription') => void
}
let latestRefresh = 0
export const useQuotaStore = create<QuotaState>()((set) => ({
  mode: 'platform', quota: unavailableQuota(isHostedPreview() || USE_MOCK ? 'preview' : 'unavailable'), loading: false, exhausted: false, connections: {},
  refresh: async () => {
    const id = ++latestRefresh
    set({ loading: true })
    const quota = await getQuota()
    if (id === latestRefresh) set(state => ({ quota, loading: false, exhausted: state.exhausted && !(quota.status === 'active' && quota.platform_available), ...(quota.status !== 'active' ? { connections: {} } : { connections: state.connections }) }))
  },
  markExhausted: () => set({ exhausted: true }),
  setMode: mode => set({ mode }),
  setConnection: connection => set(state => ({ connections: { ...state.connections, [connection.kind]: connection } })),
  invalidateConnection: kind => set(state => ({ connections: { ...state.connections, [kind]: undefined } })),
}))
/** No secrets and no implicit platform fallback. Backend must authenticate, reserve and enforce again. */
export function billingContext(kind?: 'text_ai' | 'transcription') {
  const { mode, quota, connections } = useQuotaStore.getState()
  if (mode === 'byok') {
    const connection = kind ? connections[kind] : undefined
    if (kind && (!connection || Date.parse(connection.expires_at) <= Date.now())) throw new Error('请先在设置中验证有效的个人 API Key；不会自动改用免费额度。')
    return { tool: 'ynote' as const, billing_mode: 'byok' as const, ...(connection ? { connection_id: connection.connection_id } : { connections: Object.fromEntries(Object.entries(connections).filter(([, value]) => value && Date.parse(value.expires_at) > Date.now()).map(([key, value]) => [key, value!.connection_id])) }) }
  }
  if (kind === 'transcription' && !quota.capabilities?.transcription?.available) throw new Error('平台转写尚未启用，请等待管理员配置后端统一 Key，或使用已验证的个人转写密钥。')
  if (kind === 'text_ai' && quota.capabilities && !quota.capabilities.text_ai?.available) throw new Error('平台文本模型尚未启用，请等待管理员完成配置。')
  if (kind && (quota.status !== 'active' || !quota.platform_available)) throw new Error(quota.status === 'login_required' ? '请登录后使用平台免费额度。' : '平台免费额度尚未启用，请等待后端配置完成。')
  return { tool: 'ynote' as const, billing_mode: 'platform' as const }
}
export function isManagedAiReady(kind: 'text_ai' | 'transcription' = 'text_ai') {
  const { mode, quota, connections } = useQuotaStore.getState()
  return mode === 'platform' ? quota.status === 'active' && quota.platform_available && (quota.capabilities ? !!quota.capabilities[kind]?.available : kind === 'text_ai') : !!connections[kind] && Date.parse(connections[kind]!.expires_at) > Date.now()
}
