/**
 * 抖音 Web 视频页 content script：采集评论、帖子摘要、滚动联动侧栏、FILL_REPLY、FILL_NOTE_COMMENT（视频跟评→底部主评框）。
 * DOM 依赖 data-e2e / class / Draft.js（`public-DraftEditor-content`）等，改版时需调整选择器。
 * 「回复」三态说明见文件内 `侧栏「回复」` 注释块。
 */
import type { PlasmoCSConfig } from "plasmo"

import {
  canonicalDouyinPostUrl,
  isDouyinContentTargetUrl,
  isDouyinVideoPageUrl,
  YANLING_DOUYIN_SELF_NICK_STORAGE_KEY,
} from "../constants"
import { createCommentIngestDeduper, createThrottledScan, simpleHash } from "./shared/platform-content-utils"

export const config: PlasmoCSConfig = {
  matches: ["https://www.douyin.com/*"],
  run_at: "document_idle",
  all_frames: false,
}

interface ScrapedComment {
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
  postUrl: string
  /** 该条评论的 replyContainer 下已出现当前登录用户的子回复（页内已发），侧栏应显示已回复 */
  domSelfReplied?: boolean
}

/** 精选/弹层页 DOM 极大，过小会导致评论面板内的 input 根本扫不到 → editables: 0 */
const DEEP_QUERY_MAX_ROOTS = 48_000

/** 从评论行向上做子树扫描时的节点预算（与全站「按 root 计数」的深搜无关） */
const DOUYIN_SUBTREE_EDITABLE_MAX_NODES = 52_000

function querySelectorAllDeepFromRoot(
  start: Document | ShadowRoot,
  selector: string,
  maxRoots: number
): Element[] {
  const results: Element[] = []
  const queue: (Document | ShadowRoot)[] = [start]
  const seen = new Set<Document | ShadowRoot>()
  let n = 0
  while (queue.length && n < maxRoots) {
    const root = queue.shift()!
    if (seen.has(root)) continue
    seen.add(root)
    n++
    root.querySelectorAll(selector).forEach((el) => results.push(el))
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) queue.push(el.shadowRoot)
    })
  }
  return results
}

function querySelectorAllDeep(selector: string): Element[] {
  return querySelectorAllDeepFromRoot(document, selector, DEEP_QUERY_MAX_ROOTS)
}

/** 与 ingest / DB 对齐的帖子 URL（modal_id → /video/id） */
function ingestPostUrl(): string {
  return canonicalDouyinPostUrl(location.href)
}

/** 零宽字符：抖音 DOM 里偶发插在昵称与省略号之间，会导致基于昵称的正则匹配失败 */
function stripZeroWidthAndNormalizeSpaces(s: string): string {
  return s
    .replace(/[\u200b-\u200d\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** 省略号片段：ASCII 多点、Unicode …、全角 ． 等 */
const DOUYIN_ELLIPSIS = "(?:\\.{2,}|[\\u2026…．⋯﹒｡]+)"

/**
 * 抖音评论区常把昵称截断为「星夜...」并与正文拼在同一容器内。
 * 注意：JS 里即使用 u 标志，\\w 也不包含中文，昵称匹配必须显式带 \\u4e00-\\u9fff。
 */
function stripDouyinAuthorPrefixFromContent(content: string, authorName: string): string {
  const c = stripZeroWidthAndNormalizeSpaces(content)
  const name = stripZeroWidthAndNormalizeSpaces(authorName.replace(/^@\s*/, ""))
  if (!name || name === "未知用户") return c

  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const esc = escapeRe(name)
  const gap = "(?:\\s|[\\u200b-\\u200d\\uFEFF])*"

  // 1) 完整昵称 + 可选零宽/空白 + 省略号 + 正文
  let rest = c.replace(new RegExp(`^\\s*${esc}${gap}${DOUYIN_ELLIPSIS}\\s*`, "u"), "").trim()
  if (rest.length >= 2) return rest

  // 2) 完整昵称 + 空白 + 正文（无省略号）
  rest = c.replace(new RegExp(`^\\s*${esc}\\s+`), "").trim()
  if (rest.length >= 2 && rest !== c) return rest

  // 3) authorName 已带「星夜...」：再按去掉尾省略后的纯昵称剥一层
  const base = name.replace(/(?:[.…．⋯﹒\s]|\u2026)+$/u, "").trim()
  if (base.length >= 1 && base !== name) {
    const escB = escapeRe(base)
    rest = c.replace(new RegExp(`^\\s*${escB}${gap}${DOUYIN_ELLIPSIS}\\s*`, "u"), "").trim()
    if (rest.length >= 2) return rest
  }

  // 4) 省略号紧贴昵称（无空白）
  if (name.length >= 2) {
    rest = c.replace(new RegExp(`^\\s*${esc}${DOUYIN_ELLIPSIS}\\s*`, "u"), "").trim()
    if (rest.length >= 2 && rest !== c) return rest
  }

  return c
}

/**
 * 不依赖 authorName：匹配「1～28 个常见昵称字符 + 省略号」行首（修复 \\w 不含中文导致的漏剥）。
 * 若误伤「哈哈...」类评论，可再收紧条件。
 */
function stripDouyinLineHeadTruncatedNickname(content: string): string {
  const c = stripZeroWidthAndNormalizeSpaces(content)
  const nick = "[\\u4e00-\\u9fffA-Za-z0-9_.·@%-]{1,28}"
  const gap = "(?:\\s|[\\u200b-\\u200d\\uFEFF])*"
  const re = new RegExp(`^${nick}${gap}${DOUYIN_ELLIPSIS}\\s*`, "u")
  const rest = c.replace(re, "").trim()
  if (rest.length >= 2 && rest !== c) return rest
  return c
}

function sanitizeDouyinCommentBody(content: string, authorName: string): string {
  let out = stripZeroWidthAndNormalizeSpaces(content)
  out = stripDouyinAuthorPrefixFromContent(out, authorName)
  out = stripDouyinLineHeadTruncatedNickname(out)
  return out
}

/**
 * 宽选择器或整卡 clone 会把「时间·地点 + 点赞数 + 分享/回复」拼进正文（侧栏出现 1月前·广西4012分享回复）。
 * 从**最后一次**出现相对时间起若整段为列表元数据，则剥掉。
 */
function stripDouyinAppendedListMeta(text: string): string {
  const s0 = text.replace(/\s+/g, " ").trim()
  if (!s0) return s0
  let lastIdx = -1
  const reList: RegExp[] = [/\d{1,4}[秒分钟小时天周月年]前/g, /刚刚/g]
  for (const re of reList) {
    let m: RegExpExecArray | null
    const r = new RegExp(re.source, "gu")
    while ((m = r.exec(s0)) !== null) {
      if (m.index > lastIdx) lastIdx = m.index
    }
  }
  if (lastIdx < 0) return s0
  const tail = s0.slice(lastIdx).replace(/\s/g, "")
  // 例：1月前·广西4012分享回复、1月前·江苏160分享回复展开7条回复、刚刚分享
  const tailLooksMeta =
    /^(?:\d{1,4}[秒分钟小时天周月年]前|刚刚)(?:·[^\d]+)?\d*(?:分享|回复|点赞)*(?:展开\d{1,4}条回复)?(?:收起)?$/u.test(
      tail,
    )
  const base = tailLooksMeta ? s0.slice(0, lastIdx).trim() : s0
  /** 宽选区常把「展开N条回复 / 收起」粘在时间统计后 */
  return base
    .replace(/\s*展开\d{1,4}条回复\s*$/u, "")
    .replace(/\s*收起\s*$/u, "")
    .trim()
}

/**
 * 在单个容器内穿透 Shadow DOM 查找（评论行内部常有 shadow，普通 querySelector 拿不到昵称）。
 * 子节点**逆序入栈**，弹出顺序 = **文档顺序**（先左先上）；旧版「正序入栈」会先命中右侧统计条 → 正文变「4012分享回复」、作者链错成未知用户。
 * 正文采集请用 `querySelectorAllDeepWithinDocOrder`，避免宽泛 selector 先命中昵称区。
 */
function querySelectorDeepWithin(container: Element, selector: string): Element | null {
  try {
    if (container.matches(selector)) return container
  } catch {
    /* 部分 selector 不能用于 matches */
  }
  const stack: (Element | ShadowRoot)[] = []
  if (container.shadowRoot) stack.push(container.shadowRoot)
  for (let i = container.children.length - 1; i >= 0; i--) stack.push(container.children[i]!)
  while (stack.length) {
    const n = stack.pop()!
    if (n instanceof Element) {
      try {
        if (n.matches(selector)) return n
      } catch {
        /* ignore */
      }
      if (n.shadowRoot) stack.push(n.shadowRoot)
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!)
    } else {
      const sr = n as ShadowRoot
      for (let i = sr.children.length - 1; i >= 0; i--) stack.push(sr.children[i] as Element)
    }
  }
  return null
}

/** 文档序（前序）全量收集；用于正文，避免「只取第一个匹配」时命中昵称区等误匹配 */
function querySelectorAllDeepWithinDocOrder(container: Element, selector: string): Element[] {
  const out: Element[] = []
  const visit = (el: Element) => {
    try {
      if (el.matches(selector)) out.push(el)
    } catch {
      /* 部分 selector 不能用于 matches */
    }
    if (el.shadowRoot) {
      for (const ch of el.shadowRoot.children) visit(ch as Element)
    }
    for (const ch of el.children) visit(ch)
  }
  try {
    if (container.matches(selector)) out.push(container)
  } catch {
    /* ignore */
  }
  if (container.shadowRoot) {
    for (const ch of container.shadowRoot.children) visit(ch as Element)
  }
  for (const ch of container.children) visit(ch)
  return out
}

/** 昵称/头像条内的节点常被宽泛 class 误当成「正文」→ 侧栏正文=昵称 */
function isInsideDouyinCommentAuthorStrip(el: Element): boolean {
  return Boolean(el.closest(".comment-item-info-wrap, [class*='comment-item-info-wrap']"))
}

/** 采集到的串整段就是展示昵称（无正文） */
function douyinTextLooksLikeAuthorOnly(t: string, authorName: string): boolean {
  const tn = stripZeroWidthAndNormalizeSpaces(t)
  const an = stripZeroWidthAndNormalizeSpaces(authorName.replace(/^@\s*/, ""))
  if (!an || tn.length < 1) return false
  if (tn === an) return true
  if (tn === `@${an}`) return true
  return false
}

/** 统计行纯文：点赞数 + 分享/回复，不能当评论正文（勿过宽，避免误伤正常句） */
function douyinTextLooksLikeStatsRowOnly(t: string): boolean {
  const s = t.replace(/\s+/g, "").trim()
  if (s.length > 36) return false
  if (/^\d{1,10}(?:分享|回复|点赞)+$/u.test(s)) return true
  if (/^(?:分享|回复|点赞){1,6}$/u.test(s)) return true
  return false
}

/** 宿主上 `textContent` 常不含 open shadow 内文案 → 侧栏整条被判空 */
function douyinTextContentIncludingOpenShadow(el: Element | null): string {
  if (!el) return ""
  const visit = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
    if (!(node instanceof Element)) return ""
    let s = ""
    for (const ch of node.childNodes) s += visit(ch)
    if (node.shadowRoot) {
      for (const ch of node.shadowRoot.childNodes) s += visit(ch)
    }
    return s
  }
  return visit(el).replace(/\s+/g, " ").trim()
}

let currentUrl = typeof location !== "undefined" ? location.href : ""

// ─── 过滤当前登录用户自己的评论（昵称补充 + 页内 sec_uid 兜底）────────────────
function douyinNormalizeDisplayName(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

/** 列表展示名可能被截断，与灵主填写略不一致时仍判为本人 */
function douyinNicknamesLikelySame(authorName: string, selfNick: string): boolean {
  const a = douyinNormalizeDisplayName(authorName)
  const b = douyinNormalizeDisplayName(selfNick)
  if (a === b) return true
  if (a.length < 2 || b.length < 2) return false
  const shorter = a.length <= b.length ? a : b
  const longer = a.length > b.length ? a : b
  if (shorter.length >= 5 && longer.startsWith(shorter)) return true
  return false
}

/** 评论/主页链接里 `/user/` 后的路径段（常为 sec_uid 形态，如 MS4wLjAB…） */
function douyinProfileIdFromUserHref(href: string): string | null {
  if (!href || !href.includes("/user/")) return null
  try {
    const normalized = href.replace(/^\/\//, "https://").trim()
    const u = normalized.startsWith("http")
      ? new URL(normalized)
      : new URL(normalized, "https://www.douyin.com")
    const segs = u.pathname.split("/").filter(Boolean)
    const i = segs.indexOf("user")
    if (i >= 0 && segs[i + 1]) {
      const id = decodeURIComponent(segs[i + 1]!)
      return id.length >= 12 ? id : null
    }
  } catch {
    const m = href.match(/\/user\/([^/?#]+)/)
    if (m?.[1]) {
      const id = decodeURIComponent(m[1])
      return id.length >= 12 ? id : null
    }
  }
  return null
}

function douyinAuthorProfileIdFromAuthorEl(authorEl: Element | null): string | null {
  if (!authorEl) return null
  const a =
    authorEl instanceof HTMLAnchorElement && (authorEl.getAttribute("href") ?? "").includes("/user/")
      ? authorEl
      : authorEl.closest('a[href*="/user/"]')
  if (!a) return null
  return douyinProfileIdFromUserHref(a.getAttribute("href") ?? "")
}

/** 顶栏通常只有当前账号一个 /user/ 主页链，可与评论作者链比对（视频作者在左栏，一般不在 header 内） */
function tryGetDouyinLoggedInProfileIdFromHeader(): string | null {
  const ids = new Set<string>()
  const scan = (root: Element) => {
    root.querySelectorAll('a[href*="/user/"]').forEach((el) => {
      const href = el.getAttribute("href") ?? ""
      const id = douyinProfileIdFromUserHref(href)
      if (id && /^MS4wLj/i.test(id) && id.length >= 20) ids.add(id)
    })
  }
  document.querySelectorAll("header").forEach(scan)
  if (ids.size === 0) {
    document.querySelectorAll('[class*="Header"], [class*="headerBar"], [class*="navigation"]').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.top <= 8 && r.height > 20 && r.height < 180) scan(el)
    })
  }
  if (ids.size !== 1) return null
  return [...ids][0] ?? null
}

/** 内联 JSON 里 is_login + sec_uid（兜底，与顶栏二选一） */
function tryParseDouyinLoggedInProfileIdFromScripts(): string | null {
  for (const script of document.querySelectorAll("script")) {
    const t = script.textContent ?? ""
    if (t.length < 600 || t.length > 8e6) continue
    const head = t.slice(0, 120_000)
    if (!/"is_login"\s*:\s*true|"isLogin"\s*:\s*true/.test(head)) continue
    const m = head.match(/"sec_uid"\s*:\s*"(MS4wLjAB[A-Za-z0-9_-]{10,900})"/)
    if (m?.[1]) return m[1]
  }
  return null
}

const DOUYIN_LOGGED_IN_PROFILE_ID_TTL_MS = 45_000
let cachedDouyinLoggedInProfileId: string | null = null
let cachedDouyinLoggedInProfileIdFetchedAt = 0

function refreshDouyinLoggedInProfileId(): void {
  const now = Date.now()
  if (
    cachedDouyinLoggedInProfileId &&
    now - cachedDouyinLoggedInProfileIdFetchedAt < DOUYIN_LOGGED_IN_PROFILE_ID_TTL_MS
  ) {
    return
  }
  cachedDouyinLoggedInProfileIdFetchedAt = now
  cachedDouyinLoggedInProfileId =
    tryGetDouyinLoggedInProfileIdFromHeader() || tryParseDouyinLoggedInProfileIdFromScripts() || null
}

function clearDouyinLoggedInProfileIdCache(): void {
  cachedDouyinLoggedInProfileId = null
  cachedDouyinLoggedInProfileIdFetchedAt = 0
}

let cachedDouyinSelfNicknameOverride: string | null = null

function loadDouyinSelfNicknameOverride(): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage?.local) {
        cachedDouyinSelfNicknameOverride = null
        resolve()
        return
      }
      chrome.storage.local.get([YANLING_DOUYIN_SELF_NICK_STORAGE_KEY], (r) => {
        const v = r[YANLING_DOUYIN_SELF_NICK_STORAGE_KEY]
        cachedDouyinSelfNicknameOverride = typeof v === "string" && v.trim() ? v.trim() : null
        resolve()
      })
    } catch {
      cachedDouyinSelfNicknameOverride = null
      resolve()
    }
  })
}

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[YANLING_DOUYIN_SELF_NICK_STORAGE_KEY]) return
    const nv = changes[YANLING_DOUYIN_SELF_NICK_STORAGE_KEY].newValue
    cachedDouyinSelfNicknameOverride = typeof nv === "string" && nv.trim() ? nv.trim() : null
  })
}

/**
 * 是否当前登录用户自己的评论：
 * 1) 本机存储里曾保存的抖音展示昵称与列表作者名一致（含前缀匹配，历史数据兜底）；
 * 2) 评论作者主页链 `/user/{id}` 与页内解析的当前登录用户 id 一致。
 */
function isDouyinCommentFromSelf(
  _root: Element,
  authorName: string,
  authorProfileId: string | null,
): boolean {
  if (authorName === "未知用户") return false
  if (
    cachedDouyinSelfNicknameOverride &&
    douyinNicknamesLikelySame(authorName, cachedDouyinSelfNicknameOverride)
  ) {
    return true
  }
  if (
    authorProfileId &&
    cachedDouyinLoggedInProfileId &&
    authorProfileId === cachedDouyinLoggedInProfileId
  ) {
    return true
  }
  return false
}

/** 单条评论行宿主（子回复为 UuCzPLbi[data-e2e=comment-item]） */
function douyinCommentRowHostEl(el: Element): Element | null {
  return (
    el.closest(
      '[data-e2e="comment-item"], [data-e2e="comment-list-item"], [data-e2e="video-comment-item"]',
    ) ?? null
  )
}

const DOUYIN_COMMENT_FRAGMENT_ROOT_SEL = [
  ".comment-item-info-wrap",
  "[class*='comment-item-info-wrap']",
  ".jzhUi9rG",
  ".ElTDPJYl",
  "[class*='comment-item-avatar']",
  ".comment-item-stats-container",
  "[class*='comment-item-stats']",
  ".prYubqgJ",
  ".vXZJEXVc",
  ".fJhvAqos",
].join(", ")

/**
 * `[class*=comment-item]` 会把昵称条 / 头像列 / 统计区扫成**独立根**。
 * 随后「只保留最内层根」会把整行 `comment-item`（或楼主 `EpsntdUI`）删掉（因包含上述子根），只剩碎片 →
 * `scrapeCommentRoot` 子树里没有与 info-wrap **平级**的 `.C7LroK_h`，正文退化成只剩昵称。
 */
function shouldDiscardDouyinFragmentRootInsideCommentRow(el: Element): boolean {
  let host: Element | null = douyinCommentRowHostEl(el)
  if (host && el !== host) {
    try {
      if (el.matches(DOUYIN_COMMENT_FRAGMENT_ROOT_SEL)) return true
    } catch {
      return false
    }
  }
  /** 楼主首条常在 `replyContainer` 前一兄弟，无 `data-e2e=comment-item`，同上需剔碎片 */
  host = el.closest(".EpsntdUI")
  if (host && el !== host) {
    try {
      if (el.matches(DOUYIN_COMMENT_FRAGMENT_ROOT_SEL)) return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 从 `replyContainer` 往前找第一个「像主楼」的兄弟块（同时含昵称条 + `.C7LroK_h` 正文），跳过展开按钮等杂质。
 */
/**
 * 一条评论线程的外壳：`.EpsntdUI` 内含主评区（`.Vrj4Q3zT` + 正文）与子回复 `replyContainer`。
 * 若在内层过滤里因「包着 UuCzPLbi」被删掉，则只剩子回复、主楼（如严明）会从侧栏消失。
 */
function douyinIsThreadMainEpsntdHost(el: Element): boolean {
  try {
    if (!el.matches?.(".EpsntdUI, [class*='EpsntdUI']")) return false
    const rc = el.querySelector(".replyContainer, [class*='replyContainer']")
    if (!rc || !el.contains(rc)) return false
    const blocks = el.querySelectorAll(".Vrj4Q3zT, [class*='Vrj4Q3zT']")
    for (const vj of blocks) {
      if (rc.contains(vj)) continue
      if (vj.querySelector?.(".C7LroK_h, [class*='C7LroK_h']")) return true
    }
    for (const ch of el.children) {
      if (ch === rc || rc.contains(ch) || ch.contains(rc)) continue
      if (
        ch.querySelector?.(".C7LroK_h, [class*='C7LroK_h']") &&
        ch.querySelector?.(
          ".comment-item-info-wrap, [class*='comment-item-info-wrap'], .jzhUi9rG",
        )
      )
        return true
    }
    return false
  } catch {
    return false
  }
}

/** 线程宿主上采集主楼：只刮 `replyContainer` 之外的 `.Vrj4Q3zT`（或等价列），避免正文与子回复拼成一条 */
function douyinThreadMainScrapeSubroot(root: Element): Element {
  if (!douyinIsThreadMainEpsntdHost(root)) return root
  const rc = root.querySelector(".replyContainer, [class*='replyContainer']")
  if (!rc) return root
  const blocks = root.querySelectorAll(".Vrj4Q3zT, [class*='Vrj4Q3zT']")
  for (const vj of blocks) {
    if (rc.contains(vj)) continue
    if (vj.querySelector?.(".C7LroK_h, [class*='C7LroK_h']")) return vj
  }
  for (const ch of root.children) {
    if (ch === rc || rc.contains(ch) || ch.contains(rc)) continue
    if (ch.querySelector?.(".C7LroK_h, [class*='C7LroK_h']")) return ch
  }
  return root
}

function douyinThreadHeadBlockBeforeReplyContainer(rc: Element): HTMLElement | null {
  let p: Element | null = rc.previousElementSibling
  for (let i = 0; i < 16 && p; i++) {
    if (!(p instanceof HTMLElement)) {
      p = p.previousElementSibling
      continue
    }
    if (p.closest('[data-e2e="comment-input"], [class*="comment-input"], [class*="CommentInput"]')) {
      p = p.previousElementSibling
      continue
    }
    if (p.getAttribute("data-e2e") === "comment-item") {
      p = p.previousElementSibling
      continue
    }
    if (p.closest('[data-e2e="comment-item"]')) {
      p = p.previousElementSibling
      continue
    }
    const hasInfo = p.querySelector(
      ".comment-item-info-wrap, [class*='comment-item-info-wrap'], .jzhUi9rG, [class*='comment-item-info']",
    )
    const hasBody = p.querySelector(".C7LroK_h, [class*='C7LroK_h']")
    if (hasInfo && hasBody) return p
    p = p.previousElementSibling
  }
  return null
}

function findLikelyCommentRoots(): Element[] {
  const selectors = [
    '[data-e2e="comment-item"]',
    '[data-e2e="comment-list-item"]',
    '[data-e2e="video-comment-item"]',
    ".comment-item",
    "[class*='CommentItem']",
    "[class*='comment-item']",
    "[class*='Comment-Item']",
    "[class*='feed-comment']",
    "[class*='FeedComment']",
  ]
  const map = new Map<Element, boolean>()
  for (const sel of selectors) {
    for (const el of querySelectorAllDeep(sel)) {
      if (!(el instanceof Element)) continue
      if (el.closest('[data-e2e="comment-input"], [class*="comment-input"], [class*="CommentInput"]')) continue
      map.set(el, true)
    }
  }
  // 弹层页（如 /jingxuan?modal_id=）评论 DOM 可能使用其它 data-e2e 命名
  const skipE2e =
    /input|editor|publish|placeholder|count|tips|search|nav|textarea|send|submit|header|drawer|modal|panel|list-container|^comment-list$/i
  const wantE2e = /comment[-_]?(item|row|card|cell|thread|line)|commentitem|comment_card/i
  for (const el of querySelectorAllDeep("[data-e2e]")) {
    if (!(el instanceof Element)) continue
    const e2e = el.getAttribute("data-e2e") ?? ""
    if (!e2e.toLowerCase().includes("comment")) continue
    if (skipE2e.test(e2e)) continue
    if (!wantE2e.test(e2e)) continue
    if (el.closest('[data-e2e="comment-input"], [class*="comment-input"], [class*="CommentInput"]')) continue
    map.set(el, true)
  }
  /**
   * 楼主首条常与 `replyContainer` 兄弟，本身不在 `[data-e2e=comment-item]` 里；补上避免漏主楼。
   * 展开子回复后中间可能插入「展开更多/收起」等节点，仅看 `previousElementSibling` 会错过后面的楼主块。
   */
  for (const rc of querySelectorAllDeep(".replyContainer, [class*='replyContainer']")) {
    if (!(rc instanceof Element)) continue
    if (rc.closest('[data-e2e="comment-input"], [class*="comment-input"], [class*="CommentInput"]')) continue
    const head = douyinThreadHeadBlockBeforeReplyContainer(rc)
    if (head) map.set(head, true)
    /** 保证「楼主 + replyContainer」整块 EpsntdUI 进 map，供内层过滤保留线程主宿主 */
    let p: Element | null = rc.parentElement
    for (let d = 0; d < 8 && p; d++) {
      if (douyinIsThreadMainEpsntdHost(p)) {
        map.set(p, true)
        break
      }
      p = p.parentElement
    }
  }

  for (const el of [...map.keys()]) {
    if (shouldDiscardDouyinFragmentRootInsideCommentRow(el)) map.delete(el)
  }

  let roots = [...map.keys()]
  /**
   * 展开「展开更多」后，外层线程容器会包住主评 + 所有子回复；若保留外层，clone/text 会把下拉里的回复**拼成一条**还常变「未知用户」。
   * 去掉「内部还包着其它 root」的节点，只保留**最内层**每条 `comment-item`（及上面的楼主兄弟块）。
   * 例外：**含主评 + replyContainer** 的 `.EpsntdUI` 线程宿主必须保留，否则发/加载子回复后主楼从侧栏消失。
   */
  roots = roots.filter((a) => {
    if (douyinIsThreadMainEpsntdHost(a)) return true
    return !roots.some((b) => b !== a && a.contains(b))
  })
  return roots
}

function scrapeCommentRoot(root: Element, postUrl: string): ScrapedComment | null {
  const cid =
    root.getAttribute("data-comment-id") ||
    root.getAttribute("data-cid") ||
    root.getAttribute("data-id") ||
    ""

  /** 线程外壳上只刮主楼列，不刮 replyContainer 内子回复 */
  const scrapeSurface = douyinThreadMainScrapeSubroot(root)

  const authorSelectors = [
    ".comment-item-info-wrap a[href*='/user/']",
    "[class*='comment-item-info-wrap'] a[href*='/user/']",
    ".BT7MlqJC a[href*='/user/']",
    '[data-e2e="comment-user-name"]',
    '[data-e2e="user-name"]',
    '[data-e2e="user-info-name"]',
    '[data-e2e*="user-name"]',
    '[data-e2e*="nickname"]',
    '[class*="user-name"]',
    '[class*="UserName"]',
    '[class*="nickname"]',
    '[class*="Nickname"]',
    'a[href*="/user/"]',
  ]
  let authorEl: Element | null = null
  for (const sel of authorSelectors) {
    authorEl = querySelectorDeepWithin(scrapeSurface, sel)
    if (authorEl) break
  }

  let authorName =
    (authorEl ? douyinTextContentIncludingOpenShadow(authorEl) : "") ||
    authorEl?.textContent?.replace(/\s+/g, " ").trim() ||
    "未知用户"
  authorName = authorName.replace(/^@\s*/, "").trim()
  if (authorName.length > 80) authorName = authorName.slice(0, 80)

  const authorProfileId = douyinAuthorProfileIdFromAuthorEl(authorEl)
  if (isDouyinCommentFromSelf(root, authorName, authorProfileId)) return null

  /**
   * 现行 PC DOM：正文在与 `comment-item-info-wrap` 平级的 `.C7LroK_h`（父级常为 `.Vrj4Q3zT`）。
   * 结构选择器优先于宽泛的 `[class*=comment-text]`。
   */
  const contentSelectors = [
    ".Vrj4Q3zT > .C7LroK_h",
    "[class*='Vrj4Q3zT'] > .C7LroK_h",
    ".EpsntdUI .Vrj4Q3zT .C7LroK_h",
    '[data-e2e="comment-content"]',
    '[data-e2e="comment-text"]',
    '[data-e2e*="comment-content"]',
    '[data-e2e*="comment-text"]',
    ".C7LroK_h",
    "[class*='C7LroK_h']",
    '[class*="comment-content"]:not([class*="comment-item-info"])',
    '[class*="CommentContent"]',
    '[class*="comment-text"]',
    '[class*="CommentText"]',
    '[class*="comment-content"]',
  ]
  let content = ""
  pickContent: for (const sel of contentSelectors) {
    const candidates = querySelectorAllDeepWithinDocOrder(scrapeSurface, sel)
    for (const el of candidates) {
      if (isInsideDouyinCommentAuthorStrip(el)) continue
      const t = douyinTextContentIncludingOpenShadow(el)
      if (t.length < 2 || t.length >= 5000) continue
      if (douyinTextLooksLikeStatsRowOnly(t)) continue
      if (douyinTextLooksLikeAuthorOnly(t, authorName)) continue
      content = t
      break pickContent
    }
  }
  if (!content) {
    const clone = scrapeSurface.cloneNode(true) as HTMLElement
    clone
      .querySelectorAll(
        [
          "time",
          "button",
          "svg",
          "[class*='time']",
          "[class*='like']",
          ".fJhvAqos",
          ".vXZJEXVc",
          ".comment-item-stats-container",
          "[class*='comment-item-stats']",
          ".prYubqgJ",
          '[data-e2e="video-comment-more"]',
          ".l_udJNgz",
          ".comment-item-info-wrap",
          "[class*='comment-item-info-wrap']",
          ".ElTDPJYl",
          "[class*='comment-item-avatar']",
        ].join(", "),
      )
      .forEach((n) => n.remove())
    let t = douyinTextContentIncludingOpenShadow(clone)
    if (t.length < 2) t = douyinTextContentIncludingOpenShadow(scrapeSurface)
    if (
      t.length >= 2 &&
      t.length < 5000 &&
      !douyinTextLooksLikeStatsRowOnly(t) &&
      !douyinTextLooksLikeAuthorOnly(t, authorName)
    ) {
      content = t
    }
  }
  if (content.length < 2) return null

  content = sanitizeDouyinCommentBody(content, authorName)
  content = stripDouyinAppendedListMeta(content)

  if (content.length < 2) return null
  if (douyinTextLooksLikeAuthorOnly(content, authorName)) return null

  const timeEl =
    querySelectorDeepWithin(scrapeSurface, "time[datetime]") ??
    querySelectorDeepWithin(scrapeSurface, "time") ??
    querySelectorDeepWithin(scrapeSurface, "[class*='time']")
  const commentedAt =
    timeEl?.getAttribute("datetime") ?? timeEl?.textContent?.replace(/\s+/g, " ").trim() ?? ""

  const platformCommentId = cid
    ? `douyin:cid:${cid}`
    : `douyin:h:${simpleHash(postUrl + "\n" + authorName + "\n" + content.slice(0, 160))}`

  return {
    platformCommentId,
    authorName,
    content: content.slice(0, 4000),
    commentedAt: commentedAt || new Date().toISOString(),
    postUrl,
  }
}

const DOUYIN_AUTHOR_SEL_FOR_SELF_CHECK = [
  ".comment-item-info-wrap a[href*='/user/']",
  "[class*='comment-item-info-wrap'] a[href*='/user/']",
  ".BT7MlqJC a[href*='/user/']",
  '[data-e2e="comment-user-name"]',
  '[data-e2e="user-name"]',
  '[data-e2e="user-info-name"]',
  '[data-e2e*="user-name"]',
  '[data-e2e*="nickname"]',
  '[class*="user-name"]',
  '[class*="UserName"]',
  '[class*="nickname"]',
  '[class*="Nickname"]',
  'a[href*="/user/"]',
] as const

/** 判断单行是否为当前用户（不刮正文，供子回复自检） */
function douyinElementAppearsToBeSelfCommentRow(rowRoot: Element): boolean {
  const scrapeSurface = douyinThreadMainScrapeSubroot(rowRoot)
  let authorEl: Element | null = null
  for (const sel of DOUYIN_AUTHOR_SEL_FOR_SELF_CHECK) {
    authorEl = querySelectorDeepWithin(scrapeSurface, sel)
    if (authorEl) break
  }
  let authorName =
    (authorEl ? douyinTextContentIncludingOpenShadow(authorEl) : "") ||
    authorEl?.textContent?.replace(/\s+/g, " ").trim() ||
    "未知用户"
  authorName = authorName.replace(/^@\s*/, "").trim()
  if (authorName.length > 80) authorName = authorName.slice(0, 80)
  const authorProfileId = douyinAuthorProfileIdFromAuthorEl(authorEl)
  return isDouyinCommentFromSelf(rowRoot, authorName, authorProfileId)
}

/** 该评论根下 replyContainer 里是否已有「自己」发的子回复（主评侧栏应标已回复） */
function douyinAnyReplySubtreeHasSelf(threadRoot: Element): boolean {
  const rc = threadRoot.querySelector(".replyContainer, [class*='replyContainer']")
  if (!rc || !threadRoot.contains(rc)) return false
  const seen = new Set<Element>()
  for (const node of rc.querySelectorAll('[data-e2e="comment-item"], .UuCzPLbi')) {
    if (!(node instanceof Element) || !threadRoot.contains(node)) continue
    const row = (node.closest('[data-e2e="comment-item"]') as Element | null) ?? node
    if (seen.has(row)) continue
    seen.add(row)
    if (douyinElementAppearsToBeSelfCommentRow(row)) return true
  }
  return false
}

/** 仅当前挂载在 DOM 上的评论（虚拟列表滚走的上排会消失） */
function collectDouyinCommentsFromDom(postUrl: string): ScrapedComment[] {
  const seen = new Set<string>()
  const out: ScrapedComment[] = []
  for (const root of findLikelyCommentRoots()) {
    const row = scrapeCommentRoot(root, postUrl)
    if (!row || seen.has(row.platformCommentId)) continue
    if (douyinAnyReplySubtreeHasSelf(root)) row.domSelfReplied = true
    seen.add(row.platformCommentId)
    out.push(row)
  }
  return out
}

const DOUYIN_ACCUM_ORDER_MAX = 2800
let douyinAccumPostKey = ""
const douyinAccumById = new Map<string, ScrapedComment>()
const douyinAccumOrder: string[] = []

function clearDouyinCommentAccumulation(): void {
  douyinAccumPostKey = ""
  douyinAccumById.clear()
  douyinAccumOrder.length = 0
}

/**
 * 合并当前 DOM 扫描结果：同一视频下保留「曾扫到过的 id」，避免下拉后首条被卸载就从侧栏消失。
 */
function mergeDouyinDomSliceIntoAccumulation(postUrl: string, domSlice: ScrapedComment[]): void {
  if (postUrl !== douyinAccumPostKey) {
    douyinAccumPostKey = postUrl
    douyinAccumById.clear()
    douyinAccumOrder.length = 0
  }
  const inOrder = new Set(douyinAccumOrder)
  for (const row of domSlice) {
    const prev = douyinAccumById.get(row.platformCommentId)
    const merged: ScrapedComment = {
      ...row,
      domSelfReplied: Boolean(row.domSelfReplied || prev?.domSelfReplied),
    }
    douyinAccumById.set(row.platformCommentId, merged)
    if (!inOrder.has(row.platformCommentId)) {
      douyinAccumOrder.push(row.platformCommentId)
      inOrder.add(row.platformCommentId)
    }
  }
  while (douyinAccumOrder.length > DOUYIN_ACCUM_ORDER_MAX) {
    const drop = douyinAccumOrder.shift()!
    douyinAccumById.delete(drop)
    inOrder.delete(drop)
  }
}

function getDouyinAccumulatedCommentsSorted(): ScrapedComment[] {
  const list: ScrapedComment[] = []
  for (const id of douyinAccumOrder) {
    const r = douyinAccumById.get(id)
    if (r) list.push(r)
  }
  return list
}

async function douyinScanDomMergeAndGetLists(): Promise<{
  domSlice: ScrapedComment[]
  fullList: ScrapedComment[]
}> {
  await loadDouyinSelfNicknameOverride()
  refreshDouyinLoggedInProfileId()
  if (!isDouyinContentTargetUrl(location.href)) {
    return { domSlice: [], fullList: [] }
  }
  const postUrl = ingestPostUrl()
  const domSlice = collectDouyinCommentsFromDom(postUrl)
  mergeDouyinDomSliceIntoAccumulation(postUrl, domSlice)
  return { domSlice, fullList: getDouyinAccumulatedCommentsSorted() }
}

/** 返回当前视频下「累积」列表（含已滚出 DOM 的条），供侧栏 GET_ALL_PAGE_COMMENTS */
async function scanDouyinComments(): Promise<ScrapedComment[]> {
  const { fullList } = await douyinScanDomMergeAndGetLists()
  return fullList
}

function getDouyinPostContent(): { postTitle: string; postContent: string; postUrl: string } {
  const postUrl = ingestPostUrl()
  const deepText = (sel: string) => {
    for (const el of querySelectorAllDeep(sel)) {
      const t = el.textContent?.replace(/\s+/g, " ").trim()
      if (t && t.length > 2) return t
    }
    return ""
  }
  const title =
    deepText('[data-e2e="video-desc"]') ||
    deepText('[data-e2e*="video-desc"]') ||
    deepText('[data-e2e*="video-title"]') ||
    deepText('[data-e2e*="author"]') ||
    document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ||
    document.querySelector('[class*="video-title"]')?.textContent?.replace(/\s+/g, " ").trim() ||
    document.querySelector('[class*="VideoTitle"]')?.textContent?.replace(/\s+/g, " ").trim() ||
    document.title
  const desc =
    deepText('[data-e2e="video-desc"]') ||
    deepText('[data-e2e*="video-desc"]') ||
    document.querySelector('[class*="video-desc"]')?.textContent?.replace(/\s+/g, " ").trim() ||
    document.querySelector('[class*="Desc"]')?.textContent?.replace(/\s+/g, " ").trim() ||
    ""
  return {
    postTitle: title.slice(0, 200),
    postContent: desc.slice(0, 2000),
    postUrl,
  }
}

const ingestDeduper = createCommentIngestDeduper(3000)

/** 当前页 DOM 扫描得到的可见评论 id 签名；折叠/展开子回复后集合会变，用于通知侧栏全量重拉 */
let lastDouyinDomCommentSig = ""

function broadcastDouyinDomCommentSignatureIfChanged(comments: ScrapedComment[]): void {
  const sig = comments
    .map((c) => c.platformCommentId)
    .sort()
    .join("\u001f")
  if (sig === lastDouyinDomCommentSig) return
  lastDouyinDomCommentSig = sig
  chrome.runtime.sendMessage({ type: "PAGE_COMMENTS_DOM_CHANGED" }).catch(() => {})
}

function sendComments(comments: ScrapedComment[]) {
  if (!comments.length) return
  console.log(`[CommentCopilot][douyin] sending ${comments.length} comments`)
  chrome.runtime
    .sendMessage({
      type: "COMMENTS_COLLECTED",
      payload: { platform: "douyin", comments },
    })
    .catch(() => {})
}

const SCAN_THROTTLE_MS = 450
const runThrottledScan = createThrottledScan(
  SCAN_THROTTLE_MS,
  async () => {
    if (!isDouyinContentTargetUrl(location.href)) return
    const { fullList } = await douyinScanDomMergeAndGetLists()
    /** 折叠/展开 / 虚拟列表会改 DOM；签名用累积列表，避免仅首屏卸载就误触发或丢条 */
    broadcastDouyinDomCommentSignatureIfChanged(fullList)
    const newOnes = ingestDeduper.collectFresh(fullList)
    if (newOnes.length > 0) sendComments(newOnes)
  },
  { label: "douyin" },
)

async function initialScan(retries = 10, delay = 700) {
  if (!isDouyinContentTargetUrl(location.href)) return
  const { fullList } = await douyinScanDomMergeAndGetLists()
  broadcastDouyinDomCommentSignatureIfChanged(fullList)
  const newOnes = ingestDeduper.collectFresh(fullList)
  if (newOnes.length > 0) {
    sendComments(newOnes)
  } else if (retries > 0) {
    setTimeout(() => {
      void initialScan(retries - 1, Math.min(delay * 1.15, 6000))
    }, delay)
  }
}

async function getAllPageComments(): Promise<ScrapedComment[]> {
  return await scanDouyinComments()
}

// ─── 侧栏「回复」：定位评论 → 点「回复」→ 等输入框 → 写入（与小红书 / B 站一致） ───
//
// 抖音 Web 侧栏里：**底部主输入框往往始终在 DOM 里**（占位「留下你的精彩评论吧」）。
// 点某条「回复」通常**不是**再插一个新的 textarea，而是让**同一个底部框**进入「回复@昵称: …」的上下文（与发顶级评论共用同一 Draft）。
// 因此 `collect` 到的可编辑数量**未必**在点回复后增加；且底栏常在 DOM 里≠已关联当前楼层——**必须先让该条进入「回复中」**（用户手势或可靠的程序化点「回复」），再写入。
// 仅当该条 `span` 已是「回复中」且底栏文案/昵称与目标一致时，才可跳过程序化点「回复」。
//
// 「回复」按钮与输入区仍会经历常见三态：
// 1) 未操作：`div[tabindex="0"][data-popupid]`，内层 `span` 文案为「回复」，旁为气泡图标。
// 2) 点击后进行中：同一结构下 `span` 变为「回复中」；可能带 tooltip（如「前往西瓜视频回复评论」= 该条不能在本页回，仅能点按钮尝试）。
// 3) 可输入：底部 `div.comment-input-container` 内 Draft.js，`div.public-DraftEditor-content[contenteditable]`
//    的 `aria-describedby` 指向占位节点；上方出现「回复@昵称: 原评论摘要」表示已关联到该条。
// 选取回复按钮时需同时认「回复」与「回复中」；选取输入区时优先 Draft 主框，且占位通过 aria-describedby 解析，不能只看原生 placeholder。

const douyinSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 在抖音视频页控制台执行：`localStorage.setItem("yanling_debug_douyin_fill","1")` 后刷新，再点侧栏「回复」可看步骤日志 */
function douyinFillDebugLog(...parts: unknown[]) {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("yanling_debug_douyin_fill") === "1") {
      console.log("[CommentCopilot][douyin][fill]", ...parts)
    }
  } catch {
    /* ignore */
  }
}

function douyinFillDebugWarn(...parts: unknown[]) {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("yanling_debug_douyin_fill") === "1") {
      console.warn("[CommentCopilot][douyin][fill]", ...parts)
    }
  } catch {
    /* ignore */
  }
}

function forEachDeepElement(container: Element, visit: (el: Element) => void) {
  visit(container)
  const stack: (Element | ShadowRoot)[] = []
  for (let i = 0; i < container.children.length; i++) stack.push(container.children[i]!)
  if (container.shadowRoot) stack.push(container.shadowRoot)
  while (stack.length) {
    const n = stack.pop()!
    if (n instanceof Element) {
      visit(n)
      for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]!)
      if (n.shadowRoot) stack.push(n.shadowRoot)
    } else {
      const sr = n as ShadowRoot
      for (let i = 0; i < sr.children.length; i++) stack.push(sr.children[i] as Element)
    }
  }
}

function douyinContentEditableValue(el: HTMLElement): string {
  return (el.getAttribute("contenteditable") ?? "").trim().toLowerCase()
}

function douyinIsActiveContentEditable(el: HTMLElement): boolean {
  const v = douyinContentEditableValue(el)
  return v === "true" || v === "plaintext-only" || v === ""
}

function isDouyinElementVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  const st = getComputedStyle(el)
  if (st.display === "none" || st.visibility === "hidden") return false
  if (r.width > 0 && r.height > 0) {
    if (st.opacity === "0") return false
    return true
  }
  // Draft 内层在动画/未聚焦时常见 0×0，但外层评论容器已铺开 —— 仍应参与收集
  const host = el.closest(".comment-input-container, .comment-input-inner-container, .DraftEditor-root")
  if (host instanceof HTMLElement) {
    const hr = host.getBoundingClientRect()
    if (hr.width > 4 && hr.height > 4 && st.display !== "none" && st.visibility !== "hidden") return true
  }
  return false
}

function douyinNormalizeUiText(s: string): string {
  return s.replace(/\s+/g, "").trim()
}

function douyinClickableAncestor(el: HTMLElement): HTMLElement {
  const p = el.closest("button, a, [role='button'], [role='link'], div[tabindex='0']")
  return (p as HTMLElement) ?? el
}

/** 未点：span「回复」；进行态：「回复中」；与 data-popupid + tooltip 文案无关，只看操作 span */
function findDouyinSpanWithReplyActionText(host: Element): boolean {
  for (const s of host.querySelectorAll("span")) {
    const nt = douyinNormalizeUiText(s.textContent ?? "")
    if (nt === "回复" || nt === "回復" || nt === "回复中") return true
  }
  return false
}

/** 当前行「回复」按钮是否已进入进行态（表示 App 认为正在回复该条，可不依赖底栏「回复@」文案） */
function douyinReplyControlShowsReplying(host: HTMLElement): boolean {
  for (const s of host.querySelectorAll("span")) {
    const nt = douyinNormalizeUiText(s.textContent ?? "")
    if (nt === "回复中") return true
  }
  return false
}

/** 「⋯」更多菜单与「回复」同为 tabindex=0 + data-popupid，必须在一条内区分开 */
function douyinReplyControlIsMoreMenuHost(el: HTMLElement): boolean {
  return Boolean(el.closest('[data-e2e="video-comment-more"]'))
}

/**
 * 真·回复入口：现网为 `div[tabindex=0][data-popupid]` + 内层 `div` 里 **气泡评论 SVG**（viewBox 36×36 / path 含 17.617）+ `span`「回复」。
 * 与 `aria-describedby` 指向的 tooltip（如「前往西瓜视频回复评论」）同属一个 host，见 `douyinReplyHostIndicatesXiguaOnlyReply`。
 */
function douyinReplyHostHasCommentBubbleIcon(host: HTMLElement): boolean {
  if (host.querySelector('svg[class*="AB4NKfje"]')) return true
  const svg = host.querySelector('svg[viewBox="0 0 36 36"]')
  const d = svg?.querySelector("path")?.getAttribute("d") ?? ""
  return d.length > 80 && /17\.617/.test(d)
}

/** 该条回复只能去西瓜视频等外站，本页不会出现底栏输入框 */
function douyinReplyHostIndicatesXiguaOnlyReply(host: HTMLElement): boolean {
  const t = (host.textContent ?? "").replace(/\s+/g, "")
  return /前往西瓜视频|西瓜视频回复|去西瓜视频/.test(t)
}

/** 气泡回复按钮内部的「回复」span（与 `div[tabindex=0][data-popupid]` 一一对应） */
function findDouyinReplySpanUnderHost(host: HTMLElement): HTMLElement | null {
  for (const sp of host.querySelectorAll("span")) {
    const nt = douyinNormalizeUiText(sp.textContent ?? "")
    if (nt === "回复" || nt === "回復" || nt === "回复中") return sp
  }
  return null
}

/**
 * 与现网 HTML 一致：落在 `comment-item-stats-container` 内，
 * `div[tabindex=0][data-popupid]` + 气泡图标 + span「回复」（类名 ANYunOWC 会变，不依赖）。
 */
function findDouyinReplyControlInStatsRow(root: Element): HTMLElement | null {
  const statsHosts = root.querySelectorAll(
    '[class*="comment-item-stats"], [class*="CommentItemStats"], [class*="comment-item-stats-container"]',
  )
  const scopes: Element[] = statsHosts.length > 0 ? Array.from(statsHosts) : [root]
  const withBubble: HTMLElement[] = []
  const fallback: HTMLElement[] = []
  for (const scope of scopes) {
    if (!root.contains(scope)) continue
    scope.querySelectorAll('div[tabindex="0"][data-popupid]').forEach((el) => {
      if (!(el instanceof HTMLElement)) return
      if (!root.contains(el)) return
      if (douyinReplyControlIsMoreMenuHost(el)) return
      if (el.closest("button.comment-reply-expand-btn, .comment-reply-expand-btn")) return
      if (!isDouyinElementVisible(el)) return
      if (!findDouyinSpanWithReplyActionText(el)) return
      if (douyinReplyHostHasCommentBubbleIcon(el)) withBubble.push(el)
      else fallback.push(el)
    })
  }
  const candidates = withBubble.length > 0 ? withBubble : fallback
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return ra.width * ra.height - rb.width * rb.height
  })
  return candidates[0] ?? null
}

/**
 * 在该条评论 root 内找「回复」「回复中」文案的 span（取面积最小的一个，避免命中外层大包 div）。
 * 排除「⋯」菜单内节点与「展开 n 条回复」按钮下节点。
 */
function findDouyinReplyLabelSpanInRoot(root: Element): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestArea = Infinity
  forEachDeepElement(root, (el) => {
    if (!(el instanceof HTMLElement)) return
    if (el.tagName !== "SPAN") return
    if (douyinReplyControlIsMoreMenuHost(el)) return
    if (el.closest("button.comment-reply-expand-btn, .comment-reply-expand-btn")) return
    const nt = douyinNormalizeUiText(el.textContent ?? "")
    if (nt !== "回复" && nt !== "回復" && nt !== "回复中") return
    if (!isDouyinElementVisible(el)) return
    const r = el.getBoundingClientRect()
    const area = Math.max(1, r.width) * Math.max(1, r.height)
    if (area < bestArea) {
      bestArea = area
      best = el
    }
  })
  return best
}

function findDouyinReplyControlInRoot(root: Element): HTMLElement | null {
  // 0) 统计条内的回复按钮（避免与「⋯」同为 popupid 结构时误选）
  const statsReply = findDouyinReplyControlInStatsRow(root)
  if (statsReply) {
    return statsReply
  }

  // 1) 带「回复」文案的最小 span → 可点击祖先（与真实用户一致）
  const label = findDouyinReplyLabelSpanInRoot(root)
  if (label) {
    return douyinClickableAncestor(label)
  }

  // 2) 兜底：div[tabindex="0"][data-popupid] 内 span「回复」，但排除「⋯」菜单
  const tabindexReplyDivs: HTMLElement[] = []
  forEachDeepElement(root, (el) => {
    if (!(el instanceof HTMLElement)) return
    if (el.tagName !== "DIV") return
    if (el.getAttribute("tabindex") !== "0") return
    if (douyinReplyControlIsMoreMenuHost(el)) return
    if (el.closest("button.comment-reply-expand-btn, .comment-reply-expand-btn")) return
    if (!findDouyinSpanWithReplyActionText(el)) return
    if (!isDouyinElementVisible(el)) return
    tabindexReplyDivs.push(el)
  })
  if (tabindexReplyDivs.length > 0) {
    const withPopup = tabindexReplyDivs.filter((d) => d.hasAttribute("data-popupid"))
    const pool = withPopup.length > 0 ? withPopup : tabindexReplyDivs
    pool.sort((a, b) => {
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      return ra.width * ra.height - rb.width * rb.height
    })
    return pool[0] ?? null
  }

  let e2eHit: HTMLElement | null = null
  forEachDeepElement(root, (el) => {
    if (!(el instanceof HTMLElement) || e2eHit) return
    if (douyinReplyControlIsMoreMenuHost(el)) return
    const e2e = el.getAttribute("data-e2e")?.toLowerCase() ?? ""
    if (!e2e.includes("reply")) return
    if (/count|num|total|like|share|list/i.test(e2e)) return
    if (!isDouyinElementVisible(el)) return
    e2eHit = douyinClickableAncestor(el)
  })
  if (e2eHit) return e2eHit

  const textHits: HTMLElement[] = []
  forEachDeepElement(root, (el) => {
    if (!(el instanceof HTMLElement)) return
    if (douyinReplyControlIsMoreMenuHost(el)) return
    if (el.closest("button.comment-reply-expand-btn, .comment-reply-expand-btn")) return
    const nt = douyinNormalizeUiText(el.textContent ?? "")
    if (nt !== "回复" && nt !== "回復" && nt !== "回复中") return
    if (!isDouyinElementVisible(el)) return
    textHits.push(douyinClickableAncestor(el))
  })
  if (textHits.length === 0) return null
  textHits.sort((a, b) => {
    const ra = a.getBoundingClientRect()
    const rb = b.getBoundingClientRect()
    return ra.width * ra.height - rb.width * rb.height
  })
  return textHits[0] ?? null
}

function findDouyinCommentRootByPlatformId(platformCommentId: string): Element | null {
  const postUrl = ingestPostUrl()
  for (const root of findLikelyCommentRoots()) {
    const row = scrapeCommentRoot(root, postUrl)
    if (row?.platformCommentId === platformCommentId) return root
  }
  return null
}

/** 抖音点「回复」后常在底部「留下你的精彩评论吧」主框里回复，而不是行内小框 */
const DOUYIN_MAIN_COMPOSER_PLACEHOLDER =
  /留下你的精彩评论|精彩评论吧|说点什么|友善评论|发条评论|发表.*评论/i

/** Draft.js：占位在 `public-DraftEditorPlaceholder-inner`，通过 `aria-describedby="placeholder-xxx"` 关联 */
function getDouyinPlaceholderTextFromAriaDescribedby(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-describedby") ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  for (const id of ids) {
    try {
      let node: Element | null = null
      const rn = el.getRootNode()
      if (rn instanceof ShadowRoot) {
        node = rn.querySelector(`#${CSS.escape(id)}`)
      } else if (rn instanceof Document) {
        node = rn.getElementById(id)
      }
      if (!node && typeof document !== "undefined") {
        node = document.getElementById(id)
      }
      const t = node?.textContent?.replace(/\s+/g, " ").trim() ?? ""
      if (t) return t
    } catch {
      /* id 非法等 */
    }
  }
  return ""
}

function getDouyinEditablePlaceholderHint(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const p = el.placeholder?.trim()
    if (p) return p
  }
  const fromAria = getDouyinPlaceholderTextFromAriaDescribedby(el)
  if (fromAria) return fromAria
  const aria = el.getAttribute("aria-label")?.trim() ?? ""
  if (aria) return aria
  const d = el.getAttribute("data-placeholder") ?? el.getAttribute("placeholder") ?? ""
  if (d.trim()) return d.trim()
  return ""
}

/** 抖音 Web 回复主输入区：DraftEditor + `.comment-input-container` */
function isDouyinCommentDraftComposer(el: HTMLElement): boolean {
  if (!douyinIsActiveContentEditable(el)) return false
  const cls = (el.className && String(el.className)) || ""
  if (cls.includes("public-DraftEditor-content") || cls.includes("DraftEditor-content")) return true
  return Boolean(el.closest(".comment-input-container, .comment-input-inner-container"))
}

/** 顶栏搜索框等，占位/祖先 data-e2e 常带 searchbar，易与「最靠下输入框」启发式冲突 */
function isDouyinSearchOrNonCommentInput(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement && el.type === "search") return true
  const hint = `${getDouyinEditablePlaceholderHint(el)} ${el.id} ${el.getAttribute("name") ?? ""} ${el.className && String(el.className)}`
  if (/搜索|搜点|search|keyword|关键词|你想搜什么|请输入关键词/i.test(hint)) return true

  let p: Element | null = el
  for (let depth = 0; depth < 14 && p; depth++) {
    const e2e = p.getAttribute("data-e2e")?.toLowerCase() ?? ""
    if (
      e2e.includes("searchbar") ||
      e2e === "searchbar-input" ||
      e2e === "searchbar-button" ||
      (e2e.includes("search") && !e2e.includes("comment"))
    ) {
      return true
    }
    const cls = (p.className && String(p.className).toLowerCase()) || ""
    if (
      cls.includes("search-bar") ||
      cls.includes("searchbar") ||
      cls.includes("header-search") ||
      cls.includes("nav-search")
    ) {
      return true
    }
    const pid = p.id?.toLowerCase() ?? ""
    if (pid.includes("search") && !pid.includes("comment")) return true
    p = p.parentElement
  }
  return false
}

/** Draft 内层 0×0 但外层评论壳已铺开时，仅靠 rect 会漏集 */
function isDouyinElementVisibleLenient(el: HTMLElement): boolean {
  if (isDouyinElementVisible(el)) return true
  const cls = (el.className && String(el.className)) || ""
  const draftish =
    cls.includes("public-DraftEditor-content") ||
    cls.includes("DraftEditor-content") ||
    (douyinIsActiveContentEditable(el) &&
      Boolean(el.closest(".DraftEditor-root, [class*='DraftEditor']")))
  if (!draftish) return false
  const host = el.closest(
    ".comment-input-container, .comment-input-inner-container, .DraftEditor-root, [class*='comment-input'], [class*='CommentInput'], [class*='DraftEditor']",
  )
  if (host instanceof HTMLElement) {
    const hr = host.getBoundingClientRect()
    const st = getComputedStyle(host)
    if (st.display !== "none" && st.visibility !== "hidden" && hr.width > 4 && hr.height > 4) return true
  }
  return false
}

/**
 * 从评论行向上找「右栏/侧栏」级祖先（面积大），再只在该子树内穿透 Shadow 扫输入区。
 * 解决 /jingxuan?modal_id= 等页全站深搜在耗尽 DEEP_QUERY_MAX_ROOTS 前走不到评论 Draft → editables: 0。
 */
function findDouyinCommentColumnShell(start: Element): Element {
  let best: Element = start
  let bestArea = 0
  let p: Element | null = start
  for (let depth = 0; depth < 52 && p; depth++) {
    const r = p.getBoundingClientRect()
    const area = Math.max(0, r.width) * Math.max(0, r.height)
    if (r.height >= 200 && r.width >= 120 && area >= bestArea) {
      bestArea = area
      best = p
    }
    p = p.parentElement
  }
  if (bestArea < 80_000) {
    p = best.parentElement
    for (let i = 0; i < 18 && p; i++) {
      const r = p.getBoundingClientRect()
      const area = r.width * r.height
      if (r.height >= 280 && area > bestArea) {
        best = p
        bestArea = area
      }
      p = p.parentElement
    }
  }
  return best
}

function considerDouyinEditableForCollection(el: HTMLElement): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLInputElement) {
    const t = el.type
    if (t && t !== "text") return false
  }
  if (el.tagName === "TEXTAREA") return true
  if (el.tagName === "INPUT" && el instanceof HTMLInputElement && (!el.type || el.type === "text")) return true
  try {
    if (
      el.matches(
        '[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]',
      ) &&
      douyinIsActiveContentEditable(el)
    ) {
      return true
    }
  } catch {
    /* ignore */
  }
  try {
    if (
      el.matches(
        ".public-DraftEditor-content, .comment-input-container [contenteditable], .comment-input-inner-container [contenteditable], div[role='combobox'][contenteditable]",
      ) &&
      (douyinIsActiveContentEditable(el) || el.tagName === "TEXTAREA" || el.tagName === "INPUT")
    ) {
      return true
    }
  } catch {
    /* ignore */
  }
  if (el.closest(".DraftEditor-root") && douyinIsActiveContentEditable(el)) return true
  const cls = (el.className && String(el.className)) || ""
  if (
    douyinIsActiveContentEditable(el) &&
    (cls.includes("DraftEditor") ||
      Boolean(el.closest(".comment-input-container, .comment-input-inner-container, .DraftEditor-root")))
  ) {
    return true
  }
  return false
}

function collectDouyinEditablesInSubtreeDepthFirst(
  container: Element,
  maxVisited: number,
  onElement: (h: HTMLElement) => void,
): void {
  const stack: (Element | ShadowRoot)[] = [container]
  let visited = 0
  while (stack.length && visited < maxVisited) {
    const cur = stack.pop()!
    visited++
    if (cur instanceof ShadowRoot) {
      const kids = Array.from(cur.children) as Element[]
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
      continue
    }
    const el = cur
    if (el instanceof HTMLElement) {
      onElement(el)
    }
    if (el.shadowRoot) stack.push(el.shadowRoot)
    const children = Array.from(el.children)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
}

function collectDouyinVisibleEditablesDeep(anchorRoot?: Element | null): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const push = (el: HTMLElement) => {
    if (seen.has(el)) return
    if (!isDouyinElementVisible(el)) return
    if (isDouyinSearchOrNonCommentInput(el)) return
    seen.add(el)
  }
  const pushLenient = (el: HTMLElement) => {
    if (seen.has(el)) return
    if (!isDouyinElementVisible(el) && !isDouyinElementVisibleLenient(el)) return
    if (isDouyinSearchOrNonCommentInput(el)) return
    seen.add(el)
  }

  const genericSels = [
    "textarea",
    'input[type="text"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[contenteditable=""]',
  ]
  for (const sel of genericSels) {
    for (const el of querySelectorAllDeep(sel)) {
      if (!(el instanceof HTMLElement)) continue
      if (el instanceof HTMLInputElement) {
        const t = el.type
        if (t && t !== "text") continue
      }
      if (sel.includes("contenteditable") && !douyinIsActiveContentEditable(el)) continue
      push(el)
    }
  }

  // 定向：避免仅靠通用选择器在超大页上漏掉 Draft（用户反馈 editables: 0）
  const targetedSels = [
    ".public-DraftEditor-content",
    ".DraftEditor-root [contenteditable]",
    ".comment-input-container [contenteditable]",
    ".comment-input-inner-container [contenteditable]",
    'div[role="combobox"][contenteditable]',
  ]
  for (const sel of targetedSels) {
    for (const el of querySelectorAllDeep(sel)) {
      if (!(el instanceof HTMLElement)) continue
      if (!douyinIsActiveContentEditable(el) && el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") continue
      push(el)
    }
  }

  // 评论区偶发挂在同源 iframe 里，主 document 深搜为 0
  const IFRAME_BUDGET = 6000
  try {
    for (const fr of document.querySelectorAll("iframe")) {
      if (!(fr instanceof HTMLIFrameElement)) continue
      let idoc: Document | null = null
      try {
        idoc = fr.contentDocument
      } catch {
        continue
      }
      if (!idoc?.body) continue
      for (const sel of genericSels) {
        for (const el of querySelectorAllDeepFromRoot(idoc, sel, IFRAME_BUDGET)) {
          if (!(el instanceof HTMLElement)) continue
          if (el instanceof HTMLInputElement) {
            const t = el.type
            if (t && t !== "text") continue
          }
          if (sel.includes("contenteditable") && !douyinIsActiveContentEditable(el)) continue
          push(el)
        }
      }
      for (const sel of targetedSels) {
        for (const el of querySelectorAllDeepFromRoot(idoc, sel, IFRAME_BUDGET)) {
          if (!(el instanceof HTMLElement)) continue
          if (!douyinIsActiveContentEditable(el) && el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") continue
          push(el)
        }
      }
    }
  } catch {
    /* ignore */
  }

  if (anchorRoot instanceof Element) {
    const shell = findDouyinCommentColumnShell(anchorRoot)
    collectDouyinEditablesInSubtreeDepthFirst(shell, DOUYIN_SUBTREE_EDITABLE_MAX_NODES, (h) => {
      if (considerDouyinEditableForCollection(h)) pushLenient(h)
    })
  }

  return [...seen]
}

function snapshotDouyinEditable(el: HTMLElement): string {
  const r = el.getBoundingClientRect()
  return `${el.tagName}:${Math.round(r.top)}:${Math.round(r.left)}:${(el as HTMLTextAreaElement).value?.length ?? 0}`
}

function pickDouyinEditableNearRoot(root: Element, candidates: HTMLElement[]): HTMLElement | null {
  if (candidates.length === 0) return null
  const rr = root.getBoundingClientRect()
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of candidates) {
    const er = el.getBoundingClientRect()
    if (er.bottom < rr.top - 300) continue
    const dy = er.top - rr.bottom
    const score = Math.abs(dy) + Math.abs(er.left - rr.left) * 0.03
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

/**
 * 点「回复」后：优先 Draft.js（`public-DraftEditor-content` + aria-describedby →「留下你的精彩评论吧」）。
 * 该 `.comment-input-container` 可能在侧栏内或紧贴评论行，不能仅用 `!commentRoot.contains` 否则会误排除。
 */
function pickDouyinBottomMainComposer(candidates: HTMLElement[], commentRoot: Element): HTMLElement | null {
  const vh = globalThis.innerHeight || 800
  const clean = candidates.filter((el) => !isDouyinSearchOrNonCommentInput(el))
  if (clean.length === 0) return null

  const draftAll = clean.filter((el) => isDouyinCommentDraftComposer(el))
  const draftMain = draftAll.filter((el) =>
    DOUYIN_MAIN_COMPOSER_PLACEHOLDER.test(getDouyinEditablePlaceholderHint(el))
  )
  if (draftMain.length > 0) {
    draftMain.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
    return draftMain[0] ?? null
  }
  if (draftAll.length > 0) {
    draftAll.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
    return draftAll[0] ?? null
  }

  const outside = clean.filter((el) => !commentRoot.contains(el))
  if (outside.length === 0) return null

  const byHint = outside.filter((el) =>
    DOUYIN_MAIN_COMPOSER_PLACEHOLDER.test(getDouyinEditablePlaceholderHint(el))
  )
  if (byHint.length > 0) {
    byHint.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
    return byHint[0] ?? null
  }

  const notTopChrome = outside.filter((el) => {
    const t = el.getBoundingClientRect().top
    return t > vh * 0.18
  })
  const pool = notTopChrome.length > 0 ? notTopChrome : outside
  pool.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
  return pool[0] ?? null
}

/** 侧栏「视频跟评」：不绑定某条评论，选页面底部主评论框（优先非「回复@」态） */
function preferDouyinComposersNotInReplyMode(pool: HTMLElement[]): HTMLElement[] {
  const free = pool.filter((el) => !douyinReplyTargetNickFromComposerShell(el))
  return free.length > 0 ? free : pool
}

function pickDouyinStandaloneMainComposer(candidates: HTMLElement[]): HTMLElement | null {
  const vh = globalThis.innerHeight || 800
  const clean = candidates.filter((el) => !isDouyinSearchOrNonCommentInput(el))
  if (clean.length === 0) return null

  const pickBottom = (pool: HTMLElement[]) => {
    const pref = preferDouyinComposersNotInReplyMode(pool)
    pref.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
    return pref[0] ?? null
  }

  const draftAll = clean.filter((el) => isDouyinCommentDraftComposer(el))
  const draftMain = draftAll.filter((el) =>
    DOUYIN_MAIN_COMPOSER_PLACEHOLDER.test(getDouyinEditablePlaceholderHint(el))
  )
  if (draftMain.length > 0) return pickBottom(draftMain)
  if (draftAll.length > 0) return pickBottom(draftAll)

  const byHint = clean.filter((el) =>
    DOUYIN_MAIN_COMPOSER_PLACEHOLDER.test(getDouyinEditablePlaceholderHint(el))
  )
  if (byHint.length > 0) return pickBottom(byHint)

  const notTopChrome = clean.filter((el) => {
    const t = el.getBoundingClientRect().top
    return t > vh * 0.18
  })
  const pool = notTopChrome.length > 0 ? notTopChrome : clean
  return pickBottom(pool)
}

/**
 * 新版抖音主评区常见结构：`comment-input-inner-container` 内先渲染占位文案节点（如 span「留下你的精彩评论吧」），
 * 真实 Draft/contenteditable 在用户点击后才挂载或才可见；与手点一致应优先点占位条而非整块右侧工具栏。
 */
function findDouyinPlaceholderStripInInner(inner: Element): HTMLElement | null {
  const candidates = inner.querySelectorAll("span, div, p, label")
  let best: HTMLElement | null = null
  let bestArea = 0
  for (const n of candidates) {
    if (!(n instanceof HTMLElement)) continue
    if (!isDouyinElementVisible(n) && !isDouyinElementVisibleLenient(n)) continue
    const t = douyinNormalizeUiText(n.textContent ?? "")
    if (t.length > 72) continue
    if (!DOUYIN_MAIN_COMPOSER_PLACEHOLDER.test(t)) continue
    const r = n.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const area = r.width * r.height
    if (area > bestArea) {
      bestArea = area
      best = n
    }
  }
  return best
}

/** 占位节点过小时，向上扩到左侧输入条区域（避免点到空白） */
function douyinPromotePlaceholderClickTarget(el: HTMLElement): HTMLElement {
  const inner = el.closest(".comment-input-inner-container")
  if (!inner) return el
  let cur: HTMLElement = el
  for (let d = 0; d < 5 && cur.parentElement && inner.contains(cur.parentElement); d++) {
    const r = cur.getBoundingClientRect()
    if (r.width >= 40 && r.height >= 14) return cur
    cur = cur.parentElement
  }
  return el
}

function findDouyinMainPlaceholderStripOnPage(doc: Document = document): HTMLElement | null {
  for (const inner of doc.querySelectorAll(".comment-input-inner-container")) {
    const hit = findDouyinPlaceholderStripInInner(inner)
    if (hit) return douyinPromotePlaceholderClickTarget(hit)
  }
  return null
}

/** 同源 iframe 内也可能挂评论条（与 collect 逻辑一致时再扫） */
function findDouyinMainPlaceholderStripAnywhere(): HTMLElement | null {
  const top = findDouyinMainPlaceholderStripOnPage(document)
  if (top) return top
  try {
    for (const fr of document.querySelectorAll("iframe")) {
      if (!(fr instanceof HTMLIFrameElement)) continue
      let idoc: Document | null = null
      try {
        idoc = fr.contentDocument
      } catch {
        continue
      }
      if (!idoc?.body) continue
      const hit = findDouyinMainPlaceholderStripOnPage(idoc)
      if (hit) return hit
    }
  } catch {
    /* ignore */
  }
  return null
}

async function douyinClickMainCommentPlaceholderStrip(reason: string): Promise<void> {
  const strip = findDouyinMainPlaceholderStripAnywhere()
  if (!strip) {
    douyinFillDebugLog("placeholder-strip: none", reason)
    return
  }
  douyinFillDebugLog("placeholder-strip: click", reason, strip)
  try {
    strip.scrollIntoView({ block: "center", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await douyinSleep(80)
  try {
    strip.focus({ preventScroll: true })
  } catch {
    try {
      strip.focus()
    } catch {
      /* ignore */
    }
  }
  await douyinSleep(40)
  douyinSimulatePointerClick(strip)
  await douyinSleep(100)
  try {
    strip.click()
  } catch {
    /* ignore */
  }
  await douyinSleep(220)
}

/** 用户手动点「下边评论框」才能粘贴时，抖音常要求先有一次真实聚焦；取可点的壳层（与手点区域一致） */
function findDouyinMainComposerActivationTarget(editor: HTMLElement): HTMLElement {
  const inner = editor.closest(".comment-input-inner-container")
  if (inner) {
    const strip = findDouyinPlaceholderStripInInner(inner)
    if (strip) return douyinPromotePlaceholderClickTarget(strip)
  }
  const shell =
    editor.closest(
      ".comment-input-container, .comment-input-inner-container, [class*='CommentInput'], .DraftEditor-root",
    ) ?? editor
  if (shell instanceof HTMLElement) {
    const r = shell.getBoundingClientRect()
    if (r.width >= 16 && r.height >= 12) return shell
  }
  return editor
}

/** 模拟用户先点一下输入区，再写入（否则 Draft 常拒收程序化 paste/insertText） */
async function douyinActivateMainComposerBeforeWrite(editor: HTMLElement): Promise<void> {
  const target = findDouyinMainComposerActivationTarget(editor)
  try {
    target.scrollIntoView({ block: "center", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await douyinSleep(100)
  try {
    target.focus({ preventScroll: true })
  } catch {
    try {
      target.focus()
    } catch {
      /* ignore */
    }
  }
  await douyinSleep(50)
  douyinSimulatePointerClick(target)
  await douyinSleep(160)
  try {
    editor.focus({ preventScroll: true })
  } catch {
    editor.focus()
  }
  await douyinSleep(50)
  douyinSimulatePointerClick(editor)
  await douyinSleep(120)
}

async function fillDouyinNoteComment(
  text: string
): Promise<{ ok: boolean; error?: string; step?: string }> {
  douyinFillDebugLog("note-comment start", { url: location.href })
  if (!isDouyinVideoPageUrl(location.href)) {
    return { ok: false, error: "not_video_page", step: "url" }
  }
  const t = String(text ?? "").trim()
  if (!t) return { ok: false, error: "empty_text", step: "text" }

  try {
    const dock = document.querySelector(
      ".comment-input-container, .comment-input-inner-container, [class*='CommentInput']",
    )
    dock?.scrollIntoView({ block: "end", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await douyinSleep(200)

  await douyinClickMainCommentPlaceholderStrip("before-poll")

  let input: HTMLElement | null = null
  const deadline = Date.now() + 9000
  const pollStart = Date.now()
  let reprimedPlaceholder = false
  while (Date.now() < deadline && !input) {
    const list = collectDouyinVisibleEditablesDeep(undefined)
    input = pickDouyinStandaloneMainComposer(list)
    if (input) break
    if (!reprimedPlaceholder && Date.now() - pollStart > 2400) {
      reprimedPlaceholder = true
      await douyinClickMainCommentPlaceholderStrip("retry-if-no-editor")
    }
    await douyinSleep(120)
  }

  if (!input) {
    douyinFillDebugLog("note-comment fail", "main_composer_not_found")
    return { ok: false, error: "main_composer_not_found", step: "composer" }
  }

  try {
    input.scrollIntoView({ block: "center", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await douyinSleep(80)

  await douyinActivateMainComposerBeforeWrite(input)
  let wrote = await writeDouyinEditor(input, t)
  if (!wrote) {
    douyinFillDebugLog("note-comment retry: second activate + write")
    await douyinActivateMainComposerBeforeWrite(input)
    wrote = await writeDouyinEditor(input, t)
  }
  if (!wrote) {
    douyinFillDebugLog("note-comment fail", "insert_failed", input)
    return {
      ok: false,
      error: "insert_failed",
      step: "write",
    }
  }
  douyinFillDebugLog("note-comment ok")
  return { ok: true }
}

function douyinEditorHasVisibleText(el: HTMLElement): boolean {
  const inner = el.innerText?.replace(/\s+/g, "") ?? ""
  return inner.length > 0
}

async function writeDouyinEditor(el: HTMLElement, text: string): Promise<boolean> {
  el.focus()
  await douyinSleep(40)

  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const ta = el as HTMLTextAreaElement | HTMLInputElement
    ta.value = ""
    ta.value = text
    ta.dispatchEvent(new Event("input", { bubbles: true }))
    ta.dispatchEvent(new Event("change", { bubbles: true }))
    return ta.value.trim().length > 0
  }

  const draft = isDouyinCommentDraftComposer(el)
  if (draft) {
    try {
      const dt = new DataTransfer()
      dt.setData("text/plain", text)
      el.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
      )
      await douyinSleep(100)
      if (douyinEditorHasVisibleText(el)) return true
    } catch (e) {
      douyinFillDebugLog("paste event failed", e)
    }
    try {
      document.execCommand("selectAll", false, undefined)
    } catch {
      /* ignore */
    }
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: text,
        bubbles: true,
        cancelable: true,
      })
    )
    try {
      document.execCommand("insertText", false, text)
    } catch {
      /* ignore */
    }
    await douyinSleep(80)
    if (douyinEditorHasVisibleText(el)) return true
  }

  el.textContent = ""
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data: text,
      bubbles: true,
      cancelable: true,
    })
  )
  try {
    document.execCommand("insertText", false, text)
  } catch {
    /* ignore */
  }
  if (!douyinEditorHasVisibleText(el)) {
    el.textContent = text
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }
  el.focus()
  return douyinEditorHasVisibleText(el)
}

/** 从当前 Draft 向上找较小文本子树，解析「回复@昵称」里的昵称（侧栏底部框进入回复态时出现） */
function douyinReplyTargetNickFromComposerShell(el: HTMLElement): string | null {
  let p: Element | null = el
  for (let depth = 0; depth < 22 && p; depth++) {
    let t = (p.textContent ?? "").replace(/\s+/g, " ")
    if (t.length > 3200) t = t.slice(0, 1800)
    const patterns: RegExp[] = [
      /回复\s*[@＠]\s*([^:：]{1,56})/u,
      /回复\s+[·•]?\s*([^:：\s@＠]{1,36})(?=\s*[:：])/u,
    ]
    for (const re of patterns) {
      const m = t.match(re)
      if (m?.[1]) {
        let nick = m[1].trim().replace(/[《（(].*$/u, "").trim()
        if (
          nick &&
          nick.length <= 48 &&
          !/精彩评论|说点什么|友善评论|发条评论|留下你的|发表/u.test(nick)
        ) {
          return nick
        }
      }
    }
    p = p.parentElement
  }
  return null
}

/**
 * 部分版本底栏不把「回复@」放进可遍历的纯文本，或文案被拆节点；在评论输入壳内粗判「回复」附近是否出现目标昵称。
 */
function douyinComposerShellMentionsAuthorLoose(el: HTMLElement, authorName: string): boolean {
  const a = stripZeroWidthAndNormalizeSpaces(authorName.replace(/^@\s*/, ""))
  const base = a.replace(/(?:[.…．⋯﹒\s]|\u2026)+$/u, "").trim()
  if (base.length < 2 || base === "未知用户") return false
  const shell =
    el.closest(
      ".comment-input-container, .comment-input-inner-container, [class*='CommentInput'], [class*='comment-input'], [class*='CommentEditor'], .DraftEditor-root",
    ) ?? el
  const raw = (shell.textContent ?? "").replace(/\s+/g, " ")
  const t = stripZeroWidthAndNormalizeSpaces(raw.slice(0, 2400))
  if (!/回复/u.test(t)) return false
  if (!t.includes(base)) {
    const prefix = base.slice(0, Math.min(4, base.length))
    if (prefix.length < 2 || !t.includes(prefix)) return false
  }
  const idx回复 = t.search(/回复/u)
  const idxAuthor = t.indexOf(base)
  if (idxAuthor >= 0) return Math.abs(idxAuthor - idx回复) < 200
  const idxP = t.indexOf(base.slice(0, Math.min(4, base.length)))
  return idxP >= 0 && Math.abs(idxP - idx回复) < 200
}

function douyinNickMatchesReplyStrip(stripNick: string, authorName: string): boolean {
  const a = stripZeroWidthAndNormalizeSpaces(authorName.replace(/^@\s*/, ""))
  const b = stripZeroWidthAndNormalizeSpaces(stripNick.replace(/^@\s*/, ""))
  if (!a || a === "未知用户" || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const baseA = a.replace(/(?:[.…．⋯﹒\s]|\u2026)+$/u, "").trim()
  const baseB = b.replace(/(?:[.…．⋯﹒\s]|\u2026)+$/u, "").trim()
  if (baseA.length >= 2 && baseB.length >= 2 && (baseA.startsWith(baseB) || baseB.startsWith(baseA))) return true
  return false
}

function douyinBottomComposerMatchesReplyTarget(bottom: HTMLElement, authorName: string): boolean {
  const nick = douyinReplyTargetNickFromComposerShell(bottom)
  return Boolean(nick && douyinNickMatchesReplyStrip(nick, authorName))
}

/**
 * 能否向该 bottom 写入「对 authorName 的回复」：严格「回复@」匹配 / 壳内昵称 / 该行按钮已为「回复中」。
 */
function douyinBottomComposerUsableForReply(
  bottom: HTMLElement,
  authorName: string,
  replyBtn: HTMLElement | null,
): boolean {
  if (!authorName || authorName === "未知用户") return true
  if (douyinBottomComposerMatchesReplyTarget(bottom, authorName)) return true
  if (douyinComposerShellMentionsAuthorLoose(bottom, authorName)) return true
  if (replyBtn && douyinReplyControlShowsReplying(replyBtn)) return true
  return false
}

/** 底部主框已在「回复@目标作者」态（或等价）时可先写入 */
function findDouyinBottomComposerIfReplyingToAuthor(
  authorName: string,
  commentRoot: Element,
  replyBtn: HTMLElement | null,
): HTMLElement | null {
  const list = collectDouyinVisibleEditablesDeep(commentRoot)
  const bottom = pickDouyinBottomMainComposer(list, commentRoot)
  if (!(bottom instanceof HTMLElement)) return null
  return douyinBottomComposerUsableForReply(bottom, authorName, replyBtn) ? bottom : null
}

/** 程序化 `click()` 后 focus 仍在 BODY、editables 恒为 0 时，用视口坐标模拟指针（更接近真实点击） */
function douyinSimulatePointerClick(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  const x = r.left + Math.max(1, r.width / 2)
  const y = r.top + Math.max(1, r.height / 2)
  const base: MouseEventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }
  const ptr: PointerEventInit = {
    ...base,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  }
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", ptr))
    el.dispatchEvent(new MouseEvent("mousedown", base))
    el.dispatchEvent(new PointerEvent("pointerup", ptr))
    el.dispatchEvent(new MouseEvent("mouseup", base))
    el.dispatchEvent(new MouseEvent("click", base))
  } catch {
    try {
      el.click()
    } catch {
      /* ignore */
    }
  }
}

async function fillDouyinReply(
  platformCommentId: string,
  text: string
): Promise<{ ok: boolean; error?: string; step?: string }> {
  douyinFillDebugLog("start", { platformCommentId, url: location.href })

  if (!isDouyinVideoPageUrl(location.href)) {
    douyinFillDebugLog("fail", "not_video_page")
    return { ok: false, error: "not_video_page", step: "url" }
  }
  const root = findDouyinCommentRootByPlatformId(platformCommentId)
  if (!root) {
    douyinFillDebugLog("fail", "comment_not_found", {
      roots: findLikelyCommentRoots().length,
      sampleIds: findLikelyCommentRoots()
        .slice(0, 5)
        .map((r) => scrapeCommentRoot(r, ingestPostUrl())?.platformCommentId),
    })
    return { ok: false, error: "comment_not_found", step: "root" }
  }
  douyinFillDebugLog("found root")

  try {
    root.scrollIntoView({ block: "center", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await douyinSleep(180)

  const replyBtn = findDouyinReplyControlInRoot(root)
  if (!replyBtn) {
    douyinFillDebugLog("fail", "reply_btn_not_found")
    return { ok: false, error: "reply_btn_not_found", step: "reply_btn" }
  }
  const replySpan = findDouyinReplySpanUnderHost(replyBtn) ?? findDouyinReplyLabelSpanInRoot(root)
  douyinFillDebugLog("found replyBtn", replyBtn, {
    replySpan: replySpan ?? null,
    hasBubbleSvg: douyinReplyHostHasCommentBubbleIcon(replyBtn),
    replyInsideRoot: root.contains(replyBtn),
    platformCommentId,
  })
  if (!root.contains(replyBtn)) {
    douyinFillDebugLog("warn: reply control is not under this comment root — may be wrong row")
  }

  if (douyinReplyHostIndicatesXiguaOnlyReply(replyBtn)) {
    douyinFillDebugLog("fail", "reply_redirects_to_xigua (tooltip: 前往西瓜视频回复评论)")
    return { ok: false, error: "reply_redirects_to_xigua", step: "reply_btn" }
  }

  const scrapedRow = scrapeCommentRoot(root, ingestPostUrl())
  const authorForReply = scrapedRow?.authorName?.trim() ?? ""
  const wantAuthorVerify = Boolean(authorForReply) && authorForReply !== "未知用户"
  douyinFillDebugLog("reply target author", authorForReply, { wantAuthorVerify })

  /**
   * 侧栏点「回复」无反应的根因：底栏 Draft 一直在 DOM，旧逻辑误判「已可用」而跳过了点该条「回复」。
   * 只有该条已是「回复中」且底栏已绑定目标作者时，才跳过程序化点击。
   */
  let input: HTMLElement | null = null
  if (douyinReplyControlShowsReplying(replyBtn)) {
    if (wantAuthorVerify) {
      input = findDouyinBottomComposerIfReplyingToAuthor(authorForReply, root, replyBtn)
    } else {
      const listEarly = collectDouyinVisibleEditablesDeep(root)
      input = pickDouyinBottomMainComposer(listEarly, root)
    }
    if (input) {
      douyinFillDebugLog("row already 回复中 and composer looks bound, skip reply click", input)
    }
  }

  if (!input) {
    const beforeSnap = collectDouyinVisibleEditablesDeep(root).map(snapshotDouyinEditable)

    /**
     * 抖音 Web 上同一「回复」控件连点/多点常在「回复」↔「回复中」之间**切换**；
     * 先 pointer 再点父层、再 Space/Enter 容易被当成第二次操作而**关掉**回复态。
     * 策略：同一轮只点 **一个** 目标、最多 **pointer + 一次可选 click**；不在回复按钮上发 Space/Enter。
     */
    douyinFillDebugLog("open reply: single-target (avoid toggling 回复中 off)")
    const scrollEl = replySpan ?? replyBtn
    try {
      scrollEl.scrollIntoView({ block: "nearest", behavior: "auto" })
    } catch {
      /* ignore */
    }
    await douyinSleep(60)
    try {
      replyBtn.focus({ preventScroll: true })
    } catch {
      replyBtn.focus()
    }
    await douyinSleep(50)
    const primaryTarget = replySpan && replySpan !== replyBtn ? replySpan : replyBtn
    douyinSimulatePointerClick(primaryTarget)
    await douyinSleep(420)
    if (!douyinReplyControlShowsReplying(replyBtn)) {
      try {
        primaryTarget.click()
      } catch {
        /* ignore */
      }
      await douyinSleep(320)
    }

    douyinFillDebugLog("已尝试单次打开「回复」，等待底栏绑定（约 10s）…")

    const deadline = Date.now() + 10_000
    const loopStart = Date.now()
    let lastPollLog = 0
    let retriedReplyClick = false
    while (Date.now() < deadline && !input) {
      const list = collectDouyinVisibleEditablesDeep(root)

      if (!retriedReplyClick && Date.now() - loopStart > 2800 && list.length === 0) {
        retriedReplyClick = true
        if (douyinReplyControlShowsReplying(replyBtn)) {
          douyinFillDebugLog("skip retry click: already 回复中 (0 editables → scan/bind delay, not toggle)")
        } else {
          douyinFillDebugLog("retry: single pointer + optional click (still not 回复中)")
          const t = replySpan && replySpan !== replyBtn ? replySpan : replyBtn
          douyinSimulatePointerClick(t)
          await douyinSleep(350)
          try {
            t.click()
          } catch {
            /* ignore */
          }
        }
      }

      const now = Date.now()
      if (now - lastPollLog > 900) {
        lastPollLog = now
        douyinFillDebugLog("poll", {
          editables: list.length,
          msLeft: deadline - now,
          active: document.activeElement?.tagName,
        })
      }

      const bottomMain = pickDouyinBottomMainComposer(list, root)
      if (bottomMain) {
        if (!wantAuthorVerify || douyinBottomComposerUsableForReply(bottomMain, authorForReply, replyBtn)) {
          input = bottomMain
          douyinFillDebugLog("picked composer (bottom main)", bottomMain, {
            replyingUi: douyinReplyControlShowsReplying(replyBtn),
          })
          break
        }
        douyinFillDebugLog("bottom main visible but not yet usable for target author", authorForReply, {
          replyingUi: douyinReplyControlShowsReplying(replyBtn),
          nickFromShell: douyinReplyTargetNickFromComposerShell(bottomMain),
        })
      }

      const active = document.activeElement
      if (active instanceof HTMLElement) {
        const ae =
          active.closest?.(
            "textarea, input[type='text'], [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']",
          ) ??
          (active.matches?.(
            "textarea, input[type='text'], [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']",
          )
            ? active
            : null)
        if (ae instanceof HTMLElement && isDouyinElementVisible(ae) && list.includes(ae) && !isDouyinSearchOrNonCommentInput(ae)) {
          const insideRoot = root.contains(ae)
          if (!insideRoot || isDouyinCommentDraftComposer(ae)) {
            if (wantAuthorVerify) {
              if (douyinBottomComposerUsableForReply(ae, authorForReply, replyBtn)) {
                input = ae
                douyinFillDebugLog("picked composer (active, reply target ok)", ae, { insideRoot })
                break
              }
            } else {
              input = ae
              douyinFillDebugLog("picked composer (active)", ae, { insideRoot })
              break
            }
          }
        }
      }

      const snap = list.map(snapshotDouyinEditable)
      const changed = snap.length !== beforeSnap.length || snap.some((s, i) => s !== beforeSnap[i])
      if (changed && list.length > 0) {
        const main = pickDouyinBottomMainComposer(list, root)
        if (main && !isDouyinSearchOrNonCommentInput(main)) {
          if (!wantAuthorVerify || douyinBottomComposerUsableForReply(main, authorForReply, replyBtn)) {
            input = main
            douyinFillDebugLog("picked composer (changed+main)", main)
            break
          }
        }
        if (!wantAuthorVerify) {
          const near = pickDouyinEditableNearRoot(root, list)
          if (near && !isDouyinSearchOrNonCommentInput(near)) {
            if (!root.contains(near) || isDouyinCommentDraftComposer(near)) {
              input = near
              douyinFillDebugLog("picked composer (changed+near)", near)
              break
            }
          }
        }
      }

      await douyinSleep(120)
    }
  }

  if (!input) {
    const salvage = collectDouyinVisibleEditablesDeep(root)
    if (wantAuthorVerify) {
      const bottom = pickDouyinBottomMainComposer(salvage, root)
      if (bottom && douyinBottomComposerUsableForReply(bottom, authorForReply, replyBtn)) {
        input = bottom
        douyinFillDebugLog("salvage: bottom composer usable for reply", bottom)
      }
    }
    if (!input) {
      const sp =
        (!wantAuthorVerify ? pickDouyinBottomMainComposer(salvage, root) : null) ??
        (!wantAuthorVerify ? salvage.find((h) => isDouyinCommentDraftComposer(h)) : null) ??
        null
      if (sp) {
        input = sp
        douyinFillDebugLog("salvage picked composer", sp)
      }
    }
  }

  if (!input) {
    const n = collectDouyinVisibleEditablesDeep(root).length
    douyinFillDebugLog("fail", "composer_needs_manual_open", { editables: n })
    douyinFillDebugWarn("需先在页面手动点该评论「回复」", { editables: n })
    return { ok: false, error: "composer_needs_manual_open", step: "composer" }
  }

  try {
    input.scrollIntoView({ block: "nearest", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await douyinSleep(50)

  const wrote = await writeDouyinEditor(input, text)
  douyinFillDebugLog("write result", wrote, input)
  if (!wrote) {
    douyinFillDebugWarn("失败 insert_failed")
    return { ok: false, error: "insert_failed", step: "write" }
  }

  douyinFillDebugLog("fill: 成功")
  return { ok: true }
}

// ─── 滚动联动 ───
let douyinScrollRaf: number | null = null
let douyinLastSentId: string | null = null

function platformIdForCommentRoot(el: Element): string | null {
  const row = scrapeCommentRoot(el, ingestPostUrl())
  return row?.platformCommentId ?? null
}

function findDouyinCommentAtViewportCenter(): string | null {
  const roots = findLikelyCommentRoots()
  if (roots.length === 0) return null
  const cy = globalThis.innerHeight / 2
  let best: string | null = null
  let bestDist = Infinity
  for (const el of roots) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    const mid = rect.top + rect.height / 2
    const d = Math.abs(mid - cy)
    if (d < bestDist) {
      bestDist = d
      const pid = platformIdForCommentRoot(el)
      if (pid) best = pid
    }
  }
  return best
}

function onDouyinScroll() {
  if (douyinScrollRaf != null) return
  douyinScrollRaf = requestAnimationFrame(() => {
    douyinScrollRaf = null
    const id = findDouyinCommentAtViewportCenter()
    if (id && id !== douyinLastSentId) {
      douyinLastSentId = id
      chrome.runtime
        .sendMessage({ type: "SCROLL_TO_COMMENT", payload: { platformCommentId: id } })
        .catch(() => {})
    }
  })
}

function getScrollParent(el: Element): Element | typeof window {
  let p: Element | null = el.parentElement
  while (p) {
    const st = getComputedStyle(p)
    const oy = st.overflowY
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return p
    p = p.parentElement
  }
  return window
}

let douyinScrollTarget: Element | typeof window | null = null
let douyinScrollExtras: Element[] = []

function setupDouyinScrollSync() {
  douyinLastSentId = null
  if (douyinScrollTarget) {
    douyinScrollTarget.removeEventListener("scroll", onDouyinScroll, true)
    douyinScrollTarget = null
  }
  for (const el of douyinScrollExtras) {
    el.removeEventListener("scroll", onDouyinScroll, true)
  }
  douyinScrollExtras = []

  if (!isDouyinContentTargetUrl(location.href)) return

  window.addEventListener("scroll", onDouyinScroll, true)
  douyinScrollTarget = window

  const first = findLikelyCommentRoots()[0]
  if (first) {
    const sp = getScrollParent(first)
    if (sp !== window) {
      sp.addEventListener("scroll", onDouyinScroll, true)
      douyinScrollExtras.push(sp as Element)
    }
  }
  onDouyinScroll()
}

;(function bootYanlingDouyinContentScript() {
  const G = globalThis as unknown as { __yanlingDouyinContentScriptBoot?: boolean }
  if (G.__yanlingDouyinContentScriptBoot) return
  G.__yanlingDouyinContentScriptBoot = true

  const origPush = history.pushState.bind(history)
  history.pushState = function (...args) {
    origPush(...args)
    onUrlChange()
  }
  const origReplace = history.replaceState.bind(history)
  history.replaceState = function (...args) {
    origReplace(...args)
    onUrlChange()
  }
  window.addEventListener("popstate", onUrlChange)

  function onUrlChange() {
    currentUrl = location.href
    ingestDeduper.clear()
    lastDouyinDomCommentSig = ""
    clearDouyinCommentAccumulation()
    clearDouyinLoggedInProfileIdCache()
    chrome.runtime.sendMessage({ type: "URL_CHANGED", payload: { url: currentUrl } }).catch(() => {})
    setTimeout(() => void initialScan(), 900)
    setTimeout(() => setupDouyinScrollSync(), 1000)
  }

  const observer = new MutationObserver(runThrottledScan)

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "FILL_REPLY") {
      const { platformCommentId, text } = (message as { payload?: { platformCommentId?: string; text?: string } })
        .payload ?? {}
      douyinFillDebugLog("FILL_REPLY received", {
        platformCommentId: String(platformCommentId ?? ""),
        textLen: String(text ?? "").length,
      })
      void fillDouyinReply(String(platformCommentId ?? ""), String(text ?? ""))
        .then(sendResponse)
        .catch((e) => {
          console.error("[CommentCopilot][douyin] FILL_REPLY", e)
          sendResponse({ ok: false, error: String(e) })
        })
      return true
    }
    if (message.type === "FILL_NOTE_COMMENT") {
      const { text } = (message as { payload?: { text?: string } }).payload ?? {}
      void fillDouyinNoteComment(String(text ?? ""))
        .then(sendResponse)
        .catch((e) => {
          console.error("[CommentCopilot][douyin] FILL_NOTE_COMMENT", e)
          sendResponse({ ok: false, error: String(e) })
        })
      return true
    }
    if (message.type === "GET_ALL_PAGE_COMMENTS") {
      void getAllPageComments()
        .then(sendResponse)
        .catch((e) => {
          console.error("[CommentCopilot][douyin] GET_ALL_PAGE_COMMENTS", e)
          sendResponse([])
        })
      return true
    }
    if (message.type === "GET_POST_CONTENT") {
      // 壳层无 modal_id 时仍尝试从 DOM 刮标题/简介，供主评与回复 AI 上下文（与侧栏「视频跟评」一致）
      if (!isDouyinContentTargetUrl(location.href)) {
        sendResponse({ postTitle: "", postContent: "", postUrl: currentUrl })
      } else {
        sendResponse(getDouyinPostContent())
      }
      return false
    }
    return false
  })

  setTimeout(() => {
    void initialScan()
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => setupDouyinScrollSync(), 500)
  }, 500)
})()
