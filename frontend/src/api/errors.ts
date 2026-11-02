/** 归一化错误：code + 可直接展示的中文 message + retryable（site-spec §5.3 通用约定） */
import type { ApiError, ErrorCode } from './types'

/** 演示必须显式启用；正常启动始终使用本机后端。 */
export const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

export class ApiRequestError extends Error implements ApiError {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly status?: number

  constructor(code: ErrorCode, message: string, retryable = false, status?: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.message = message
    this.retryable = retryable
    this.status = status
  }

  static from(code: ErrorCode, message: string, retryable = false): ApiRequestError {
    return new ApiRequestError(code, message, retryable)
  }
}

export function toApiError(code: ErrorCode, message: string, retryable = false): ApiError {
  return { code, message, retryable }
}
