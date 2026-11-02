/**
 * API 客户端单点分发：VITE_USE_MOCK=true（显式演示）时全部走 src/mock 路由器，
 * 业务代码零感知；后端就绪后把开关关掉即切真实请求。
 * 业务组件严禁直接 import src/mock/* —— mock 只经本层引用。
 */
import { ApiRequestError, USE_MOCK } from './errors'
import type { ErrorCode } from './types'
import { inspectQuotaHttpError, inspectQuotaPayload } from './quotaSignals'
import { routeFetch } from './companion'
import { browserLocal } from '../browser/mode'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 通用请求。mock 模式下直接交给 mock 路由器（模拟网络延迟，让加载态可被观察）；
 * 真实模式走 fetch。非 2xx 统一抛 ApiRequestError。
 */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (USE_MOCK && !browserLocal()) {
    await delay(60 + Math.random() * 120)
    const { mockRoute } = await import('../mock/router')
    return mockRoute(method, path, body) as Promise<T>
  }
  const res = await routeFetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let code: ErrorCode = 'INVALID_INPUT'
    let message = `请求失败（${res.status}）`
    let retryable = false
    try {
      const data = (await res.json()) as { error?: { code: ErrorCode; message: string; retryable: boolean } }
      if (data.error) {
        code = data.error.code
        message = data.error.message
        retryable = data.error.retryable
      }
    } catch {
      /* 非 JSON 错误体，保留默认文案 */
    }
    inspectQuotaHttpError(res.status, code)
    throw new ApiRequestError(code, message, retryable, res.status)
  }
  const data = (await res.json()) as T
  inspectQuotaPayload(data)
  return data
}

/** 从整段分享文字提取 HTTP(S) 链接（F01）：剥离外层引号与尾部中英文标点 */
export function extractUrls(raw: string): string[] {
  const matched = raw.match(/https?:\/\/[^\s"'<>]+/g) ?? []
  const cleaned = matched.map((u) =>
    u
      .replace(/[，。、；：！？）】」』,.;:!?)\]}…]+$/u, '')
      .replace(/^["'«»]+/, '')
      .replace(/["'«»]+$/g, ''),
  )
  return [...new Set(cleaned)]
}
