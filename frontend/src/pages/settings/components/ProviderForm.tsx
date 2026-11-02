import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { companionSnapshot, subscribeCompanion, disconnectCompanion } from '../../../api/companion'
import { Eye, EyeOff, Info, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '../../../components/Button'
import { validateByok } from '../../../api/quota'
import { SILICONFLOW_BASE_URL } from '../../../api/quotaTypes'
import { useQuotaStore } from '../../../stores/quotaStore'
import { isHostedPreview } from '../../../api/quotaSignals'
import { USE_MOCK } from '../../../api/errors'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useUiStore } from '../../../stores/uiStore'
import type { ProviderKind, TestConnectionResult } from '../../../api/types'
import { LOCAL_TRANSCRIPTION_MODEL } from '../../../utils/transcription'

interface ProviderFormProps {
  kind: 'text_ai' | 'transcription'
  title: string
  description: string
}

interface FormState {
  base_url: string
  api_key: string
  model: string
  engine: 'local' | 'remote'
  remoteModel: string
}

interface FieldErrors {
  base_url?: string
  api_key?: string
  model?: string
}

/** 常用服务商预设：点击填入推荐默认；按套餐选择的服务会清空旧模型。 */
const PROVIDER_PRESETS: { id: string; label: string; base_url: string; model: string }[] = [
  { id: 'siliconflow', label: '硅基流动', base_url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
  { id: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash' },
  { id: 'kimi', label: 'Kimi', base_url: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6' },
  { id: 'openai', label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
  { id: 'zhipu', label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash' },
  { id: 'qwen', label: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.7-plus' },
  { id: 'vectide', label: 'Vectide', base_url: 'https://vectide.cn/v1', model: '' },
]

/** F18/F19：单套服务表单（text_ai / transcription 复用） */
export function ProviderForm({ kind, title, description }: ProviderFormProps) {
  const companion = useSyncExternalStore(subscribeCompanion,companionSnapshot,companionSnapshot)
  const isTranscription = kind === 'transcription'
  const textAi = useSettingsStore((s) => s.text_ai)
  const transcription = useSettingsStore((s) => s.transcription)
  const { mode, quota, connections, setConnection, invalidateConnection } = useQuotaStore()
  const requestVersion = useRef(0)
  const allowSecret = mode === 'byok' && quota.status === 'active' && !isHostedPreview() && !USE_MOCK
  const pushToast = useUiStore((s) => s.pushToast)

  const [form, setForm] = useState<FormState>(() => loadInitial(kind, textAi, transcription))
  const [showKey, setShowKey] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [presetId, setPresetId] = useState<string | null>(null)
  useEffect(() => {
    if (kind==='transcription' && companion.active) setForm(f=>f.engine==='local' ? f : {...f,engine:'local',model:LOCAL_TRANSCRIPTION_MODEL,remoteModel:f.model})
  },[kind,companion.active])

  // 当外部配置变化时重新加载（如从其他页面返回）
  useEffect(() => {
    requestVersion.current++
    setForm(loadInitial(kind, textAi, transcription))
    invalidateConnection(kind)
    setTestResult(null)
  }, [kind, textAi, transcription, invalidateConnection])

  useEffect(() => {
    if (!allowSecret) { requestVersion.current++; setForm(f => ({ ...f, api_key: '' })); setShowKey(false) }
  }, [allowSecret])
  useEffect(() => () => { requestVersion.current++ }, [])

  const isLocal = isTranscription && form.engine === 'local'
  const connection = connections[kind]
  const verified = !!connection && Date.parse(connection.expires_at) > Date.now()

  function resetVerification() {
    requestVersion.current++
    invalidateConnection(kind)
    setTestResult(null)
  }

  function updateField(field: keyof FormState, value: string) {
    resetVerification()
    setForm((f) => ({ ...f, [field]: value }))
    setErrors((e) => ({ ...e, [field]: undefined }))
  }

  function updateEngine(engine: FormState['engine']) {
    if (engine==='remote' && companion.active) void disconnectCompanion().catch(()=>pushToast('danger','助手断开失败，请重试'))
    resetVerification()
    setForm((f) => {
      if (f.engine === engine) return f
      return engine === 'local'
        ? { ...f, engine, model: LOCAL_TRANSCRIPTION_MODEL, remoteModel: f.model }
        : { ...f, engine, model: f.remoteModel }
    })
    setErrors((e) => ({ ...e, model: undefined }))
  }

  /** 点击服务商预设：自动填入 Base URL 与推荐模型 */
  function applyPreset(id: string) {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id)
    if (!preset) return
    resetVerification()
    setPresetId(id)
    setForm((f) => ({
      ...f,
      base_url: preset.base_url,
      model: preset.model,
    }))
    setErrors((e) => ({ ...e, base_url: undefined, model: undefined }))
  }

  function validate(): boolean {
    const errs: FieldErrors = {}
    if (!isLocal) {
      if (!form.base_url.trim()) errs.base_url = '请填写接口地址'
      if (!form.api_key.trim()) errs.api_key = '请填写自己的有效 API Key'
    }
    if (!form.model.trim()) errs.model = isLocal ? '请选择模型名称' : '请填写模型名称'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function handleVerify() {
    if (!allowSecret || isLocal || testing) { pushToast('info', '请先连接已登录的安全验证后端，并选择自备 API Key。'); return }
    if (!validate()) return
    resetVerification()
    const version = requestVersion.current
    setTesting(true)
    try {
      const result = await validateByok({ kind, base_url: form.base_url.trim(), model: form.model.trim(), api_key: form.api_key.trim() })
      if (version !== requestVersion.current) return
      setConnection(result)
      setTestResult({ ok: true, latency_ms: 0, model: result.model, message: '密钥已通过服务端验证；短期连接已启用。费用由个人账户承担。' })
    } catch (error) {
      if (version !== requestVersion.current) return
      invalidateConnection(kind)
      setTestResult({ ok: false, latency_ms: 0, message: error instanceof Error ? error.message : '验证失败，密钥未启用；不会自动切换免费额度。' })
    } finally {
      setForm(f => ({ ...f, api_key: '' }))
      setShowKey(false)
      setTesting(false)
    }
  }

  return (
    <div className="rounded-lg border border-line bg-page p-6">
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-[13px] text-ink-2">{description}</p>
      <p className="mt-2 text-xs text-ink-3">{verified ? '个人密钥已验证 · 短期连接有效' : allowSecret ? '输入个人密钥后，提交服务端验证' : mode === 'platform' ? '当前使用免费额度模式 · 个人密钥输入未启用' : '验证服务未启用 · 暂不接收 API Key'}</p>

      {/* 转写引擎选择 */}
      {isTranscription && (
        <div className="mt-6">
          <label className="mb-2 block text-sm font-medium text-ink">转写引擎</label>
          <div className="flex gap-6" role="radiogroup" aria-label="转写引擎">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
              <input
                type="radio"
                name={`engine-${kind}`}
                value="local"
                checked={form.engine === 'local'}
                onChange={() => updateEngine('local')}
                className="sr-only"
              />
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                  form.engine === 'local' ? 'border-ink' : 'border-line-strong'
                }`}
              >
                {form.engine === 'local' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-ink" />
                )}
              </span>
              本地引擎（配套助手）
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
              <input
                type="radio"
                name={`engine-${kind}`}
                value="remote"
                checked={form.engine === 'remote'}
                onChange={() => updateEngine('remote')}
                className="sr-only"
              />
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                  form.engine === 'remote' ? 'border-ink' : 'border-line-strong'
                }`}
              >
                {form.engine === 'remote' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-ink" />
                )}
              </span>
              远程引擎
            </label>
          </div>
          <p className="mt-2 text-[13px] text-ink-2">
            连接下方本地助手后，使用多语言 medium 在电脑上转写。远程接口与字幕导入仍可分别使用。
          </p>
          {isLocal && (
            <p className="mt-1 text-[13px] text-ink-3">{companion.active ? '已选择本机工作台；模型与媒体组件状态见下方。' : '请先在下方连接助手并准备模型，选择本地引擎不会自动调用远程服务。'}</p>
          )}
        </div>
      )}

      {/* 常用服务商预设（仅文本 AI）：点击自动填入 Base URL 与推荐模型 */}
      {!isTranscription && (
        <div className="mt-6">
          <label className="mb-2 block text-sm font-medium text-ink">常用服务商 <span className="ml-1 text-xs font-normal text-ink-3">可切换预设</span></label>
          <div className="flex flex-wrap gap-2" role="group" aria-label="常用服务商预设">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                aria-pressed={presetId === p.id}
                className={`h-7 cursor-pointer rounded-full border px-3 text-[13px] font-medium transition-colors duration-150 ${
                  presetId === p.id
                    ? 'border-ink bg-ink text-inverse'
                    : 'border-line-strong bg-page text-ink-2 hover:border-ink hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[13px] text-ink-2">
            按笔记总结、问答的质量、成本与速度选择推荐默认，不代表所有任务都最优；不自动改写已有配置。
          </p>
        </div>
      )}

      {/* Base URL */}
      <div className="mt-6">
        <label className="mb-2 block text-sm font-medium text-ink" htmlFor={`${kind}-base-url`}>
          接口地址（Base URL）
          {isLocal && <span className="ml-1 text-ink-3">（仅远程引擎需要填写）</span>}
        </label>
        <input
          id={`${kind}-base-url`}
          type="text"
          value={form.base_url}
          onChange={(e) => {
            setPresetId(null)
            updateField('base_url', e.target.value)
          }}
          disabled={isLocal || testing}
          placeholder="https://api.example.com/v1"
          className={`h-9 w-full rounded-md border px-3 font-mono text-sm outline-none transition-colors duration-150 ${
            errors.base_url
              ? 'border-danger focus:shadow-[0_0_0_3px_rgba(185,28,28,0.12)]'
              : 'border-line-strong focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,23,0.12)]'
          } ${isLocal ? 'bg-subtle text-ink-4' : 'bg-page text-ink'}`}
        />
        <p className="mt-1 text-[13px] text-ink-2">
          {isTranscription
            ? '仅远程引擎需要填写'
            : '模型服务的 API 地址，如 https://api.example.com/v1'}
        </p>
        {errors.base_url && (
          <p className="mt-1 text-[13px] text-danger">{errors.base_url}</p>
        )}
      </div>

      {/* API Key */}
      <div className="mt-6">
        <label className="mb-2 block text-sm font-medium text-ink" htmlFor={`${kind}-api-key`}>
          密钥（API Key）
          {isLocal && <span className="ml-1 text-ink-3">（仅远程引擎需要填写）</span>}
        </label>
        <div className="relative">
          <input
            id={`${kind}-api-key`}
            type={showKey ? 'text' : 'password'}
            value={form.api_key}
            onChange={(e) => updateField('api_key', e.target.value)}
            disabled={isLocal || !allowSecret || testing}
            placeholder={isLocal ? '' : !allowSecret ? '验证服务未启用' : '输入自己的有效 API Key'}
            autoComplete="new-password"
            className={`h-9 w-full rounded-md border px-3 pr-10 font-mono text-sm outline-none transition-colors duration-150 ${
              errors.api_key
                ? 'border-danger focus:shadow-[0_0_0_3px_rgba(185,28,28,0.12)]'
                : 'border-line-strong focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,23,0.12)]'
            } ${isLocal ? 'bg-subtle text-ink-4' : 'bg-page text-ink'}`}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            disabled={isLocal || !allowSecret || testing}
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-ink-3 transition-colors duration-150 hover:text-ink disabled:cursor-not-allowed"
            aria-label={showKey ? '隐藏密钥' : '显示密钥'}
          >
            {showKey ? <EyeOff size={16} strokeWidth={1.5} /> : <Eye size={16} strokeWidth={1.5} />}
          </button>
        </div>
        <p className="mt-1 text-[13px] text-ink-2">
          {allowSecret ? '密钥仅提交到同源验证后端；不会写入浏览器存储，验证结束后清空输入。' : '此入口保留，安全验证服务接通后才可输入。'}
        </p>
        {errors.api_key && (
          <p className="mt-1 text-[13px] text-danger">{errors.api_key}</p>
        )}
      </div>

      {/* 模型名称 */}
      <div className="mt-6">
        <label className="mb-2 block text-sm font-medium text-ink" htmlFor={`${kind}-model`}>
          模型名称
        </label>
        {isLocal ? (
          <input
            id={`${kind}-model`}
            type="text"
            value={form.model}
            readOnly
            aria-describedby={`${kind}-model-help`}
            className="h-9 w-full rounded-md border border-line bg-subtle px-3 font-mono text-sm text-ink"
          />
        ) : (
          <input
            id={`${kind}-model`}
            type="text"
            value={form.model}
            onChange={(e) => {
              setPresetId(null)
              updateField('model', e.target.value)
            }}
            placeholder="gpt-4o-mini"
            className={`h-9 w-full rounded-md border border-line-strong px-3 font-mono text-sm text-ink outline-none transition-colors duration-150 focus:border-ink focus:shadow-[0_0_0_3px_rgba(23,23,23,0.12)] ${
              errors.model ? '!border-danger focus:!shadow-[0_0_0_3px_rgba(185,28,28,0.12)]' : ''
            }`}
          />
        )}
        <p id={`${kind}-model-help`} className="mt-1 text-[13px] text-ink-2">
          {isLocal
            ? '本地转写固定使用多语言 medium；需要已配对的助手和校验通过的模型。'
            : presetId === 'vectide' ? '请按你的 Vectide 套餐填写模型 ID，不沿用其他服务商的模型名称。' : '推荐默认仍需账号拥有该模型权限；服务端验证后才能使用。'}
        </p>
        {errors.model && (
          <p className="mt-1 text-[13px] text-danger">{errors.model}</p>
        )}
      </div>

      <div className="mt-6 flex items-start gap-1.5 rounded-md bg-subtle px-3 py-2 text-[13px] text-ink-2">
        <Info size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-ink-3" />
        <span>{allowSecret ? '验证由后端向所选服务商发起真实请求；模型能力与费用以服务商为准。远程转写还需后端支持对应语音计费。' : '表单可查看和切换，当前不会发送密钥或调用模型。'}</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={testing} loadingText="服务端验证中…" onClick={() => void handleVerify()} disabled={isLocal || !allowSecret}>
          验证并使用此密钥
        </Button>
        {verified && <span className="text-xs text-success">仅当前会话有效</span>}
      </div>
      {/* 测试连接结果 */}
      {testResult && (
        <div
          className="mt-3 flex items-start gap-1.5 text-[13px]"
          aria-live="polite"
        >
          {testResult.ok ? (
            <CheckCircle2 size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-success" />
          ) : (
            <XCircle size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-danger" />
          )}
          <span className={testResult.ok ? 'text-success' : 'text-danger'}>
            {testResult.message}
          </span>
        </div>
      )}
    </div>
  )
}

function loadInitial(
  kind: ProviderKind,
  textAi: { base_url: string; api_key: string; model: string } | null,
  transcription: {
    engine: 'local' | 'remote'
    base_url: string
    api_key: string
    model: string
  } | null,
): FormState {
  if (kind === 'text_ai') {
    return {
      base_url: textAi?.base_url || SILICONFLOW_BASE_URL,
      api_key: '',
      model: textAi?.model || PROVIDER_PRESETS.find(p => p.base_url === (textAi?.base_url || SILICONFLOW_BASE_URL))?.model || '',
      engine: 'remote',
      remoteModel: '',
    }
  }
  return {
    base_url: transcription?.base_url || SILICONFLOW_BASE_URL,
    api_key: '',
    model: transcription?.engine === 'remote' ? transcription.model : LOCAL_TRANSCRIPTION_MODEL,
    engine: transcription?.engine ?? 'local',
    remoteModel: transcription?.engine === 'remote' ? transcription.model : '',
  }
}
