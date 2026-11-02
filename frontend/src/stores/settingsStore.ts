/** Provider secrets belong to the backend. This store contains masked display values only. */
import { create } from 'zustand'
import { getProviders, saveProviders } from '../api/settings'

export interface TextAiConfig { base_url: string; api_key: string; api_key_masked?: string; model: string }
export interface TranscriptionConfig extends TextAiConfig { engine: 'local' | 'remote' }
interface SettingsState {
  text_ai: TextAiConfig | null
  transcription: TranscriptionConfig | null
  loadError: string | null
  hydrate: () => Promise<void>
  saveTextAi: (config: TextAiConfig) => Promise<void>
  saveTranscription: (config: TranscriptionConfig) => Promise<void>
  clear: () => void
}

// One-time cleanup of legacy versions that wrote plaintext credentials to localStorage.
// Preserve demo content while dropping credentials; never import old keys into the backend.
try {
  localStorage.removeItem('edaynote.settings.v1')
  const legacy = localStorage.getItem('edaynote.mockdb.v1')
  if (legacy) {
    try {
      const snapshot = JSON.parse(legacy)
      snapshot.settings = { text_ai: null, transcription: null }
      localStorage.setItem('edaynote.mockdb.v1', JSON.stringify(snapshot))
    } catch {
      localStorage.removeItem('edaynote.mockdb.v1')
    }
  }
} catch { /* Storage can be disabled; it is never required for provider configuration. */ }

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  text_ai: null,
  transcription: null,
  loadError: null,
  hydrate: async () => {
    try {
      const providers = await getProviders()
      set({
        text_ai: { ...providers.text_ai, api_key: '' },
        transcription: { ...providers.transcription, api_key: '' },
        loadError: null,
      })
    } catch (error) {
      set({ loadError: error instanceof Error ? error.message : '无法读取服务配置' })
    }
  },
  saveTextAi: async (config) => {
    await saveProviders({ text_ai: config })
    await get().hydrate()
  },
  saveTranscription: async (config) => {
    await saveProviders({ transcription: config })
    await get().hydrate()
  },
  clear: () => set({ text_ai: null, transcription: null }),
}))

export function isTextAiConfigured(cfg: TextAiConfig | null): boolean {
  return !!cfg && !!cfg.base_url.trim() && !!(cfg.api_key_masked ?? cfg.api_key).trim() && !!cfg.model.trim()
}
