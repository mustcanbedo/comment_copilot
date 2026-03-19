export const API_BASE = process.env.PLASMO_PUBLIC_API_URL || "http://localhost:3000/api"
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"

/** 意见反馈邮箱，用于法律文档展示 */
export const FEEDBACK_EMAIL = "feedback@yanling.com"

/** GitHub 仓库（owner/repo），用于意见反馈跳转 Issues，参考 immersive-translate 做法 */
const GITHUB_REPO = process.env.PLASMO_PUBLIC_GITHUB_REPO || "mustcanbedo/yanling"

/** 意见反馈页 URL（HTTPS），Chrome 商店要求可公开访问，跳转至 GitHub Issues 新建反馈 */
export const FEEDBACK_URL =
  process.env.PLASMO_PUBLIC_FEEDBACK_URL ||
  `https://github.com/${GITHUB_REPO}/issues/new?${new URLSearchParams({
    title: "言灵 Yanling 意见反馈",
    body: "请描述您的问题或建议：\n\n",
  })}`
