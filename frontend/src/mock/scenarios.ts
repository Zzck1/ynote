/**
 * 魔法标记 → 错误/场景映射（site-spec §5.4「可复现错误场景」）。
 * 链接含对应标记即触发，便于演示与自测；无任何 URL → 400 INVALID_INPUT。
 */
import type { ErrorCode } from '../api/types'

export interface ScenarioFlags {
  failVideo: boolean
  login: boolean
  expire: boolean
  partial: boolean
  diskfull: boolean
}

export function detectScenarios(url: string): ScenarioFlags {
  return {
    failVideo: url.includes('fail-video'),
    login: url.includes('login'),
    expire: url.includes('expire'),
    partial: url.includes('partial'),
    diskfull: url.includes('diskfull'),
  }
}

export function hasAnyScenario(url: string): boolean {
  const f = detectScenarios(url)
  return f.failVideo || f.login || f.expire || f.partial || f.diskfull
}

/**
 * 错误码 → 用户文案（content-plan §3 错误提示文案表，人话结论 + 建议动作）。
 * Mock 中作为 ApiError.message 直接产出；前端 UI 不再二次映射。
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  TASK_NOT_FOUND: '这条任务不在当前工作台中，请新建任务后提取。',
  TASK_SOURCE_CHANGED: '工作台来源已切换，请重新选择当前本机任务。',
  COMPANION_REQUIRED: '请先安装并连接本地媒体助手。',
  MATERIAL_NOT_FOUND: '这份资料不存在或已被删除。请回到资料库重新选择。',
  ASSET_NOT_FOUND: '这份作品没有对应素材。可改用其他提取项。',
  LOGIN_REQUIRED: '这项内容需要登录平台后才能获取。请在浏览器登录后重试，或导入已下载的本地文件。',
  RATE_LIMITED: '平台暂时限制了访问频率。已自动等待后重试 3 次仍未成功，请 5 分钟后再试。',
  LINK_EXPIRED: '链接已过期或内容被删除。请回到原作品重新分享，拿到新链接后再来。',
  NO_CLEAN_SOURCE:
    '没有找到可确认的无水印源（来源声明无水印 ≠ 已确认）。已跳过这项，改选「优先无水印」可回退原版继续下载。',
  TRANSCRIBE_FAILED:
    '音频转写在第 4 块失败，已保留前 3 块结果（覆盖到 02:30）。可点击重试，只补缺失部分，已完成的不重跑。',
  MODEL_FAILED: '模型请求失败：服务未配置。请到设置页检查配置或换个模型后重试。',
  DISK_FULL:
    '磁盘剩余 12 GB，不足以完成这次下载（约需 15 GB）。已停止新任务，已完成素材不受影响。清理空间后可继续。',
  INVALID_INPUT: '输入有误，请检查后重试。',
  QUOTA_EXCEEDED: '平台免费额度不足，请使用有效的个人 API Key。',
  BYOK_INVALID: '个人 API Key 验证失败。',
  BYOK_VALIDATION_REQUIRED: '请先验证个人 API Key。',
  QUOTA_UNAVAILABLE: '平台额度未启用。',
}
