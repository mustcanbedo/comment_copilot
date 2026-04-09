import type { PlasmoCSConfig } from "plasmo"

import { isXhsNotePageUrl, YANLING_XHS_SELF_NICK_STORAGE_KEY } from "../constants"
import { createThrottledScan, type ContentFillResult } from "./shared/platform-content-utils"

export const config: PlasmoCSConfig = {
  matches: ["https://www.xiaohongshu.com/*"],
  run_at: "document_idle",
  all_frames: false,
}

interface ScrapedComment {
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
  postUrl: string
  /** 无 alt 的 emoji 图片 URL，与 content 中 [表情] 一一对应，供侧栏用 img 展示 */
  emojiUrls?: string[]
  /** 评论附带的图片（.comment-picture），纯图评论时 content 为【图片】 */
  attachmentImageUrls?: string[]
}

// 默认 selector，从服务端热更新覆盖
let SELECTORS = {
  commentList: ".comment-item",
  authorName: "a.name",
  content: ".comment-inner-container > span:not([class])",
  timestamp: "span:not([class]) + span:not([class])",
}

const seenIds = new Set<string>()
const SEEN_IDS_MAX = 3000 // 防内存无限增长；后端按 platformCommentId 去重，重发无害
let consecutiveFailures = 0
const MAX_FAILURES = 5
let currentUrl = location.href

/** 当前页登录用户（用于过滤「自己发的评论/回复」，避免侧栏全部+1） */
interface XhsViewerHint {
  userId: string | null
  nickname: string | null
}
let viewerHintMemo: { at: number; hint: XhsViewerHint } | null = null
const VIEWER_HINT_TTL_MS = 3000

function normalizeDisplayName(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

/** 页面昵称可能被截断，与侧栏/状态不完全一致时仍判为同一人 */
function nicknamesLikelySame(authorName: string, selfNick: string): boolean {
  const a = normalizeDisplayName(authorName)
  const b = normalizeDisplayName(selfNick)
  if (a === b) return true
  if (a.length < 2 || b.length < 2) return false
  const shorter = a.length <= b.length ? a : b
  const longer = a.length > b.length ? a : b
  // 至少 5 个字符再做前缀匹配，减少短昵称撞前缀误判（如截断展示名）
  if (shorter.length >= 5 && longer.startsWith(shorter)) return true
  return false
}

/** 小红书 __INITIAL_STATE__ 里大量 Vue3 ref，直接读 .nickname 会得到 undefined */
function unwrapVueRef(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== "object") return value
  const r = value as Record<string, unknown>
  if (r.__v_isRef === true) {
    const inner =
      r._rawValue !== undefined
        ? r._rawValue
        : (r as { value?: unknown }).value !== undefined
          ? (r as { value: unknown }).value
          : undefined
    return unwrapVueRef(inner)
  }
  return value
}

function mergeViewerFromObject(target: XhsViewerHint, u: unknown) {
  u = unwrapVueRef(u)
  if (!u || typeof u !== "object") return
  const o = u as Record<string, unknown>
  const ui = unwrapVueRef(o.userInfo) as Record<string, unknown> | undefined
  const uiObj = ui && typeof ui === "object" ? ui : undefined
  const n =
    (typeof uiObj?.nickname === "string" ? uiObj.nickname : undefined) ??
    (typeof o.nickname === "string" ? o.nickname : undefined) ??
    (typeof o.userNickname === "string" ? o.userNickname : undefined) ??
    (typeof o.nickName === "string" ? o.nickName : undefined)
  if (typeof n === "string" && n.trim()) target.nickname = target.nickname || n.trim()

  const uidRaw =
    uiObj?.userId ?? uiObj?.user_id ?? o.userId ?? o.user_id ?? o.id
  const uid = unwrapVueRef(uidRaw)
  if (typeof uid === "string" && uid.trim()) target.userId = target.userId || uid.trim()
  else if (typeof uid === "number" && Number.isFinite(uid)) target.userId = target.userId || String(uid)
}

/** 从 __INITIAL_STATE__ 读取当前登录用户（结构随小红书改版可能变化，多路径兜底） */
function readXhsViewerHintFromPage(): XhsViewerHint {
  const hint: XhsViewerHint = { userId: null, nickname: null }
  try {
    const st = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__
    if (!st || typeof st !== "object") return hint

    mergeViewerFromObject(hint, unwrapVueRef(st.user))
    const global = unwrapVueRef(st.global) as Record<string, unknown> | undefined
    if (global && typeof global === "object") {
      mergeViewerFromObject(hint, global.userInfo)
      mergeViewerFromObject(hint, global.user)
    }
    const interaction = unwrapVueRef(st.interaction) as Record<string, unknown> | undefined
    if (interaction && typeof interaction === "object") {
      mergeViewerFromObject(hint, interaction.user)
    }

    const user = unwrapVueRef(st.user) as Record<string, unknown> | undefined
    if (user && typeof user === "object" && user.userInfo != null) {
      mergeViewerFromObject(hint, user.userInfo)
    }
  } catch {
    /* ignore */
  }
  return hint
}

function getXhsViewerHint(): XhsViewerHint {
  const now = Date.now()
  if (viewerHintMemo) {
    const age = now - viewerHintMemo.at
    const h = viewerHintMemo.hint
    // 已登录信息：缓存久一点；尚未读到 user（首屏可能晚注入）：短缓存以便尽快识别自己
    if (h.userId || h.nickname) {
      if (age < VIEWER_HINT_TTL_MS) return h
    } else if (age < 400) {
      return h
    }
  }
  const hint = readXhsViewerHintFromPage()
  viewerHintMemo = { at: now, hint }
  return hint
}

/** 从评论节点提取作者 userId（data 属性 + 任意 profile 链接，兼容子评论 DOM） */
function extractCommentAuthorUserId(node: Element): string | null {
  const fromAttr =
    node.getAttribute("data-user-id") ||
    node.getAttribute("data-userid") ||
    node.closest("[data-user-id]")?.getAttribute("data-user-id") ||
    node.querySelector(".author-wrapper [data-user-id], .name [data-user-id]")?.getAttribute("data-user-id")
  if (fromAttr?.trim()) return fromAttr.trim()

  const links = node.querySelectorAll(
    'a[href*="user/profile"], a[href*="explore/user"], a.name[href], .name a[href]'
  )
  for (let i = 0; i < links.length; i++) {
    const link = links[i] as HTMLAnchorElement
    const href = link.getAttribute("href") || link.href
    if (!href) continue
    try {
      const path = new URL(href, location.origin).pathname
      const m =
        path.match(/\/user\/profile\/([a-zA-Z0-9]+)/) ||
        path.match(/\/explore\/user\/([a-zA-Z0-9]+)/)
      if (m?.[1]) return m[1]
    } catch {
      const m =
        href.match(/\/user\/profile\/([a-zA-Z0-9]+)/) ||
        href.match(/\/explore\/user\/([a-zA-Z0-9]+)/)
      if (m?.[1]) return m[1]
    }
  }
  return null
}

/** 本机扩展存储中的小红书展示昵称（若有），每次 scan 前刷新；用于在页内读不到身份时的兜底过滤 */
let cachedSelfNicknameOverride: string | null = null

function loadSelfNicknameOverride(): Promise<void> {
  return new Promise(resolve => {
    try {
      if (!chrome.storage?.local) {
        cachedSelfNicknameOverride = null
        resolve()
        return
      }
      chrome.storage.local.get([YANLING_XHS_SELF_NICK_STORAGE_KEY], r => {
        const v = r[YANLING_XHS_SELF_NICK_STORAGE_KEY]
        cachedSelfNicknameOverride = typeof v === "string" && v.trim() ? v.trim() : null
        resolve()
      })
    } catch {
      cachedSelfNicknameOverride = null
      resolve()
    }
  })
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[YANLING_XHS_SELF_NICK_STORAGE_KEY]) return
    const nv = changes[YANLING_XHS_SELF_NICK_STORAGE_KEY].newValue
    cachedSelfNicknameOverride = typeof nv === "string" && nv.trim() ? nv.trim() : null
  })
}

/** 是否为当前登录用户所发（避免采集自己回复） */
function isCommentFromCurrentViewer(node: Element, authorName: string): boolean {
  if (cachedSelfNicknameOverride && nicknamesLikelySame(authorName, cachedSelfNicknameOverride)) {
    return true
  }

  const hint = getXhsViewerHint()
  if (!hint.userId && !hint.nickname) return false

  if (hint.userId) {
    const cid = extractCommentAuthorUserId(node)
    if (cid && cid === hint.userId) return true
  }

  if (hint.nickname && nicknamesLikelySame(authorName, hint.nickname)) {
    return true
  }
  return false
}

/** 拼接节点内文本并收集无 alt 的 emoji 图 URL：文本用 alt 或 [表情]，无 alt 时把 src 放入 emojiUrls 供侧栏用 img 展示 */
function getTextAndEmojiUrls(el: Element): { text: string; emojiUrls: string[] } {
  const parts: string[] = []
  const emojiUrls: string[] = []
  function walk(e: Element) {
    e.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim()
        if (t) parts.push(t)
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node as Element
        if (tag.tagName === "IMG") {
          const alt =
            tag.getAttribute("alt")?.trim() ||
            tag.getAttribute("data-emoji")?.trim() ||
            (tag as HTMLImageElement).dataset?.emoji
          const src = (tag as HTMLImageElement).src?.trim()
          if (alt) parts.push(alt)
          else {
            parts.push("[表情]")
            if (src) emojiUrls.push(src)
          }
        } else {
          walk(tag)
        }
      }
    })
  }
  walk(el)
  return { text: parts.join("").trim(), emojiUrls }
}

/** 无 data-comment-id 时用「作者+正文」生成稳定 ID；选择器与 parseCommentNode 一致，兼容 .right / .content 等 DOM */
function getCommentFingerprint(el: Element): string {
  const author = (el.querySelector(SELECTORS.authorName) as HTMLElement)?.innerText?.slice(0, 10) ?? ""
  const contentEl =
    el.querySelector('.note-text, .content .note-text') ||
    el.querySelector('.content') ||
    el.querySelector('[class*="content"]') ||
    el.querySelector(SELECTORS.content)
  const content = (contentEl as HTMLElement)?.innerText?.slice(0, 20) ?? ""
  return author + content
}

/** 优先用 data-comment-id / data-id / id；都没有则用 getCommentFingerprint 生成，保证多套 DOM 下 ID 稳定 */
function extractCommentId(el: Element): string {
  return (
    el.getAttribute("data-comment-id") ||
    el.getAttribute("data-id") ||
    (el.id || null) ||
    `xhs_${btoa(encodeURIComponent(getCommentFingerprint(el))).slice(0, 16)}`
  )
}

function parseCommentNode(node: Element): ScrapedComment | null {
  const authorEl = node.querySelector(SELECTORS.authorName) as HTMLElement | null

  // 过滤掉笔记作者自己的评论/回复（带"作者"文字标签）
  const authorTag = node.querySelector('.author-wrapper .tag, .author-tag, [class*="author-tag"]')
  if (authorTag && authorTag.textContent?.trim() === "作者") return null

  // 小红书有多套 DOM：有的用 .comment-inner-container，有的用 .right 包 .content/.author-wrapper/.info
  const innerContainer =
    node.querySelector('.comment-inner-container') ||
    node.querySelector('.right') ||
    node
  if (!innerContainer) return null

  // 正文：.content 下的 .note-text（span + img），无 alt 时用 [表情] 并记下 img src 到 emojiUrls
  const contentContainers = [
    innerContainer.querySelector('.note-text, .content .note-text'),
    innerContainer.querySelector('.content'),
    innerContainer.querySelector('[class*="content"]'),
  ].filter(Boolean) as Element[]
  let content = ""
  let emojiUrls: string[] = []
  for (const container of contentContainers) {
    const { text, emojiUrls: urls } = getTextAndEmojiUrls(container)
    content = text.trim()
    emojiUrls = urls
    if (content.length >= 2) break
  }
  if (!content) {
    const spans = Array.from(innerContainer.querySelectorAll('span'))
    const contentEl = spans.find(s => !s.className && s.textContent && s.textContent.trim().length > 1) ?? null
    if (contentEl?.parentElement) {
      const { text, emojiUrls: urls } = getTextAndEmojiUrls(contentEl.parentElement)
      content = text.trim()
      emojiUrls = urls
    }
    if (!content) content = contentEl?.textContent?.trim() ?? ""
  }

  // 评论附图：.comment-picture 下的 img（用户发的图片评论）
  const pictureImgs = node.querySelectorAll('.comment-picture img, [class*="comment-picture"] img')
  const attachmentImageUrls: string[] = []
  pictureImgs.forEach((img) => {
    const src = (img as HTMLImageElement).src?.trim()
    if (src) attachmentImageUrls.push(src)
  })

  // 纯图片评论：无文字或极短时，用【图片】占位并保留附图 URL，方便展示和让 AI 生成通用回复
  if ((!content || content.length < 2) && attachmentImageUrls.length > 0) {
    content = "【图片】"
  }

  // 时间：优先 [datetime]，否则 .date 或 .info .date 里的第一个 span（如「1小时前」）
  const timeEl =
    innerContainer.querySelector("[datetime]") ||
    innerContainer.querySelector(".date span, .info .date span")
  const authorName = authorEl?.innerText?.trim()
  const commentedAt =
    (timeEl?.getAttribute("datetime") ?? (timeEl as HTMLElement)?.innerText?.trim()) || new Date().toISOString()

  if (!authorName) return null

  // 过滤当前登录用户自己的评论/回复（否则侧栏「全部」会把自己刚发的也算进去）
  if (isCommentFromCurrentViewer(node, authorName)) return null

  if (!content || (content.length < 2 && attachmentImageUrls.length === 0)) return null

  return {
    platformCommentId: extractCommentId(node),
    authorName,
    content,
    commentedAt,
    postUrl: location.href,
    ...(emojiUrls.length > 0 ? { emojiUrls } : {}),
    ...(attachmentImageUrls.length > 0 ? { attachmentImageUrls } : {}),
  }
}

async function scanAllComments(): Promise<ScrapedComment[]> {
  await loadSelfNicknameOverride()

  const nodes = document.querySelectorAll(SELECTORS.commentList)

  if (nodes.length === 0) {
    consecutiveFailures++
    const isNote = isXhsNotePageUrl(currentUrl)
    if (consecutiveFailures >= MAX_FAILURES && isNote) {
      chrome.runtime.sendMessage({ type: "CIRCUIT_OPEN" }).catch(() => {})
      console.warn("[CommentCopilot] Circuit opened: selector failures")
    }
    return []
  }

  consecutiveFailures = 0
  const results: ScrapedComment[] = []

  // size 超限时只保留本次可见节点的 ID，避免历史 ID 堆积导致内存无限增长
  // 清空后本次节点会重新入 seenIds，后端有 platformCommentId 去重兜底
  if (seenIds.size > SEEN_IDS_MAX) {
    const visibleIds = new Set(
      Array.from(nodes)
        .map(n => parseCommentNode(n)?.platformCommentId)
        .filter(Boolean) as string[]
    )
    for (const id of seenIds) {
      if (!visibleIds.has(id)) seenIds.delete(id)
    }
  }

  nodes.forEach((node) => {
    const c = parseCommentNode(node)
    if (c && !seenIds.has(c.platformCommentId)) {
      seenIds.add(c.platformCommentId)
      results.push(c)
    }
  })

  return results
}

function sendComments(comments: ScrapedComment[]) {
  if (!comments.length) return
  console.log(`[CommentCopilot] sending ${comments.length} comments`)
  chrome.runtime.sendMessage({
    type: "COMMENTS_COLLECTED",
    payload: { platform: "xiaohongshu", comments },
  }).catch(() => {})
}

// 首次扫描，指数退避重试（1s → 1.5s → 2.25s → …，最长 5s）
async function initialScan(retries = 5, delay = 1000) {
  const comments = await scanAllComments()
  if (comments.length > 0) {
    sendComments(comments)
  } else if (retries > 0) {
    setTimeout(() => {
      initialScan(retries - 1, Math.min(delay * 1.5, 5000))
    }, delay)
  }
}

// 监听 SPA 路由变化（小红书用 history.pushState）
const originalPushState = history.pushState.bind(history)
history.pushState = function (...args) {
  originalPushState(...args)
  onUrlChange()
}

window.addEventListener("popstate", onUrlChange)

function onUrlChange() {
  // 同一链接再次进入（如从首页点回同一笔记）也需清空并重新扫描，否则侧边栏不会显示评论
  currentUrl = location.href
  cachedNoteContainer = null
  seenIds.clear()
  viewerHintMemo = null
  // 通知侧边栏：URL 已变化（或同一链接再次进入），清空并等待新评论
  chrome.runtime.sendMessage({
    type: "URL_CHANGED",
    payload: { url: currentUrl },
  }).catch(() => {})
  setTimeout(() => {
    void initialScan()
    setTimeout(setupScrollSync, 1000)
  }, 1500)
}

// MutationObserver 监听动态加载的新评论；节流：300ms 内多次 DOM 变化只触发一次扫描，减少 CPU 与消息
const SCAN_THROTTLE_MS = 300
const runThrottledScan = createThrottledScan(
  SCAN_THROTTLE_MS,
  async () => {
    const newComments = await scanAllComments()
    if (newComments.length > 0) sendComments(newComments)
  },
  { label: "xhs" },
)
const observer = new MutationObserver(runThrottledScan)

/** 判断是否在单条评论卡片内（与底部「主评论」输入区分）；避免 [class*='comment-item'] 误伤无关模块 */
function isInsideListCommentRow(el: Element): boolean {
  if (el.closest(SELECTORS.commentList)) return true
  if (el.closest(".note-comment-card")) return true
  const fuzzy = el.closest("[class*='comment-item']")
  if (!fuzzy) return false
  const cls = ((fuzzy as HTMLElement).className?.toString?.() ?? "").split(/\s+/).filter(Boolean)
  return cls.some(t => t === "comment-item" || /^comment-item[-_]/.test(t))
}

/** 主评相关：穿透 shadow 的最大深度（过深多为无关子树，避免全页递归过重） */
const NOTE_COMMENT_MAX_SHADOW_DEPTH = 10

/**
 * 遍历 light DOM + 各层 open ShadowRoot。
 * `maxShadowDepth` 限制 shadow 嵌套层数，降低 fillNoteComment 全树扫描时的 CPU 峰值。
 */
function forEachElementDeep(
  root: Document | ShadowRoot | HTMLElement,
  visit: (el: Element) => void,
  shadowDepth = 0,
  maxShadowDepth = NOTE_COMMENT_MAX_SHADOW_DEPTH
): void {
  root.querySelectorAll("*").forEach((el) => {
    visit(el)
    const sr = (el as HTMLElement).shadowRoot
    if (sr && shadowDepth < maxShadowDepth) {
      forEachElementDeep(sr, visit, shadowDepth + 1, maxShadowDepth)
    }
  })
}

/** 深度优先找 #noteContainer，命中即停；避免 getNoteContainerEl 走 `querySelectorAll('*')` 扫整页 */
function findNoteContainerByIdDeep(
  el: Element,
  shadowDepth: number,
  maxDepth: number
): HTMLElement | null {
  if (shadowDepth > maxDepth) return null
  if (el instanceof HTMLElement && el.id === "noteContainer") return el
  for (let i = 0; i < el.children.length; i++) {
    const h = findNoteContainerByIdDeep(el.children[i]!, shadowDepth, maxDepth)
    if (h) return h
  }
  const sr = (el as HTMLElement).shadowRoot
  if (sr && shadowDepth < maxDepth) {
    for (let i = 0; i < sr.children.length; i++) {
      const h = findNoteContainerByIdDeep(sr.children[i]!, shadowDepth + 1, maxDepth)
      if (h) return h
    }
  }
  return null
}

const NOTE_COMMENT_PLACEHOLDER_RE =
  /说点什么|有爱评论|发条评论|发一条|写下你的评论|友善评论|说两句|快来评论|留下你的想法/i

function innerTextCompact(el: Element): string {
  return ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim()
}

function hasVisibleBox(h: HTMLElement): boolean {
  const r = h.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** 同页同 URL 缓存 #noteContainer，fillNoteComment 内会多次调用；换页在 onUrlChange 清空 */
let cachedNoteContainer: { url: string; el: HTMLElement } | null = null

/** 笔记正文容器（部分环境可能在 shadow 内，不单依赖 document.getElementById） */
function getNoteContainerEl(): HTMLElement | null {
  if (cachedNoteContainer && cachedNoteContainer.url === currentUrl && document.contains(cachedNoteContainer.el)) {
    return cachedNoteContainer.el
  }
  cachedNoteContainer = null

  const direct = document.getElementById("noteContainer")
  if (direct) {
    cachedNoteContainer = { url: currentUrl, el: direct }
    return direct
  }
  const byClass = document.querySelector(".note-container") as HTMLElement | null
  if (byClass) {
    cachedNoteContainer = { url: currentUrl, el: byClass }
    return byClass
  }
  const root = document.documentElement
  if (!root) return null
  const hit = findNoteContainerByIdDeep(root, 0, NOTE_COMMENT_MAX_SHADOW_DEPTH)
  if (hit) cachedNoteContainer = { url: currentUrl, el: hit }
  return hit
}

/** #noteContainer 内可见的「发送 / 取消」→ 主评已进入图二展开态（带发送栏） */
function findVisibleSendOrCancelInNoteContainer(): HTMLElement | null {
  const nc = getNoteContainerEl()
  if (!nc) return null
  let found: HTMLElement | null = null
  forEachElementDeep(nc, (el) => {
    if (found) return
    if (!(el instanceof HTMLElement)) return
    if (isInsideListCommentRow(el)) return
    const t = innerTextCompact(el)
    if (t !== "发送" && t !== "取消") return
    if (!hasVisibleBox(el)) return
    found = el
  })
  return found
}

function getEngageBarContentEditEl(): HTMLElement | null {
  const nc = getNoteContainerEl()
  if (!nc) return null
  return (
    (nc.querySelector("div.interactions.engage-bar .input-box .content-edit") as HTMLElement | null) ??
    (nc.querySelector(".engage-bar .input-box .content-edit") as HTMLElement | null)
  )
}

/**
 * 胶囊未点开时：`.content-edit` 里已有 `p.content-input`，但被
 * `div.inner-when-not-active.not-active` + `div.inner` 盖住；此时绝不能往 p 里塞字，必须先点胶囊去 `not-active`。
 */
function isNoteCommentCapsuleOverlayShowing(): boolean {
  const ce = getEngageBarContentEditEl()
  if (!ce) return false
  const shell = ce.querySelector(".inner-when-not-active") as HTMLElement | null
  if (!shell || !shell.classList.contains("not-active")) return false
  if (!hasVisibleBox(shell)) return false
  const inner = shell.querySelector(":scope div.inner") as HTMLElement | null
  return inner != null && hasVisibleBox(inner)
}

/**
 * 主评区是否已展开：有发送/取消，或 .content-edit 区域明显加高（胶囊态较扁，展开后含工具栏更高）。
 */
function isNoteMainCommentComposerExpanded(): boolean {
  if (findVisibleSendOrCancelInNoteContainer()) return true
  const ce = getEngageBarContentEditEl()
  if (!ce || !hasVisibleBox(ce)) return false
  const ch = ce.getBoundingClientRect().height
  if (ch >= 76) return true
  // 扁条但胶囊壳已去掉 not-active → 视为已展开
  if (!isNoteCommentCapsuleOverlayShowing()) {
    const p = ce.querySelector("p.content-input[contenteditable='true']") as HTMLElement | null
    if (p && hasVisibleBox(p) && p.getBoundingClientRect().height > 22) return true
  }
  return false
}

/** 仅在展开态下取主评输入，避免未点开胶囊就往隐藏 contenteditable 里塞字 */
function pickExpandedNoteMainCommentInput(): HTMLElement | null {
  if (!isNoteMainCommentComposerExpanded()) return null
  return pickMainInputDeep()
}

/** 点击胶囊后等待图二：展开 + 可编辑主输入出现 */
async function waitForExpandedNoteCommentInput(timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isNoteMainCommentComposerExpanded()) {
      const input = pickMainInputDeep()
      if (input && !isInsideListCommentRow(input)) return input
    }
    await sleep(55)
  }
  return null
}

/**
 * 用户提供的稳定路径：
 * #noteContainer > .interaction-container > .interactions.engage-bar > … > .input-box > .content-edit > … > div.inner
 */
function findBottomCommentBarByEngagePath(): HTMLElement | null {
  const nc = getNoteContainerEl()
  if (!nc || isInsideListCommentRow(nc)) return null

  const inputBox =
    (nc.querySelector("div.interaction-container div.interactions.engage-bar div.input-box") as HTMLElement | null) ??
    (nc.querySelector("div.interactions.engage-bar div.input-box") as HTMLElement | null) ??
    (nc.querySelector(".interaction-container .interactions.engage-bar .input-box") as HTMLElement | null) ??
    (nc.querySelector(".interactions.engage-bar .input-box") as HTMLElement | null) ??
    (nc.querySelector(".engage-bar .input-box") as HTMLElement | null)

  if (!inputBox || isInsideListCommentRow(inputBox) || !hasVisibleBox(inputBox)) return null

  const contentEdit = inputBox.querySelector(".content-edit") as HTMLElement | null
  if (!contentEdit) return inputBox

  for (const div of Array.from(contentEdit.querySelectorAll(":scope div.inner"))) {
    const h = div as HTMLElement
    const kids = Array.from(h.children)
    if (!kids.some(c => c.tagName === "IMG")) continue
    const span = kids.find(c => c.tagName === "SPAN") as HTMLElement | undefined
    if (!span || !NOTE_COMMENT_PLACEHOLDER_RE.test(innerTextCompact(span))) continue
    if (hasVisibleBox(h)) return h
  }

  const nested = contentEdit.querySelector(":scope > div > div") as HTMLElement | null
  if (nested && hasVisibleBox(nested) && !isInsideListCommentRow(nested)) return nested

  const oneDiv = contentEdit.querySelector(":scope > div") as HTMLElement | null
  if (oneDiv && hasVisibleBox(oneDiv)) return oneDiv

  return hasVisibleBox(contentEdit) ? contentEdit : inputBox
}

function verifyNoteCommentCapsuleShape(h: HTMLElement): boolean {
  const kids = Array.from(h.children)
  if (!kids.some(c => c.tagName === "IMG")) return false
  const span = kids.find(c => c.tagName === "SPAN") as HTMLElement | undefined
  return span != null && NOTE_COMMENT_PLACEHOLDER_RE.test(innerTextCompact(span))
}

/**
 * 只找底栏「胶囊」div.inner（头像 + 说点什么），不回落到整块 .content-edit，避免误点。
 */
function findNoteCommentCapsuleInnerStrict(): HTMLElement | null {
  const nc = getNoteContainerEl()
  if (!nc || isInsideListCommentRow(nc)) return null

  const inputBox =
    (nc.querySelector("div.interaction-container div.interactions.engage-bar div.input-box") as HTMLElement | null) ??
    (nc.querySelector("div.interactions.engage-bar div.input-box") as HTMLElement | null) ??
    (nc.querySelector(".interaction-container .interactions.engage-bar .input-box") as HTMLElement | null) ??
    (nc.querySelector(".interactions.engage-bar .input-box") as HTMLElement | null) ??
    (nc.querySelector(".engage-bar .input-box") as HTMLElement | null)

  if (!inputBox || !hasVisibleBox(inputBox as HTMLElement)) return null
  const contentEdit = inputBox.querySelector(".content-edit") as HTMLElement | null
  if (!contentEdit) return null

  const shell = contentEdit.querySelector(":scope .inner-when-not-active") as HTMLElement | null
  if (shell) {
    const innerInShell = shell.querySelector(":scope div.inner") as HTMLElement | null
    if (
      innerInShell &&
      verifyNoteCommentCapsuleShape(innerInShell) &&
      hasVisibleBox(innerInShell)
    ) {
      return innerInShell
    }
  }

  for (const div of Array.from(contentEdit.querySelectorAll(":scope div.inner"))) {
    const h = div as HTMLElement
    if (!verifyNoteCommentCapsuleShape(h) || !hasVisibleBox(h)) continue
    return h
  }

  const nested = contentEdit.querySelector(":scope > div > div") as HTMLElement | null
  if (nested && verifyNoteCommentCapsuleShape(nested) && hasVisibleBox(nested)) return nested

  return null
}

/**
 * 与真人一致：只点胶囊上「说点什么」附近（elementFromPoint），必要时再点一次整块 inner。
 * 不再连点 .content-edit / .engage-bar，那些容易在展开前抢走焦点导致大框不出现。
 */
async function tryClickCapsuleAsUserWould(inner: HTMLElement): Promise<void> {
  const shell = inner.closest(".inner-when-not-active") as HTMLElement | null
  try {
    inner.scrollIntoView({ block: "nearest", behavior: "instant" })
  } catch {
    /* ignore */
  }
  await sleep(120)

  // Vue 常把展开监听绑在带 not-active 的外壳上，先点外壳再点 inner/文案
  if (shell && shell !== inner && hasVisibleBox(shell) && shell.classList.contains("not-active")) {
    await syntheticClick(shell)
    await sleep(90)
  }

  const r = inner.getBoundingClientRect()
  // 偏右、避开左侧头像，落在占位文案上（与手点习惯一致）
  const cx = Math.min(r.right - 6, Math.max(r.left + r.width * 0.42, r.left + 28))
  const cy = r.top + r.height / 2

  const hit = document.elementFromPoint(cx, cy)
  if (hit instanceof HTMLElement && inner.contains(hit)) {
    await syntheticClick(hit)
    return
  }
  const span = Array.from(inner.children).find(c => c.tagName === "SPAN") as HTMLElement | undefined
  if (span && hasVisibleBox(span)) {
    await syntheticClick(span)
    return
  }
  await syntheticClick(inner)
}

/** 主流程：只点笔记底栏胶囊（图一 → 图二） */
async function tryClickNoteEngageBarPath(): Promise<boolean> {
  const capsule = findNoteCommentCapsuleInnerStrict()
  if (!capsule) {
    const loose = findBottomCommentBarByEngagePath()
    if (!loose) return false
    await tryClickCapsuleAsUserWould(loose)
    return true
  }
  await tryClickCapsuleAsUserWould(capsule)
  return true
}

/** 兜底：多点外层（仅在前述「只点胶囊」多次仍失败时用） */
async function tryClickNoteEngageBarPathAggressive(): Promise<boolean> {
  const target = findBottomCommentBarByEngagePath()
  if (!target) return false
  try {
    target.scrollIntoView({ block: "nearest", behavior: "instant" })
  } catch {
    /* ignore */
  }
  await sleep(100)
  await syntheticClick(target)
  await sleep(220)

  const ce = target.closest(".content-edit") as HTMLElement | null
  if (ce && ce !== target && !isInsideListCommentRow(ce)) {
    const r = ce.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.height < 280) await syntheticClick(ce)
  }
  await sleep(200)

  const ib = target.closest(".input-box") as HTMLElement | null
  if (ib && ib !== target && ib !== ce && !isInsideListCommentRow(ib)) {
    const r = ib.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.height < 280) await syntheticClick(ib)
  }
  await sleep(200)

  const engage =
    (target.closest(".interactions.engage-bar") as HTMLElement | null) ??
    (target.closest(".engage-bar") as HTMLElement | null)
  if (engage && !isInsideListCommentRow(engage)) {
    const r = engage.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.height < 320) await syntheticClick(engage)
  }
  return true
}

function collectStructuredInnerBarCandidates(root: Document | HTMLElement): HTMLElement[] {
  const candidates: HTMLElement[] = []
  const vh = window.innerHeight || 800
  const vw = window.innerWidth || 400
  forEachElementDeep(root, (el) => {
    const h = el as HTMLElement
    if (h.tagName !== "DIV") return
    if (isInsideListCommentRow(h)) return
    if (!h.classList.contains("inner")) return
    const kids = Array.from(h.children)
    const hasImg = kids.some(c => c.tagName === "IMG")
    const span = kids.find(c => c.tagName === "SPAN") as HTMLElement | undefined
    if (!hasImg || !span) return
    if (!NOTE_COMMENT_PLACEHOLDER_RE.test(innerTextCompact(span))) return
    const r = h.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    if (r.height > 200 || r.width > vw * 0.98) return
    if (r.bottom < vh * 0.38) return
    candidates.push(h)
  })
  return candidates
}

/**
 * 当前版笔记底栏：`div.inner` > `img`（头像）+ `span`「说点什么...」
 * 优先在 #noteContainer 内找，减少整页 `*` 扫描。
 */
function findBottomCommentBarStructuredDeep(): HTMLElement | null {
  const pickLowest = (candidates: HTMLElement[]): HTMLElement | null => {
    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      return rb.top + rb.height / 2 - (ra.top + ra.height / 2)
    })
    return candidates[0]
  }
  const nc = getNoteContainerEl()
  if (nc) {
    const fromNc = pickLowest(collectStructuredInnerBarCandidates(nc))
    if (fromNc) return fromNc
  }
  return pickLowest(collectStructuredInnerBarCandidates(document))
}

function collectPlaceholderTriggerCandidates(root: Document | HTMLElement): HTMLElement[] {
  const candidates: HTMLElement[] = []
  forEachElementDeep(root, (el) => {
    const h = el as HTMLElement
    if (h.tagName === "SCRIPT" || h.tagName === "STYLE" || h.tagName === "SVG") return
    if (isInsideListCommentRow(h)) return
    const it = innerTextCompact(h)
    if (it.length === 0 || it.length > 100) return
    if (!NOTE_COMMENT_PLACEHOLDER_RE.test(it)) return
    const r = h.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    candidates.push(h)
  })
  return candidates
}

/**
 * 在含 shadow 的树内找底部主评入口：用 innerText 避免 textContent 把子树拼成超长串误判。
 * 优先 #noteContainer，再整页。
 */
function findBottomCommentTriggerDeep(): HTMLElement | null {
  const refineBest = (candidates: HTMLElement[]): HTMLElement | null => {
    if (candidates.length === 0) return null
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const ca = ra.top + ra.height / 2
      const cb = rb.top + rb.height / 2
      return cb - ca
    })
    let best = candidates[0]
    for (let up = 0; up < 6; up++) {
      const parent = best.parentElement as HTMLElement | null
      if (!parent || parent === document.body || isInsideListCommentRow(parent)) break
      const pit = innerTextCompact(parent)
      if (NOTE_COMMENT_PLACEHOLDER_RE.test(pit) && pit.length < 120) {
        const pr = parent.getBoundingClientRect()
        if (pr.height < 140) best = parent
        else break
      } else break
    }
    return best
  }
  const nc = getNoteContainerEl()
  if (nc) {
    const fromNc = refineBest(collectPlaceholderTriggerCandidates(nc))
    if (fromNc) return fromNc
  }
  return refineBest(collectPlaceholderTriggerCandidates(document))
}

/** 在视口底部少量采样点上找可点击条（兜底；网格过大会拖慢主线程） */
async function tryClickNoteCommentBarByCoordinates(): Promise<boolean> {
  const w = window.innerWidth
  const vh = window.innerHeight
  const ys = [vh - 8, vh - 28, vh - 52, vh - 72]
  const xs = [w * 0.28, w * 0.5, w * 0.72]

  const tryHit = async (hit: Element | null): Promise<boolean> => {
    if (!hit) return false
    let el: Element | null = hit
    for (let i = 0; i < 22 && el; i++) {
      if (isInsideListCommentRow(el)) return false
      const h = el as HTMLElement
      const st = window.getComputedStyle(h)
      if (st.pointerEvents === "none") {
        el = el.parentElement
        continue
      }
      const it = innerTextCompact(h)
      if (NOTE_COMMENT_PLACEHOLDER_RE.test(it)) {
        await syntheticClick(h)
        return true
      }
      const r = h.getBoundingClientRect()
      const wideBar = r.width > w * 0.26 && r.height > 16 && r.height < 110 && r.bottom > vh - 100
      if (wideBar && (it.length === 0 || it.length < 48)) {
        await syntheticClick(h)
        return true
      }
      el = el.parentElement
    }
    return false
  }

  for (const y of ys) {
    for (const x of xs) {
      const hit = document.elementFromPoint(x, y)
      if (await tryHit(hit)) return true
    }
  }
  return false
}

async function syntheticClick(el: HTMLElement): Promise<void> {
  const r = el.getBoundingClientRect()
  const cx = r.left + Math.min(Math.max(r.width / 2, 8), r.width - 8)
  const cy = r.top + r.height / 2
  const opts: MouseEventInit = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }
  const ptr: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: cx,
    clientY: cy,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  }
  el.dispatchEvent(new PointerEvent("pointerdown", ptr))
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  await sleep(25)
  el.dispatchEvent(new PointerEvent("pointerup", ptr))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.dispatchEvent(new MouseEvent("click", opts))
  el.click()
}

function writeToContentEditable(el: HTMLElement, text: string) {
  el.focus()
  el.textContent = ""
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data: text,
      bubbles: true,
      cancelable: true,
    })
  )
  document.execCommand("insertText", false, text)
  if (!el.textContent) {
    el.textContent = text
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  el.focus()
}

// 填入回复：找到对应评论节点 → 点击"回复"按钮 → 等输入框弹出 → 填入文字
async function fillReply(platformCommentId: string, text: string): Promise<ContentFillResult> {
  const nodes = Array.from(document.querySelectorAll(SELECTORS.commentList))
  const targetNode = nodes.find(n => extractCommentId(n) === platformCommentId)

  if (!targetNode) {
    return { ok: false, error: "comment_not_found" }
  }

  const replyBtn = (
    targetNode.querySelector(".reply.icon-container") ||
    Array.from(targetNode.querySelectorAll("div, span")).find(el => el.textContent?.trim() === "回复")
  ) as HTMLElement | undefined

  if (!replyBtn) {
    return { ok: false, error: "reply_btn_not_found" }
  }

  replyBtn.click()

  const input = await waitForElement('p.content-input[contenteditable="true"]', 2000)

  if (!input) {
    return { ok: false, error: "input_not_found" }
  }

  writeToContentEditable(input as HTMLElement, text)
  return { ok: true }
}

/** 主评输入框：light + shadow（按优先级取最像「主评」的控件） */
function pickMainInputDeep(): HTMLElement | null {
  const nc = getNoteContainerEl()
  const engageCe = getEngageBarContentEditEl()
  const skipEngagePBecauseCapsule =
    Boolean(engageCe) && isNoteCommentCapsuleOverlayShowing()

  if (nc && !skipEngagePBecauseCapsule) {
    const scoped = [
      ".interactions.engage-bar .input-box .content-edit p.content-input[contenteditable='true']",
      ".engage-bar .input-box .content-edit p.content-input[contenteditable='true']",
      ".interactions.engage-bar p.content-input[contenteditable='true']",
      ".engage-bar p.content-input[contenteditable='true']",
    ]
    for (const sel of scoped) {
      const el = nc.querySelector(sel) as HTMLElement | null
      if (el && !isInsideListCommentRow(el) && hasVisibleBox(el)) return el
    }
  }

  let best: HTMLElement | null = null
  let bestPri = 0
  const consider = (h: HTMLElement) => {
    if (isInsideListCommentRow(h)) return
    const r = h.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return

    let pri = 0
    if (h.matches?.('p.content-input[contenteditable="true"]')) {
      if (engageCe && engageCe.contains(h) && isNoteCommentCapsuleOverlayShowing()) pri = 0
      else pri = 5
    } else if (h.getAttribute?.("contenteditable") === "true") {
      const cls = (h.className?.toString?.() ?? "").toLowerCase()
      if (cls.includes("content-input")) pri = 4
      else if (cls.includes("comment") && cls.includes("input")) pri = 3
      else if (cls.includes("comment") || cls.includes("input")) pri = 2
    } else if (h.tagName === "TEXTAREA") {
      const ph = h.getAttribute("placeholder") ?? ""
      if (NOTE_COMMENT_PLACEHOLDER_RE.test(ph) || ph.includes("评论")) pri = 3
    }

    if (pri > bestPri) {
      bestPri = pri
      best = h
    }
  }

  if (nc) forEachElementDeep(nc, (el) => consider(el as HTMLElement))
  // 高置信已在 noteContainer 找到则不再扫整页
  if (bestPri < 5) {
    forEachElementDeep(document, (el) => {
      const h = el as HTMLElement
      if (nc?.contains(h)) return
      consider(h)
    })
  }
  return best
}

/** 填入笔记下方「主评论」输入框（非回复某条评论） */
async function fillNoteComment(text: string): Promise<ContentFillResult> {
  /** 仅失败时便于侧栏/控制台区分卡在哪一步（主路径成功不返回 step） */
  let lastPhase = "start"

  const tryWrite = (el: HTMLElement): boolean => {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const ta = el as HTMLTextAreaElement | HTMLInputElement
      ta.focus()
      ta.value = ""
      ta.value = text
      ta.dispatchEvent(new Event("input", { bubbles: true }))
      ta.dispatchEvent(new Event("change", { bubbles: true }))
      ta.focus()
      return true
    }
    writeToContentEditable(el, text)
    return true
  }

  /** 触发后必须等图二展开再取节点，禁止用「未展开也能 match 到的」contenteditable */
  const waitForInputAfterTrigger = (timeoutMs: number) => waitForExpandedNoteCommentInput(timeoutMs)

  const waitForInputFinalFallback = async (): Promise<HTMLElement | null> => {
    let input = await waitForExpandedNoteCommentInput(3200)
    if (input) return input
    input = (await waitForElement('p.content-input[contenteditable="true"]', 600)) as HTMLElement | null
    if (input && !isInsideListCommentRow(input) && isNoteMainCommentComposerExpanded()) return input
    const deadline = Date.now() + 1400
    while (Date.now() < deadline) {
      const p = pickMainInputDeep()
      if (p && !isInsideListCommentRow(p) && isNoteMainCommentComposerExpanded()) return p
      await sleep(60)
    }
    return null
  }

  // 仅当已是图二展开态才直接写入（避免胶囊态误写）
  let input = pickExpandedNoteMainCommentInput()
  if (input) {
    tryWrite(input)
    return { ok: true }
  }

  lastPhase = "already_collapsed_try_engage"

  // 0a-0) #noteContainer … engage-bar … input-box … content-edit（控制台给出的选择器链）
  if (await tryClickNoteEngageBarPath()) {
    await sleep(480)
    input = await waitForInputAfterTrigger(2400)
    if (input) {
      tryWrite(input)
      return { ok: true }
    }
    lastPhase = "after_engage_path_wait_empty"
  }

  // 0a) 结构匹配底栏：div.inner > img + span「说点什么...」
  lastPhase = "try_structured_inner_bar"
  const structuredBar = findBottomCommentBarStructuredDeep()
  if (structuredBar) {
    try {
      structuredBar.scrollIntoView({ block: "nearest", behavior: "instant" })
    } catch {
      /* ignore */
    }
    await sleep(100)
    await syntheticClick(structuredBar)
    await sleep(200)
    const outer = structuredBar.parentElement as HTMLElement | undefined
    if (outer && !isInsideListCommentRow(outer)) {
      const or = outer.getBoundingClientRect()
      if (or.height > 0 && or.height < 200 && or.width > 80) await syntheticClick(outer)
    }
    await sleep(450)
    input = await waitForInputAfterTrigger(2200)
    if (input) {
      tryWrite(input)
      return { ok: true }
    }
    lastPhase = "after_structured_click_wait_empty"
  }

  // 0) 坐标兜底（第一轮）：占位在伪元素等场景
  lastPhase = "coordinate_round_1"
  await tryClickNoteCommentBarByCoordinates()
  await sleep(450)
  input = await waitForInputAfterTrigger(2000)
  if (input) {
    tryWrite(input)
    return { ok: true }
  }
  lastPhase = "after_coordinate_round_1_wait_empty"

  // 1) 文案匹配（含 shadow）+ 合成点击
  lastPhase = "try_placeholder_text_trigger"
  const trigger = findBottomCommentTriggerDeep()
  if (trigger) {
    try {
      trigger.scrollIntoView({ block: "nearest", behavior: "instant" })
    } catch {
      /* ignore */
    }
    await sleep(120)
    await syntheticClick(trigger)
    await sleep(450)
    const par = trigger.parentElement as HTMLElement | undefined
    if (par && !isInsideListCommentRow(par) && NOTE_COMMENT_PLACEHOLDER_RE.test(innerTextCompact(par))) {
      await syntheticClick(par)
      await sleep(350)
    }
  }

  input = await waitForInputAfterTrigger(2600)
  if (input) {
    tryWrite(input)
    return { ok: true }
  }
  lastPhase = "after_text_trigger_wait_empty"

  // 2) aggressive + 单次坐标兜底（合并原 2/3 轮坐标，减少重复 elementFromPoint 网格）
  lastPhase = "aggressive_then_coordinate"
  if (await tryClickNoteEngageBarPathAggressive()) await sleep(450)
  const t2 = findBottomCommentTriggerDeep()
  if (t2) {
    await syntheticClick(t2)
    await sleep(500)
  }
  await tryClickNoteCommentBarByCoordinates()
  await sleep(400)

  const commentSec =
    document.querySelector("#note-comment") ||
    document.querySelector("[class*='comment-container']") ||
    document.querySelector("[class*='interactions']") ||
    document.querySelector("[class*='engage']")
  try {
    ;(commentSec as HTMLElement)?.scrollIntoView({ block: "end", behavior: "instant" })
  } catch {
    /* ignore */
  }
  await sleep(300)
  if (await tryClickNoteEngageBarPathAggressive()) await sleep(400)
  const t3s = findBottomCommentBarStructuredDeep()
  if (t3s) await syntheticClick(t3s)
  await sleep(250)
  const t3 = findBottomCommentTriggerDeep()
  if (t3) await syntheticClick(t3)
  await sleep(500)
  lastPhase = "final_fallback_wait"
  input = await waitForInputFinalFallback()

  if (!input) return { ok: false, error: "note_input_not_found", step: lastPhase }

  tryWrite(input)
  return { ok: true }
}

function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  return new Promise(resolve => {
    const el = document.querySelector(selector)
    if (el) return resolve(el)

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector)
      if (found) {
        observer.disconnect()
        resolve(found)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => {
      observer.disconnect()
      resolve(null)
    }, timeoutMs)
  })
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// 滚动联动：左侧小红书评论滚动时，找到视口中央那条评论，通知右侧侧边栏同步滚动
let scrollSyncTick: number | null = null
let lastSentId: string | null = null

function findCommentAtViewportCenter(): string | null {
  const nodes = Array.from(document.querySelectorAll(SELECTORS.commentList))
  if (nodes.length === 0) return null

  const viewportCenter = window.innerHeight / 2
  let bestId: string | null = null
  let bestDist = Infinity

  nodes.forEach((el) => {
    const rect = el.getBoundingClientRect()
    const elCenter = rect.top + rect.height / 2
    const dist = Math.abs(elCenter - viewportCenter)
    if (dist < bestDist) {
      bestDist = dist
      bestId = extractCommentId(el)
    }
  })
  return bestId
}

function onPageScroll() {
  if (scrollSyncTick != null) return
  scrollSyncTick = window.requestAnimationFrame(() => {
    scrollSyncTick = null
    const id = findCommentAtViewportCenter()
    if (id && id !== lastSentId) {
      lastSentId = id
      chrome.runtime.sendMessage({
        type: "SCROLL_TO_COMMENT",
        payload: { platformCommentId: id },
      }).catch(() => {})
    }
  })
}

function getScrollParent(el: Element): Element | typeof window {
  let p: Element | null = el.parentElement
  while (p) {
    const style = getComputedStyle(p)
    const overflow = style.overflowY
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return p
    p = p.parentElement
  }
  return window
}

let scrollTarget: Element | typeof window | null = null
let scrollTargetExtra: Element | null = null   // 可滚动父级（需单独 cleanup）

function setupScrollSync() {
  lastSentId = null

  // cleanup 上一次注册的监听
  if (scrollTarget) {
    scrollTarget.removeEventListener("scroll", onPageScroll, true)
    scrollTarget = null
  }
  if (scrollTargetExtra) {
    scrollTargetExtra.removeEventListener("scroll", onPageScroll, true)
    scrollTargetExtra = null
  }

  // 始终在捕获阶段监听 window，覆盖所有滚动容器（含 overflow:hidden 的 SPA 容器）
  window.addEventListener("scroll", onPageScroll, true)
  scrollTarget = window

  // 同时尝试找到最近的可滚动父级，避免遗漏内部容器滚动
  const firstComment = document.querySelector(SELECTORS.commentList)
  if (firstComment) {
    const parent = getScrollParent(firstComment)
    if (parent !== window) {
      parent.addEventListener("scroll", onPageScroll, true)
      scrollTargetExtra = parent as Element
    }
  }

  // 初始触发一次，让侧边栏对齐当前第一条
  onPageScroll()
}

// 返回当前页面全部评论（按 DOM 顺序），包含 platformCommentId/authorName/content
async function getAllPageComments(): Promise<ScrapedComment[]> {
  await loadSelfNicknameOverride()
  const nodes = document.querySelectorAll(SELECTORS.commentList)
  const results: ScrapedComment[] = []
  nodes.forEach((node) => {
    const c = parseCommentNode(node)
    if (c) results.push(c)
  })
  return results
}

// 帖子标题与正文、当前 URL，用于 AI 回复 / 笔记跟评
function getPostContent(): { postTitle: string; postContent: string; postUrl: string } {
  let postTitle = ""
  let postContent = ""
  const postUrl = typeof location !== "undefined" ? location.href : ""
  try {
    const state = (window as unknown as { __INITIAL_STATE__?: Record<string, unknown> }).__INITIAL_STATE__
    if (state) {
      const note = (state.note as Record<string, unknown>) ?? (state.noteDetail as Record<string, unknown>)
      if (note) {
        postTitle = String(note.title ?? note.noteTitle ?? "").trim()
        postContent = String(note.desc ?? note.content ?? note.noteContent ?? "").trim()
      }
    }
  } catch {
    // ignore
  }
  if (!postTitle) {
    const el = document.querySelector('[class*="title"]') ?? document.querySelector("h1")
    postTitle = (el?.textContent ?? "").trim().slice(0, 200)
  }
  if (!postContent) {
    const el = document.querySelector('[class*="desc"]') ?? document.querySelector('[class*="content"]')
    postContent = (el?.textContent ?? "").trim().slice(0, 2000)
  }
  return { postTitle, postContent, postUrl }
}

// 监听来自 background 的填入指令与数据查询
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FILL_REPLY") {
    const { platformCommentId, text } = (message as { payload?: { platformCommentId?: string; text?: string } })
      .payload ?? {}
    void fillReply(String(platformCommentId ?? ""), String(text ?? ""))
      .then(sendResponse)
      .catch((e) => {
        console.error("[CommentCopilot][xhs] FILL_REPLY", e)
        sendResponse({ ok: false, error: String(e) })
      })
    return true
  }
  if (message.type === "FILL_NOTE_COMMENT") {
    const { text } = message.payload as { text: string }
    void fillNoteComment(text)
      .then(sendResponse)
      .catch((e) => {
        console.error("[CommentCopilot][xhs] FILL_NOTE_COMMENT", e)
        sendResponse({ ok: false, error: String(e), step: "exception" })
      })
    return true
  }
  if (message.type === "GET_ALL_PAGE_COMMENTS") {
    void getAllPageComments()
      .then(sendResponse)
      .catch((e) => {
        console.error("[CommentCopilot][xhs] GET_ALL_PAGE_COMMENTS", e)
        sendResponse([])
      })
    return true
  }
  if (message.type === "GET_POST_CONTENT") {
    sendResponse(getPostContent())
    return false
  }
})

// 启动：500ms 后开始扫描（MutationObserver 会持续捕获后续加载的评论）
setTimeout(() => {
  void initialScan()
  observer.observe(document.body, { childList: true, subtree: true })
  setTimeout(setupScrollSync, 500)
}, 500)
