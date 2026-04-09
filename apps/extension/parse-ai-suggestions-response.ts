/**
 * 解析扩展 Background 对 `/api/ai/reply`、`/api/ai/note-comment` 的 fetch 响应。
 * 与 Go `gin.H` 错误字段及 HTTP 状态对齐，供侧栏直接展示。
 */

export type AiSuggestionsResult = {
  ok: boolean
  error?: string
  code?: string
  suggestions: string[]
}

/** 后端英文 / 技术 error → 中文 */
const AI_ERROR_EN_TO_ZH: Record<string, string> = {
  "ai service error": "AI 服务暂时不可用，请稍后重试",
  "invalid ai json": "生成内容格式异常，请重试",
  "invalid ai response": "AI 响应异常，请重试",
  "ai returned empty choices": "AI 未返回有效内容，请重试",
  "ai returned empty content": "AI 未返回有效内容，请重试",
  "ai returned no suggestions": "未生成候选回复，请重试",
  insufficient_points: "积分不足，请充值",
}

function toUserFacingAiError(msg: string): string {
  const k = msg.trim().toLowerCase()
  return AI_ERROR_EN_TO_ZH[k] ?? msg
}

export async function parseAiSuggestionsResponse(res: Response): Promise<AiSuggestionsResult> {
  const text = await res.text()
  let raw: Record<string, unknown> = {}
  try {
    raw = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    return { ok: false, error: "响应无法解析", suggestions: [] }
  }
  const suggestions = Array.isArray(raw.suggestions)
    ? (raw.suggestions as unknown[]).filter((s): s is string => typeof s === "string")
    : []

  let code = typeof raw.code === "string" ? raw.code : undefined
  const rawError = typeof raw.error === "string" ? raw.error.trim() : ""
  const rawMessage = typeof raw.message === "string" ? raw.message.trim() : ""

  if (!code && (rawError === "insufficient_points" || res.status === 402)) {
    code = "INSUFFICIENT_POINTS"
  }
  if (!code && /insufficient/i.test(rawMessage) && /point/i.test(rawMessage)) {
    code = "INSUFFICIENT_POINTS"
  }

  const baseFromBody = rawError || rawMessage
  let errorOut = baseFromBody

  if (code === "INSUFFICIENT_POINTS") {
    errorOut = "积分不足，请充值"
  } else if (baseFromBody) {
    errorOut = toUserFacingAiError(baseFromBody)
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      code = code || "AUTH_REQUIRED"
      errorOut = errorOut || "登录已失效，请重新登录"
    }
    if (!errorOut) {
      if (res.status === 429) errorOut = "请求过于频繁，请稍后再试"
      else if (res.status >= 502 && res.status <= 504) errorOut = "AI 服务暂时不可用，请稍后重试"
      else errorOut = `请求失败 (${res.status})`
    }
    return { ok: false, error: errorOut, code, suggestions }
  }

  if (raw.ok === false) {
    if (!errorOut) errorOut = "生成失败"
    return { ok: false, error: errorOut, code, suggestions }
  }

  return { ok: true, suggestions }
}
