/**
 * 是否为小红书「笔记详情」网页 URL（与侧栏「笔记跟评」、评论拉取判断一致）。
 * 常见路径：`/explore/{noteId}`、`/discovery/item/{noteId}`（分享/站内跳转均可能出现）。
 */
export function isXhsNotePageUrl(url?: string | null): boolean {
  if (!url || !url.includes("xiaohongshu.com")) return false
  return (
    /\/explore\/[a-zA-Z0-9]+/.test(url) ||
    /\/discovery\/item\/[a-zA-Z0-9]+/.test(url)
  )
}

/**
 * 是否为 B 站「视频播放页」URL（与独立 content 脚本 `bilibili.ts` 的 DOM 规则入口一致）。
 * BV 号、旧 av 号均可能出现在 pathname。
 */
export function isBilibiliVideoPageUrl(url?: string | null): boolean {
  if (!url || !url.includes("bilibili.com")) return false
  try {
    const p = new URL(url).pathname
    return /^\/video\/BV[0-9A-Za-z]+/i.test(p) || /^\/video\/av\d+/i.test(p)
  } catch {
    return false
  }
}

/** 抖音视频 id 多为 10～22 位数字；过滤 query 里 `aweme_id=1` 等误匹配 */
function isLikelyDouyinSnowflakeId(s: string): boolean {
  return /^\d{10,22}$/.test(s)
}

/**
 * 从抖音 URL 解析视频数字 id：`/video/123`、query、或 hash 内 `modal_id=`（部分路由把参数写在 hash）。
 */
export function parseDouyinNumericVideoId(url?: string | null): string | null {
  if (!url || !url.includes("douyin.com")) return null
  try {
    const u = new URL(url)
    const p = u.pathname.replace(/\/+$/, "") || "/"
    const pathM = p.match(/^\/video\/(\d+)(?:\/|$)/)
    if (pathM?.[1] && isLikelyDouyinSnowflakeId(pathM[1])) return pathM[1]
    const keys = ["modal_id", "aweme_id", "video_id", "item_id"] as const
    for (const key of keys) {
      const v = u.searchParams.get(key)?.trim()
      if (v && isLikelyDouyinSnowflakeId(v)) return v
    }
    const hash = u.hash
    if (hash.length > 1) {
      const tail = hash.slice(1)
      const qIdx = tail.indexOf("?")
      const qs = qIdx >= 0 ? tail.slice(qIdx + 1) : tail
      const hp = new URLSearchParams(qs)
      for (const key of keys) {
        const v = hp.get(key)?.trim()
        if (v && isLikelyDouyinSnowflakeId(v)) return v
      }
      const mm = hash.match(/(?:modal_id|aweme_id|video_id|item_id)[=:](\d{10,22})/i)
      if (mm?.[1]) return mm[1]
    }
    return null
  } catch {
    return null
  }
}

/**
 * 抖音 Web 上**已能唯一定位到一条视频**的 URL（与 `contents/douyin.ts` 内严格逻辑一致）。
 */
export function isDouyinVideoPageUrl(url?: string | null): boolean {
  return parseDouyinNumericVideoId(url) != null
}

/**
 * 弹层播放器常见「壳」路径：用户正在刷精选/关注等，地址栏可能暂时**没有** `modal_id`（打开评论后才写入）。
 * 仅收录**信息流/推荐**类路径，避免把搜索页、用户主页等整站页当成跟评上下文（减少误扫与请求）。
 */
export function isDouyinModalSurfaceUrl(url?: string | null): boolean {
  if (!url || !url.includes("douyin.com")) return false
  try {
    const u = new URL(url)
    const p = u.pathname.replace(/\/+$/, "") || "/"
    if (p === "/" || p === "") return true
    const surfaces = ["/jingxuan", "/following", "/friend", "/explore"]
    return surfaces.some(s => p === s || p.startsWith(`${s}/`))
  } catch {
    return false
  }
}

/** 扩展可采集 / 侧栏「抖音视频」上下文：含独立视频页、带 modal_id 的 URL、以及精选等壳层 */
export function isDouyinContentTargetUrl(url?: string | null): boolean {
  return isDouyinVideoPageUrl(url) || isDouyinModalSurfaceUrl(url)
}

/**
 * 同一视频在「/video/id」与「?modal_id=id」下统一为 `/video/id`，便于 ingest 与 DB 按 postUrl 对齐。
 */
export function canonicalDouyinPostUrl(url?: string | null): string {
  if (!url || !url.includes("douyin.com")) return url ?? ""
  try {
    const u = new URL(url)
    const id = parseDouyinNumericVideoId(url)
    if (id) return `${u.origin}/video/${id}`
    return url
  } catch {
    return url
  }
}

/** 侧栏 / background 认定的「可采集评论 + 主评 AI」页面类型；DOM 规则按此在各自 content 脚本内分支 */
export type CommentCopilotPageKind = "xhs-note" | "bilibili-video" | "douyin-video"

export function getCommentCopilotPageKind(url?: string | null): CommentCopilotPageKind | null {
  if (isXhsNotePageUrl(url)) return "xhs-note"
  if (isBilibiliVideoPageUrl(url)) return "bilibili-video"
  if (isDouyinContentTargetUrl(url)) return "douyin-video"
  return null
}

export function isCommentCopilotPageUrl(url?: string | null): boolean {
  return getCommentCopilotPageKind(url) !== null
}

/**
 * 侧栏 `tabs.onUpdated` 拉评论去重：同一「帖子身份」的连续 URL 事件跳过，减轻抖音 SPA 噪声请求。
 * （`history.pushState` 未必触发 `changeInfo.url`，故 content 的 `URL_CHANGED` 仍保留。）
 */
export function commentCopilotTabFetchDedupeKey(url?: string | null): string {
  if (!url || !url.trim()) return "empty"
  const kind = getCommentCopilotPageKind(url)
  if (!kind) return `unsupported|${url}`
  if (kind === "douyin-video") {
    try {
      if (!url.includes("douyin.com")) return `douyin|${url}`
      return `douyin|${canonicalDouyinPostUrl(url)}`
    } catch {
      return `douyin|${url}`
    }
  }
  if (kind === "bilibili-video") {
    try {
      return `bilibili|${new URL(url).pathname}`
    } catch {
      return `bilibili|${url}`
    }
  }
  return `xhs|${url}`
}

/** 上报 ingest / mark-replied 等平台字段，与当前标签 URL 对齐 */
export type CommentCopilotIngestPlatform = "xiaohongshu" | "bilibili" | "douyin"

/**
 * 由当前标签 URL 推断 ingest / mark-replied 的 platform 字段。
 * 非三站域名时默认 `xiaohongshu`（历史兼容）；若调用方已知 URL 不可靠宜先校验 `isCommentCopilotPageUrl`。
 */
export function commentCopilotPlatformFromUrl(url?: string | null): CommentCopilotIngestPlatform {
  if (!url) return "xiaohongshu"
  if (url.includes("bilibili.com")) return "bilibili"
  if (url.includes("douyin.com")) return "douyin"
  return "xiaohongshu"
}

/** 本机扩展存储：历史版本曾写入的小红书展示昵称（chrome.storage.local），content 仍可读作兜底过滤 */
export const YANLING_XHS_SELF_NICK_STORAGE_KEY = "yanling_xhs_self_nickname"

/** 本机扩展存储：历史版本曾写入的抖音展示昵称，content 仍可读作兜底过滤 */
export const YANLING_DOUYIN_SELF_NICK_STORAGE_KEY = "yanling_douyin_self_nickname"

/** 登录 JWT（@plasmohq/storage / chrome.storage），侧栏与 background 必须共用同一 key */
export const AUTH_TOKEN_KEY = "authToken"

export const API_BASE = process.env.PLASMO_PUBLIC_API_URL || "http://localhost:3000/api"
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"

/** 意见反馈邮箱，用于法律文档展示（从环境变量读取，默认 placeholder） */
export const FEEDBACK_EMAIL = process.env.PLASMO_PUBLIC_FEEDBACK_EMAIL || "feedback@example.com"

/** GitHub 仓库（owner/repo），用于意见反馈跳转 Issues（从环境变量读取，默认 placeholder） */
const GITHUB_REPO = process.env.PLASMO_PUBLIC_GITHUB_REPO || "your-username/your-repo"

/** 意见反馈页 URL（HTTPS），Chrome 商店要求可公开访问，跳转至 GitHub Issues 新建反馈 */
export const FEEDBACK_URL =
  process.env.PLASMO_PUBLIC_FEEDBACK_URL ||
  `https://github.com/${GITHUB_REPO}/issues/new?${new URLSearchParams({
    title: "言灵 Yanling 意见反馈",
    body: "请描述您的问题或建议：\n\n",
  })}`
