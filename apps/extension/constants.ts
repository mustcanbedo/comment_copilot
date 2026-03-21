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

/** 灵主页保存的小红书昵称（chrome.storage.local），供 content script 过滤当前用户自己的评论 */
export const YANLING_XHS_SELF_NICK_STORAGE_KEY = "yanling_xhs_self_nickname"

/** 登录 JWT（@plasmohq/storage / chrome.storage），侧栏与 background 必须共用同一 key */
export const AUTH_TOKEN_KEY = "authToken"

export const API_BASE = process.env.PLASMO_PUBLIC_API_URL || "http://localhost:3000/api"
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"

/** 意见反馈邮箱，用于法律文档展示 */
export const FEEDBACK_EMAIL = "yanlingmodel@163.com"

/** GitHub 仓库（owner/repo），用于意见反馈跳转 Issues，参考 immersive-translate 做法 */
const GITHUB_REPO = process.env.PLASMO_PUBLIC_GITHUB_REPO || "mustcanbedo/yanling"

/** 意见反馈页 URL（HTTPS），Chrome 商店要求可公开访问，跳转至 GitHub Issues 新建反馈 */
export const FEEDBACK_URL =
  process.env.PLASMO_PUBLIC_FEEDBACK_URL ||
  `https://github.com/${GITHUB_REPO}/issues/new?${new URLSearchParams({
    title: "言灵 Yanling 意见反馈",
    body: "请描述您的问题或建议：\n\n",
  })}`
