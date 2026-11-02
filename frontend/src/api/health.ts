/** 健康检查（site-spec §5.3 ⑬）—— health 接口接入位预留（F20，P2） */
import { request } from './client'
import type { HealthResponse } from './types'

// ⑬ GET /api/health
export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('GET', '/api/health')
}
