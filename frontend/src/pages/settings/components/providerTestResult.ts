import type { TestConnectionResult } from '../../../api/types'

/** Connectivity checks exercise the model-list endpoint, not model generation. */
export function formatTestResult(result: TestConnectionResult): string {
  if (!result.ok) return result.message
  return `${result.message}，耗时 ${result.latency_ms}ms。此检查未验证所选模型的生成能力。`
}
