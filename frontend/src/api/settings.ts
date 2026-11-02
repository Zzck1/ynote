/** 设置相关接口（site-spec §5.3 ⑭⑮⑯） */
import { request } from './client'
import { USE_MOCK } from './errors'
import type {
  ProviderKind,
  ProviderSettings,
  SaveProvidersRequest,
  TestConnectionResult,
} from './types'

// ⑭ GET /api/settings/providers
export function getProviders(): Promise<ProviderSettings> {
  return request<ProviderSettings>('GET', '/api/settings/providers')
}

// ⑮ PUT /api/settings/providers
export function saveProviders(payload: SaveProvidersRequest): Promise<{ saved: true }> {
  // Whitelist only provider input fields. Empty keys mean keep the saved secret;
  // display masks must never become credentials, even if a caller misuses the form.
  const sanitize = (config: NonNullable<SaveProvidersRequest['text_ai']> | NonNullable<SaveProvidersRequest['transcription']>) => ({
    base_url: config.base_url,
    model: config.model,
    ...('engine' in config ? { engine: config.engine } : {}),
    ...(config.api_key?.trim() && !/[＊*•]/.test(config.api_key) ? { api_key: config.api_key.trim() } : {}),
  })
  return request<{ saved: true }>('PUT', '/api/settings/providers', {
    ...(payload.text_ai ? { text_ai: sanitize(payload.text_ai) } : {}),
    ...(payload.transcription ? { transcription: sanitize(payload.transcription) } : {}),
  })
}

// ⑯ POST /api/settings/providers/{kind}/test
// mock 场景下把表单当前值一并传入（真实后端只发无 body 的 POST，测试已保存配置）
export function testConnection(
  kind: ProviderKind,
  formValues?: { base_url?: string; api_key?: string; model?: string; engine?: 'local' | 'remote' },
): Promise<TestConnectionResult> {
  return request<TestConnectionResult>(
    'POST',
    `/api/settings/providers/${kind}/test`,
    USE_MOCK ? formValues : undefined,
  )
}
