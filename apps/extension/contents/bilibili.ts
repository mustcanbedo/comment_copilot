/**
 * 哔哩哔哩站点 content script：与 `xiaohongshu.ts` 并行，通过 URL（`isBilibiliVideoPageUrl`）
 * 决定是否启用评论采集。
 *
 * 评论区 DOM（2024+ 常见结构，多层 open shadow）：
 * `bili-comments` → shadow → `bili-comment-thread-renderer` → shadow →
 *   `bili-comment-renderer#comment` → shadow → `#body` → `a#user-avatar`（`data-user-profile-id` / space URL）、
 *   `#main` → `#content` → `bili-rich-text` → shadow → `p#contents`（正文 + 表情 `img[alt]`）；
 * 同线程下还有 `#replies` / `#reply-container` 承载楼中楼，以及 `bili-comment-replies-renderer` 等。
 *
 * 解析顺序：`__data`（与接口字段一致）→ 穿透 shadow 读 `#body` 兜底。
 */
import type { PlasmoCSConfig } from "plasmo"

import { isBilibiliVideoPageUrl } from "../constants"
import {
  createCommentIngestDeduper,
  createThrottledScan,
  simpleHash,
  type ContentFillResult,
} from "./shared/platform-content-utils"

export const config: PlasmoCSConfig = {
  matches: ["https://www.bilibili.com/*", "https://bilibili.com/*"],
  run_at: "document_idle",
  all_frames: false,
}

interface ScrapedComment {
  platformCommentId: string
  authorName: string
  /** 评论者 mid（有则用于排除当前登录用户自己的评论） */
  authorMid?: number
  content: string
  commentedAt: string
  postUrl: string
}

/** B 站评论接口中单条 reply 的常见字段（与页面上 `__data` 对齐，字段缺失时做兜底） */
interface BiliReplyLike {
  rpid?: number
  mid?: number
  ctime?: number
  content?: { message?: string } | string
  member?: { uname?: string; mid?: number; name?: string }
}

let currentUrl = location.href

function readWebComponentData(el: Element | null | undefined): unknown {
  if (!el) return undefined
  const h = el as HTMLElement & { __data?: unknown }
  return h.__data
}

function messageToPlainText(message: string): string {
  const s = message.trim()
  if (!s.includes("<")) return s.replace(/\s+/g, " ").trim()
  try {
    const doc = new DOMParser().parseFromString(s, "text/html")
    return (doc.body?.innerText ?? s).replace(/\s+/g, " ").trim()
  } catch {
    return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  }
}

/** `__data` 里 rpid 可能在顶层或嵌套在 reply / comment / item 等字段 */
function tryParsePositiveMid(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v)
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim())
    return n > 0 ? n : null
  }
  return null
}

/** 从 `__data` 合并结构里取评论者 member.mid */
function extractAuthorMidFromBiliMerged(raw: Record<string, unknown>, merged: BiliReplyLike): number | null {
  let m = tryParsePositiveMid(merged.member?.mid)
  if (m != null) return m
  const topMem = raw.member
  if (topMem && typeof topMem === "object") {
    m = tryParsePositiveMid((topMem as Record<string, unknown>).mid)
    if (m != null) return m
  }
  for (const k of ["reply", "comment", "item", "root"]) {
    const sub = raw[k]
    if (!sub || typeof sub !== "object") continue
    const o = sub as Record<string, unknown>
    const mem = o.member
    if (mem && typeof mem === "object") {
      m = tryParsePositiveMid((mem as Record<string, unknown>).mid)
      if (m != null) return m
    }
    m = tryParsePositiveMid(o.mid)
    if (m != null) return m
  }
  return null
}

function extractRpidFromBiliData(data: unknown): number | null {
  if (!data || typeof data !== "object") return null
  const tryNum = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim())
    return null
  }
  const d = data as Record<string, unknown>
  let r = tryNum(d.rpid)
  if (r != null) return r
  for (const key of ["reply", "comment", "item", "data", "root", "source"]) {
    const o = d[key]
    if (o && typeof o === "object") {
      r = tryNum((o as Record<string, unknown>).rpid)
      if (r != null) return r
    }
  }
  return null
}

function parseBiliReplyData(data: unknown, postUrl: string): ScrapedComment | null {
  if (!data || typeof data !== "object") return null
  const raw = data as Record<string, unknown>
  const rpid = extractRpidFromBiliData(data)
  if (rpid == null) return null

  const merged: BiliReplyLike = { ...(raw as BiliReplyLike) }
  for (const k of ["reply", "comment", "item"]) {
    const sub = raw[k]
    if (!sub || typeof sub !== "object") continue
    const s = sub as Record<string, unknown>
    if (merged.content == null && s.content != null) merged.content = s.content as BiliReplyLike["content"]
    if (merged.member == null && s.member != null) merged.member = s.member as BiliReplyLike["member"]
    if (merged.ctime == null && typeof s.ctime === "number") merged.ctime = s.ctime
  }

  let rawContent = ""
  if (typeof merged.content === "string") rawContent = merged.content
  else if (merged.content && typeof merged.content === "object") {
    const c = merged.content as Record<string, unknown>
    if (typeof c.message === "string") rawContent = c.message
    else if (typeof c.text === "string") rawContent = c.text
  }
  let content = messageToPlainText(rawContent).slice(0, 4000)
  if (!content) content = "（评论正文未解析，可反馈开发者）"

  const authorName =
    (typeof merged.member?.uname === "string" && merged.member.uname.trim()) ||
    (typeof merged.member?.name === "string" && merged.member.name.trim()) ||
    "未知用户"

  const authorMid = extractAuthorMidFromBiliMerged(raw, merged)

  let commentedAt = ""
  if (typeof merged.ctime === "number" && Number.isFinite(merged.ctime)) {
    try {
      commentedAt = new Date(merged.ctime * 1000).toISOString()
    } catch {
      commentedAt = ""
    }
  }

  return {
    platformCommentId: `bilibili:rpid:${rpid}`,
    authorName,
    ...(authorMid != null ? { authorMid } : {}),
    content,
    commentedAt,
    postUrl,
  }
}

function midFromUserAvatarInBody(body: Element): string | null {
  const a = body.querySelector("a#user-avatar")
  if (!a) return null
  const fromData =
    a.getAttribute("data-user-profile-id") ??
    a.getAttribute("data-user-id") ??
    a.getAttribute("data-mid")
  if (fromData && /^\d+$/.test(fromData.trim())) return fromData.trim()
  const href = a.getAttribute("href") ?? ""
  const m = href.match(/space\.bilibili\.com\/(\d+)/i) ?? href.match(/\/(\d+)\/?(?:\?|$)/)
  return m?.[1] ?? null
}

function authorFromCommentBody(body: Element): string {
  const candidates: (Element | null | undefined)[] = [
    body.querySelector("#user-name"),
    body.querySelector("[id*='user-name']"),
    body.querySelector(".user-name"),
    body.querySelector(".uname"),
    body.querySelector("a#user-avatar + *"),
    body.querySelector("bili-user-name"),
  ]
  for (const el of candidates) {
    const t = el?.textContent?.replace(/\s+/g, " ").trim()
    if (t && t.length > 0 && t.length < 128) return t
  }
  const avatar = body.querySelector("a#user-avatar, a[id='user-avatar']")
  if (avatar?.parentElement) {
    const link = avatar.parentElement.querySelector("a[href*='space.bilibili.com']")
    const t = link?.textContent?.replace(/\s+/g, " ").trim()
    if (t && t.length > 1 && t.length < 64 && !/^lv\.?\d+$/i.test(t)) return t
  }
  return "未知用户"
}

function isLikelyBilibiliNicknameText(t: string): boolean {
  const s = t.replace(/\s+/g, " ").trim()
  if (s.length < 1 || s.length > 80) return false
  if (s === "未知用户") return false
  if (/^lv\.?\d+$/i.test(s)) return false
  if (/^[\d\s·]+$/.test(s)) return false
  const ban = ["回复", "点赞", "举报", "置顶", "热评", "转发", "分享", "收藏"]
  if (ban.some((w) => s === w || s.startsWith(`${w} `))) return false
  return true
}

/** 从 `__data` 各层 member 抓昵称（parseBiliReplyData 已失败或 author 为空时） */
function extractAuthorNameFromLooseBiliData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const raw = data as Record<string, unknown>
  const tryMember = (m: unknown): string | null => {
    if (!m || typeof m !== "object") return null
    const o = m as Record<string, unknown>
    for (const key of ["uname", "name", "nickname", "userName"]) {
      const v = o[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    return null
  }
  let n = tryMember(raw.member)
  if (n) return n
  for (const k of ["reply", "comment", "item", "root"]) {
    const sub = raw[k]
    if (!sub || typeof sub !== "object") continue
    n = tryMember((sub as Record<string, unknown>).member)
    if (n) return n
  }
  return null
}

/**
 * 新版评论区昵称多在 `bili-user-name` 的 open shadow 里，浅层 querySelector 读不到。
 * 对 `#body` 子树做 shadow BFS，并收集 space 个人页链接文案。
 */
function authorFromCommentBodyDeep(body: Element): string {
  const quick = authorFromCommentBody(body)
  if (quick !== "未知用户") return quick

  const stack: (Element | ShadowRoot)[] = [body]
  const seen = new Set<unknown>()
  const names: string[] = []
  let iterations = 0
  const maxIterations = 2800

  const pushName = (raw: string | null | undefined) => {
    const t = raw?.replace(/\s+/g, " ").trim() ?? ""
    if (!isLikelyBilibiliNicknameText(t)) return
    names.push(t)
  }

  while (stack.length && iterations++ < maxIterations) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)

    if (cur instanceof ShadowRoot) {
      cur.querySelectorAll("a[href*='space.bilibili.com']").forEach((a) => pushName(a.textContent))
      cur.querySelectorAll("bili-user-name").forEach((h) => {
        pushName(h.textContent)
        if (h.shadowRoot) stack.push(h.shadowRoot)
      })
      for (const sel of ["#user-name", "[id*='user-name']", ".user-name", ".uname", "[class*='user-name']"]) {
        cur.querySelectorAll(sel).forEach((el) => pushName(el.textContent))
      }
      cur.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) stack.push(el.shadowRoot)
      })
      continue
    }

    const el = cur
    if (el.shadowRoot) stack.push(el.shadowRoot)
    for (const child of el.children) stack.push(child as Element)
  }

  if (names.length === 0) return "未知用户"
  const uniq = [...new Set(names)]
  uniq.sort((a, b) => a.length - b.length)
  return uniq[0]!
}

/**
 * 新版评论区：#body → #main → #content → bili-rich-text → shadow → p#contents（含 span + 表情 img）
 * `textContent` 不会带上 img 的 alt，需把 [吃瓜] 等拼进正文。
 */
function plainTextWithImgAlt(root: Element): string {
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll("img[alt]").forEach((img) => {
    const alt = (img.getAttribute("alt") ?? "").trim()
    img.replaceWith(document.createTextNode(alt || ""))
  })
  return clone.textContent?.replace(/\s+/g, " ").trim() ?? ""
}

function textFromBiliRichTextHosts(root: ParentNode): string {
  const hosts = root.querySelectorAll(
    "#main #content bili-rich-text, #content bili-rich-text, bili-rich-text"
  )
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]!
    const sr = host.shadowRoot
    if (!sr) continue
    const p = sr.querySelector("p#contents, #contents") ?? sr.querySelector("p")
    if (p) {
      const t = plainTextWithImgAlt(p)
      if (t.length >= 1) return t.slice(0, 4000)
    }
    const fallback = plainTextWithImgAlt(sr)
    if (fallback.length >= 1) return fallback.slice(0, 4000)
  }
  return ""
}

function contentFromCommentBody(body: HTMLElement): string {
  const fromRich = textFromBiliRichTextHosts(body)
  if (fromRich) return fromRich

  const contentSelectors = [
    "#main #content",
    "#content",
    "#detail",
    ".reply-content",
    "#message",
    ".text:not(.reply-time)",
    "[class*='detail']",
    "[class*='content']",
  ]
  const trySelectors = (root: Document | ShadowRoot | HTMLElement) => {
    for (const sel of contentSelectors) {
      const el = root.querySelector(sel)
      if (!el) continue
      const t = plainTextWithImgAlt(el)
      if (t.length >= 2) return t.slice(0, 4000)
      const text = el.textContent?.replace(/\s+/g, " ").trim()
      if (text && text.length >= 2) return text.slice(0, 4000)
    }
    return ""
  }

  const direct = trySelectors(body)
  if (direct) return direct

  // 正文常包在 `#body` 内子级 web component 的 shadow 里
  const descendants = body.querySelectorAll("*")
  for (let i = 0; i < descendants.length; i++) {
    const sr = descendants[i]!.shadowRoot
    if (!sr) continue
    const inner = textFromBiliRichTextHosts(sr)
    if (inner) return inner
    const inner2 = trySelectors(sr)
    if (inner2) return inner2
  }

  const clone = body.cloneNode(true) as HTMLElement
  clone.querySelector("a#user-avatar")?.remove()
  clone.querySelectorAll("bili-avatar").forEach((n) => n.remove())
  clone.querySelectorAll("time, .reply-time, .reply-btn, button").forEach((n) => n.remove())
  return clone.innerText.replace(/\s+/g, " ").trim().slice(0, 4000)
}

/** 从 `bili-comment-renderer` / `bili-comment-reply-renderer` 解析一条评论 */
function scrapeFromCommentRendererHost(host: Element, postUrl: string): ScrapedComment | null {
  const tag = host.tagName.toLowerCase()
  if (tag !== "bili-comment-renderer" && tag !== "bili-comment-reply-renderer") {
    return parseBiliReplyData(readWebComponentData(host), postUrl)
  }

  let data = readWebComponentData(host)
  const attrRpid = host.getAttribute("data-rpid") ?? host.getAttribute("rpid")
  if (
    attrRpid &&
    /^\d+$/.test(attrRpid) &&
    data &&
    typeof data === "object" &&
    (data as BiliReplyLike).rpid == null
  ) {
    data = { ...(data as object), rpid: Number(attrRpid) }
  }

  let fromData = parseBiliReplyData(data, postUrl)
  if (fromData) {
    if (!fromData.authorName?.trim() || fromData.authorName === "未知用户") {
      const loose = extractAuthorNameFromLooseBiliData(data)
      if (loose) fromData = { ...fromData, authorName: loose }
    }
    const srEarly = host.shadowRoot
    const bodyEarly = srEarly?.querySelector("#body") as HTMLElement | null
    if (bodyEarly && (!fromData.authorName?.trim() || fromData.authorName === "未知用户")) {
      const domName = authorFromCommentBodyDeep(bodyEarly)
      if (domName !== "未知用户") fromData = { ...fromData, authorName: domName }
    }
    return fromData
  }

  const sr = host.shadowRoot
  if (!sr) return null
  const body = sr.querySelector("#body") as HTMLElement | null
  if (!body) return null

  const content = contentFromCommentBody(body)
  if (!content || content.length < 1) return null

  const mid = midFromUserAvatarInBody(body)
  const authorName =
    extractAuthorNameFromLooseBiliData(data) ||
    authorFromCommentBodyDeep(body)
  const id = mid
    ? `bilibili:mid:${mid}:${simpleHash(content.slice(0, 180))}`
    : `bilibili:dom:${simpleHash(postUrl + content.slice(0, 200))}`

  const authorMidNum = mid ? Number(mid) : undefined

  return {
    platformCommentId: id,
    authorName,
    ...(authorMidNum != null && Number.isFinite(authorMidNum) ? { authorMid: authorMidNum } : {}),
    content,
    commentedAt: "",
    postUrl,
  }
}

/**
 * 穿透页面内所有 open ShadowRoot 查找（B 站常把 `bili-comments` 包在组件 shadow 内，document 直接 query 会失败）。
 * 上限需大于典型页面的 shadow 层数：实测约需遍历 400+ 个 root 才能命中评论区，留足余量避免截断。
 */
const DEEP_QUERY_MAX_ROOTS = 5000

function querySelectorDeep(selector: string): Element | null {
  const queue: (Document | ShadowRoot)[] = [document]
  const seen = new Set<Document | ShadowRoot>()
  let n = 0
  while (queue.length && n < DEEP_QUERY_MAX_ROOTS) {
    const root = queue.shift()!
    if (seen.has(root)) continue
    seen.add(root)
    n++
    const hit = root.querySelector(selector)
    if (hit) return hit
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) queue.push(el.shadowRoot)
    })
  }
  return null
}

function querySelectorAllDeep(selector: string): Element[] {
  const results: Element[] = []
  const queue: (Document | ShadowRoot)[] = [document]
  const seen = new Set<Document | ShadowRoot>()
  let n = 0
  while (queue.length && n < DEEP_QUERY_MAX_ROOTS) {
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

/** 线程列表：优先 `bili-comments` 的 shadow；否则全树深搜 `bili-comment-thread-renderer` */
function queryAllThreadRenderers(): Element[] {
  const host = document.querySelector("bili-comments") ?? querySelectorDeep("bili-comments")
  if (host?.shadowRoot) {
    const inShadow = host.shadowRoot.querySelectorAll("bili-comment-thread-renderer")
    if (inShadow.length > 0) return Array.from(inShadow)
  }
  const deepThreads = querySelectorAllDeep("bili-comment-thread-renderer")
  if (deepThreads.length > 0) return deepThreads
  return Array.from(document.querySelectorAll("bili-comment-thread-renderer"))
}

/**
 * 主楼：`bili-comment-renderer#comment`（你提供的结构）；再尝试 `#comment`。
 * 楼中楼：`#replies` / `#reply-container` 内组件 + `bili-comment-replies-renderer` shadow 内回复。
 */
function collectFromThread(threadEl: Element, postUrl: string, seen: Set<string>, out: ScrapedComment[]) {
  const threadRoot = threadEl.shadowRoot
  if (!threadRoot) return

  const mainRenderer =
    (threadRoot.querySelector("bili-comment-renderer#comment") as Element | null) ??
    threadRoot.querySelector("#comment")

  const push = (row: ScrapedComment | null) => {
    if (!row || seen.has(row.platformCommentId)) return
    seen.add(row.platformCommentId)
    out.push(row)
  }

  if (mainRenderer) {
    push(scrapeFromCommentRendererHost(mainRenderer, postUrl))
  } else {
    push(parseBiliReplyData(readWebComponentData(threadEl), postUrl))
  }

  const subSet = new Set<Element>()

  for (const rootSel of ["#replies", "#reply-container"]) {
    const root = threadRoot.querySelector(rootSel)
    if (!root) continue
    root.querySelectorAll("bili-comment-reply-renderer, bili-comment-renderer").forEach((el) => {
      if (el === mainRenderer) return
      if (el.matches("bili-comment-renderer#comment")) return
      subSet.add(el)
    })
  }

  const repliesRenderer = threadRoot.querySelector("bili-comment-replies-renderer")
  const repShadow = repliesRenderer?.shadowRoot
  if (repShadow) {
    for (const sel of ["#expander-contents bili-comment-reply-renderer", "bili-comment-reply-renderer"]) {
      repShadow.querySelectorAll(sel).forEach((el) => subSet.add(el))
    }
  }

  subSet.forEach((subEl) => {
    push(scrapeFromCommentRendererHost(subEl, postUrl))
  })
}

/** 与 collectFromThread 同序枚举所有 `bili-comment-renderer` / `bili-comment-reply-renderer` */
function listAllCommentRendererHosts(): Element[] {
  const out: Element[] = []
  const seen = new Set<Element>()
  const add = (el: Element | null | undefined) => {
    if (!el || seen.has(el)) return
    seen.add(el)
    out.push(el)
  }
  for (const threadEl of queryAllThreadRenderers()) {
    const threadRoot = threadEl.shadowRoot
    if (!threadRoot) continue
    const mainRenderer =
      (threadRoot.querySelector("bili-comment-renderer#comment") as Element | null) ??
      threadRoot.querySelector("#comment")
    add(mainRenderer)

    const subSet = new Set<Element>()
    for (const rootSel of ["#replies", "#reply-container"]) {
      const root = threadRoot.querySelector(rootSel)
      if (!root) continue
      root.querySelectorAll("bili-comment-reply-renderer, bili-comment-renderer").forEach((el) => {
        if (el === mainRenderer) return
        if (el.matches("bili-comment-renderer#comment")) return
        subSet.add(el)
      })
    }
    const repliesRenderer = threadRoot.querySelector("bili-comment-replies-renderer")
    const repShadow = repliesRenderer?.shadowRoot
    if (repShadow) {
      for (const sel of ["#expander-contents bili-comment-reply-renderer", "bili-comment-reply-renderer"]) {
        repShadow.querySelectorAll(sel).forEach((el) => subSet.add(el))
      }
    }
    subSet.forEach((el) => add(el))
  }
  return out
}

function findCommentHostForPlatformId(platformCommentId: string): Element | null {
  const m = platformCommentId.match(/^bilibili:rpid:(\d+)$/)
  if (m) {
    const want = Number(m[1])
    for (const el of listAllCommentRendererHosts()) {
      if (extractRpidFromBiliData(readWebComponentData(el)) === want) return el
    }
    return null
  }
  const postUrl = location.href
  for (const el of listAllCommentRendererHosts()) {
    const row = scrapeFromCommentRendererHost(el, postUrl)
    if (row?.platformCommentId === platformCommentId) return el
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function rAF2(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

/** 视频页 Console 执行：`localStorage.setItem("yanling_debug_bilibili","1")` 后刷新，再操作填入，可把带此前缀的日志发给开发者 */
function biliFillDebug(...args: unknown[]) {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("yanling_debug_bilibili") === "1") {
      console.info("[CommentCopilot][bilibili][fill]", ...args)
    }
  } catch {
    /* ignore */
  }
}

/** `.brt-editor` 所在 `bili-comment-rich-textarea` 宿主 */
function findBiliRichTextareaHostFromBrtEditor(ed: HTMLElement): HTMLElement | null {
  let n: Node | null = ed
  for (let i = 0; i < 28 && n; i++) {
    const root = n.getRootNode()
    if (root instanceof ShadowRoot) {
      const h = root.host
      if (h instanceof HTMLElement && h.tagName.toLowerCase() === "bili-comment-rich-textarea") {
        return h
      }
      n = h
      continue
    }
    break
  }
  return null
}

function dispatchClickAt(el: Element, clientX: number, clientY: number) {
  const common = {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    view: window,
    button: 0,
  } as const
  try {
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...common,
        pointerId: 1,
        pointerType: "mouse",
      } as PointerEventInit)
    )
  } catch {
    /* ignore */
  }
  el.dispatchEvent(new MouseEvent("mousedown", { ...common }))
  try {
    el.dispatchEvent(
      new PointerEvent("pointerup", {
        ...common,
        pointerId: 1,
        pointerType: "mouse",
        buttons: 0,
      } as PointerEventInit)
    )
  } catch {
    /* ignore */
  }
  el.dispatchEvent(new MouseEvent("mouseup", { ...common }))
  el.dispatchEvent(new MouseEvent("click", { ...common }))
}

/** 从 rich-textarea 沿 composed 树向上点 `bili-comment-box` / `#editor` / `#comment-area`，促发外层 active */
function clickComposerAncestorShells(from: HTMLElement | null) {
  let cur: Element | null = from
  for (let i = 0; i < 14 && cur; i++) {
    const id = cur.id
    const tag = cur.tagName.toLowerCase()
    if (id === "editor" || id === "comment-area" || tag === "bili-comment-box") {
      try {
        ;(cur as HTMLElement).click()
      } catch {
        /* ignore */
      }
      try {
        ;(cur as HTMLElement).focus()
      } catch {
        /* ignore */
      }
    }
    const p = cur.parentElement
    if (p) {
      cur = p
      continue
    }
    const root = cur.getRootNode()
    if (root instanceof ShadowRoot) cur = root.host as Element
    else break
  }
}

/** 在视口坐标点顶层元素并派发点击（部分遮罩会挡住直接点 .brt-editor） */
function pointerChainAtViewport(clientX: number, clientY: number) {
  const top = document.elementFromPoint(clientX, clientY)
  if (top instanceof HTMLElement) {
    biliFillDebug("elementFromPoint", { tag: top.tagName, id: top.id, class: top.className?.slice?.(0, 80) })
    dispatchClickAt(top, clientX, clientY)
    try {
      top.focus()
    } catch {
      /* ignore */
    }
    try {
      top.click()
    } catch {
      /* ignore */
    }
  }
}

/**
 * B 站富文本需用户态「点一下」才会给 `#editor` 加 active、内部状态才接 insert；
 * 在写入前模拟点击宿主 shadow 内 `#input` / 占位 + `.brt-editor` + 视口坐标命中 + 祖先壳。
 */
async function activateBilibiliBrtEditor(ed: HTMLElement): Promise<void> {
  await rAF2()

  const host = findBiliRichTextareaHostFromBrtEditor(ed)
  biliFillDebug("activate: host", host?.tagName, host?.id)

  if (host?.shadowRoot) {
    const sr = host.shadowRoot
    const hit =
      (sr.querySelector("#input") as HTMLElement | null) ??
      (sr.querySelector(".brt-root") as HTMLElement | null) ??
      (sr.querySelector(".brt-placeholder") as HTMLElement | null)
    if (hit) {
      const r = hit.getBoundingClientRect()
      const x = Math.floor(r.left + Math.max(4, r.width / 2))
      const y = Math.floor(r.top + Math.max(4, r.height / 2))
      dispatchClickAt(hit, x, y)
      pointerChainAtViewport(x, y)
      if (typeof (hit as HTMLElement).click === "function") {
        try {
          ;(hit as HTMLElement).click()
        } catch {
          /* ignore */
        }
      }
    }
    try {
      host.focus()
    } catch {
      /* ignore */
    }
    try {
      host.click()
    } catch {
      /* ignore */
    }
  }

  clickComposerAncestorShells(host)

  const shell = host?.parentElement
  if (shell?.id === "editor") {
    try {
      ;(shell as HTMLElement).click()
    } catch {
      /* ignore */
    }
  }

  await sleep(50)

  try {
    ed.scrollIntoView({ block: "nearest", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await rAF2()

  const er = ed.getBoundingClientRect()
  const ex = Math.floor(er.left + Math.min(100, Math.max(4, er.width / 2)))
  const ey = Math.floor(er.top + Math.max(4, Math.min(er.height / 2, 20)))
  pointerChainAtViewport(ex, ey)
  dispatchClickAt(ed, ex, ey)
  const ey2 = Math.floor(er.top + Math.max(4, er.height * 0.65))
  if (ey2 !== ey) pointerChainAtViewport(ex, ey2)
  try {
    ed.click()
  } catch {
    /* ignore */
  }
  try {
    ed.focus({ preventScroll: true })
  } catch {
    ed.focus()
  }

  ed.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }))

  await sleep(100)
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

function getBrtEditorFilledLength(ed: HTMLElement): number {
  return (ed.innerText ?? ed.textContent ?? "").replace(/\s+/g, " ").trim().length
}

/**
 * 仅改 DOM 文字时，B 站 Lit 不会切到「已输入」态：`#editor` 无 `active`、`#footer` 仍为 `hidden`。
 * 写入后补一轮 class + 规范 input 事件，让底部工具栏与「发布」出现（与手动输入态一致）。
 */
function patchBilibiliCommentBoxChromeFromEditor(ed: HTMLElement) {
  let cur: Element | null = ed
  for (let i = 0; i < 28 && cur; i++) {
    const tag = cur.tagName.toLowerCase()
    if (tag === "bili-comment-box" && cur.shadowRoot) {
      const sr = cur.shadowRoot
      const editorShell = sr.querySelector("#editor") as HTMLElement | null
      if (editorShell) {
        editorShell.classList.add("active")
      }
      const footer = sr.querySelector("#footer") as HTMLElement | null
      if (footer) {
        footer.classList.remove("hidden")
        if (footer.hasAttribute("hidden")) footer.removeAttribute("hidden")
      }
      biliFillDebug("patchBilibiliCommentBoxChrome", { editorActive: !!editorShell, footer: !!footer })
      return
    }
    const p = cur.parentElement
    if (p) {
      cur = p
      continue
    }
    const root = cur.getRootNode()
    if (root instanceof ShadowRoot) cur = root.host as Element
    else break
  }
}

function dispatchBilibiliRichInputPipeline(ed: HTMLElement, text: string) {
  const host = findBiliRichTextareaHostFromBrtEditor(ed)
  const payload = { bubbles: true, cancelable: false, data: text, inputType: "insertText" } as InputEventInit
  try {
    ed.dispatchEvent(new InputEvent("input", payload))
  } catch {
    ed.dispatchEvent(new Event("input", { bubbles: true }))
  }
  try {
    host?.dispatchEvent(new InputEvent("input", { ...payload, composed: true }))
  } catch {
    try {
      host?.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
    } catch {
      /* ignore */
    }
  }
  try {
    ed.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: false,
        inputType: "insertText",
        data: text,
      } as InputEventInit)
    )
  } catch {
    /* ignore */
  }
  // 轻量键盘事件，部分组件靠 key 路径更新内部 model
  for (const key of ["End", " "] as const) {
    try {
      ed.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      ed.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }))
    } catch {
      /* ignore */
    }
  }
}

function finalizeBilibiliRichComposerUI(ed: HTMLElement, text: string) {
  patchBilibiliCommentBoxChromeFromEditor(ed)
  dispatchBilibiliRichInputPipeline(ed, text)
  patchBilibiliCommentBoxChromeFromEditor(ed)
}

/** 部分 Lit 组件只响应 insertFromPaste 路径 */
function tryBilibiliInsertFromPaste(ed: HTMLElement, text: string): boolean {
  const before = getBrtEditorFilledLength(ed)
  try {
    const ev = new InputEvent("beforeinput", {
      inputType: "insertFromPaste",
      data: text,
      bubbles: true,
      cancelable: true,
    })
    ed.dispatchEvent(ev)
  } catch {
    /* ignore */
  }
  try {
    document.execCommand("insertText", false, text)
  } catch {
    /* ignore */
  }
  if (getBrtEditorFilledLength(ed) <= before) {
    try {
      const dt = new DataTransfer()
      dt.setData("text/plain", text)
      ed.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        } as ClipboardEventInit)
      )
    } catch {
      /* ignore */
    }
  }
  return getBrtEditorFilledLength(ed) > before
}

async function writeBilibiliRichText(ed: HTMLElement, text: string): Promise<boolean> {
  const wantLen = text.replace(/\s+/g, " ").trim().length
  for (let attempt = 0; attempt < 2; attempt++) {
    biliFillDebug("write attempt", attempt + 1, "len", wantLen)
    await activateBilibiliBrtEditor(ed)
    await rAF2()
    writeToContentEditable(ed, text)
    let got = getBrtEditorFilledLength(ed)
    biliFillDebug("after execCommand/textContent", "gotLen", got)
    if (wantLen > 0 && got === 0) {
      tryBilibiliInsertFromPaste(ed, text)
      got = getBrtEditorFilledLength(ed)
      biliFillDebug("after paste fallback", "gotLen", got)
    }
    if (got > 0 || wantLen === 0) {
      if (got > 0) {
        finalizeBilibiliRichComposerUI(ed, text)
        await rAF2()
        finalizeBilibiliRichComposerUI(ed, text)
      }
      return true
    }
    await sleep(120)
  }
  const finalGot = getBrtEditorFilledLength(ed)
  if (finalGot > 0) {
    finalizeBilibiliRichComposerUI(ed, text)
  }
  return wantLen === 0 || finalGot > 0
}

function isBilibiliReplyActionEl(el: HTMLElement): boolean {
  const t = el.textContent?.replace(/\s+/g, " ").trim() ?? ""
  const aria = (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "").trim()
  if (t === "回复" || aria === "回复") return true
  if (aria.includes("回复")) return true
  if (el.id === "reply" && (el.tagName === "BUTTON" || el.querySelector("button"))) return true
  const p = el.parentElement
  if (p?.id === "reply" && (el.tagName === "BUTTON" || el.getAttribute("role") === "button")) return true
  return false
}

/** 在单个节点子树（含各层 open shadow）里找可见「回复」控件 */
function findReplyButtonInShadowBfs(root: ShadowRoot | Document | null | undefined): HTMLElement | null {
  if (!root) return null
  const q: (ShadowRoot | Document)[] = [root]
  const seen = new Set<ShadowRoot | Document>()
  while (q.length) {
    const r = q.shift()!
    if (seen.has(r)) continue
    seen.add(r)
    const byId = r.querySelector("#reply button, #reply [role='button'], #reply button[type], button#reply") as HTMLElement | null
    if (byId) {
      const box = byId.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) return byId
    }
    const cand = r.querySelectorAll("button, a, span, div, p, [role='button']")
    for (let i = 0; i < cand.length; i++) {
      const el = cand[i] as HTMLElement
      if (!isBilibiliReplyActionEl(el)) continue
      const box = el.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) continue
      return el
    }
    r.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) q.push(el.shadowRoot)
    })
  }
  return null
}

/** 从该条评论的 renderer 沿 composed 树向上找「回复」；不进入整条 thread 的 shadow，避免点到别的楼层 */
function findReplyButtonForCommentHost(commentHost: Element): HTMLElement | null {
  let cur: Element | null = commentHost
  const seen = new Set<Element>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    // 必须先判断 thread：不要在整条 thread 的 shadow 里 BFS，否则会点到别的楼层
    if (cur.tagName.toLowerCase() === "bili-comment-thread-renderer") break
    const inShadow = findReplyButtonInShadowBfs(cur.shadowRoot)
    if (inShadow) return inShadow
    const root = cur.getRootNode()
    if (root instanceof ShadowRoot) {
      cur = root.host as Element
    } else {
      cur = cur.parentElement
    }
  }
  return null
}

function findThreadRendererContainingElement(el: Element): Element | null {
  for (const t of queryAllThreadRenderers()) {
    try {
      if (t.shadowRoot?.contains(el)) return t
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 沿 composed 树判断是否在楼中楼「回复」容器内（主评 `#comment-area` 不在此列） */
function isUnderReplyContainer(el: Element): boolean {
  let cur: Element | null = el
  for (let i = 0; i < 80 && cur; i++) {
    if (cur.id === "reply-container") return true
    const rn = cur.getRootNode()
    if (rn instanceof ShadowRoot) cur = rn.host as Element
    else cur = cur.parentElement
  }
  return false
}

function isBrtEditorUsable(ed: HTMLElement): boolean {
  const st = getComputedStyle(ed)
  if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false
  const r = ed.getBoundingClientRect()
  return r.height > 4
}

function getBrtEditorFromRichTextareaHost(node: Element): HTMLElement | null {
  if (node.tagName.toLowerCase() !== "bili-comment-rich-textarea") return null
  const sr = node.shadowRoot
  const ed =
    (sr?.querySelector(
      ".brt-editor[contenteditable='true'], .brt-editor[contenteditable=''], .brt-editor[contenteditable]"
    ) as HTMLElement | null) ??
    (sr?.querySelector(".brt-editor") as HTMLElement | null)
  if (!ed?.isContentEditable) return null
  return isBrtEditorUsable(ed) ? ed : null
}

/** 从某 DOM 子树（含多层 open shadow）穿透到 `bili-comment-rich-textarea` 内 `.brt-editor` */
function findBrtEditorInSubtree(scope: Element): HTMLElement | null {
  const stack: Element[] = [scope]
  const seen = new Set<Element>()
  while (stack.length) {
    const node = stack.pop()!
    if (seen.has(node)) continue
    seen.add(node)
    if (node.tagName.toLowerCase() === "bili-comment-rich-textarea") {
      const ed = getBrtEditorFromRichTextareaHost(node)
      if (ed) return ed
    }
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.querySelectorAll("*")) {
        stack.push(child as Element)
      }
    }
    for (const child of node.children) {
      stack.push(child as Element)
    }
  }
  return null
}

/**
 * 楼中楼回复：输入框在 `#reply-container` → `bili-comment-box` 等多层 shadow 内的
 * `bili-comment-rich-textarea` → `.brt-editor`。
 */
function findBilibiliBrtEditorInReplyContainer(commentHost: Element): HTMLElement | null {
  const thread = findThreadRendererContainingElement(commentHost)
  const tr = thread?.shadowRoot
  if (!tr) return null
  const rc = tr.querySelector("#reply-container") as Element | null
  if (!rc) return null
  return findBrtEditorInSubtree(rc)
}

/**
 * 视频主评 / 「视频跟评」：顶部 `#comment-area` 内同样是 `bili-comment-rich-textarea`，
 * 与楼中楼 DOM 一致，但必须排除 `#reply-container` 下的输入框。
 */
function findBilibiliMainVideoComposerEditor(): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestTop = Infinity

  const areas = querySelectorAllDeep("#comment-area")
  for (const a of areas) {
    if (!(a instanceof Element)) continue
    if (isUnderReplyContainer(a)) continue
    const ed = findBrtEditorInSubtree(a)
    if (!ed) continue
    const top = ed.getBoundingClientRect().top
    if (top < bestTop) {
      bestTop = top
      best = ed
    }
  }
  if (best) return best

  const hosts = querySelectorAllDeep("bili-comment-rich-textarea")
  for (const h of hosts) {
    if (!(h instanceof Element)) continue
    if (isUnderReplyContainer(h)) continue
    const ed = getBrtEditorFromRichTextareaHost(h)
    if (!ed) continue
    const top = ed.getBoundingClientRect().top
    if (top < bestTop) {
      bestTop = top
      best = ed
    }
  }
  return best
}

async function fillBilibiliNoteComment(text: string): Promise<ContentFillResult> {
  if (!isBilibiliVideoPageUrl(location.href)) {
    return { ok: false, error: "not_video_page", step: "url" }
  }
  const t = String(text ?? "").trim()
  if (!t) return { ok: false, error: "empty_text", step: "text" }

  const root = document.querySelector("bili-comments")
  try {
    root?.scrollIntoView({ block: "start", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await sleep(200)

  let input: HTMLElement | null = null
  const deadline = Date.now() + 5500
  while (Date.now() < deadline) {
    input = findBilibiliMainVideoComposerEditor()
    if (input) break
    await sleep(100)
  }

  if (!input) {
    return { ok: false, error: "main_composer_not_found", step: "composer" }
  }

  try {
    input.scrollIntoView({ block: "center", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await sleep(60)
  const wrote = await writeBilibiliRichText(input, t)
  if (!wrote) {
    const innerLen = getBrtEditorFilledLength(input)
    biliFillDebug("fillBilibiliNoteComment failed", "innerLen", innerLen)
    return { ok: false, error: "insert_failed", step: "write" }
  }
  return { ok: true }
}

/** 穿透 shadow 的 activeElement（焦点常在内部 contenteditable 上） */
function getDeepActiveEditable(): HTMLElement | null {
  let ae: Element | null = document.activeElement
  for (let d = 0; d < 12 && ae; d++) {
    if (ae instanceof HTMLElement) {
      if (ae.isContentEditable) return ae
      if (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") return ae
    }
    const sr = ae.shadowRoot
    const inner = sr?.activeElement ?? null
    if (inner && inner !== ae) ae = inner
    else break
  }
  return null
}

function collectVisibleEditableDeep(): HTMLElement[] {
  const out: HTMLElement[] = []
  const q: (Document | ShadowRoot)[] = [document]
  const seen = new Set<Document | ShadowRoot>()
  while (q.length) {
    const root = q.shift()!
    if (seen.has(root)) continue
    seen.add(root)
    root.querySelectorAll("textarea").forEach((el) => {
      if (!(el instanceof HTMLTextAreaElement)) return
      const r = el.getBoundingClientRect()
      if (r.width > 20 && r.height > 12 && r.bottom > 0 && r.top < globalThis.innerHeight + 120) out.push(el)
    })
    root.querySelectorAll("[contenteditable='true'], [contenteditable='']").forEach((el) => {
      if (!(el instanceof HTMLElement)) return
      const r = el.getBoundingClientRect()
      // B 站 .brt-editor 初始可能宽度较窄，放宽以便能被选中
      if (r.height >= 8 && r.bottom > -40 && r.top < globalThis.innerHeight + 160) out.push(el)
    })
    root.querySelectorAll(".brt-editor").forEach((el) => {
      if (!(el instanceof HTMLElement) || !el.isContentEditable) return
      const r = el.getBoundingClientRect()
      if (r.height >= 8 && r.bottom > -40 && r.top < globalThis.innerHeight + 160) out.push(el)
    })
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) q.push(el.shadowRoot)
    })
  }
  return out
}

function pickReplyInputNearComment(commentHost: Element, candidates: HTMLElement[]): HTMLElement | null {
  const cr = commentHost.getBoundingClientRect()
  const anchorY = cr.bottom
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of candidates) {
    const r = el.getBoundingClientRect()
    const dy = r.top - anchorY
    if (dy < -80) continue
    const score = Math.abs(dy) * 2 + Math.abs(r.left - cr.left) * 0.02
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

/**
 * 侧栏「回复」：定位评论 → 点「回复」→ 等输入框 → 写入（与小红书 fillReply 同目标）
 */
async function fillBilibiliReply(platformCommentId: string, text: string): Promise<ContentFillResult> {
  if (!isBilibiliVideoPageUrl(location.href)) {
    return { ok: false, error: "not_video_page", step: "url" }
  }
  const host = findCommentHostForPlatformId(platformCommentId)
  if (!host) {
    return { ok: false, error: "comment_not_found", step: "host" }
  }

  try {
    host.scrollIntoView({ block: "center", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await sleep(120)

  const replyBtn = findReplyButtonForCommentHost(host)
  if (!replyBtn) {
    return { ok: false, error: "reply_btn_not_found", step: "reply_btn" }
  }

  const beforeSnap = collectVisibleEditableDeep().map((e) => `${e.tagName}:${e.getBoundingClientRect().top}`)

  replyBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
  replyBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }))
  replyBtn.click()
  await sleep(200)

  let input: HTMLElement | null = null
  const deadline = Date.now() + 4500
  while (Date.now() < deadline) {
    input = findBilibiliBrtEditorInReplyContainer(host)
    if (input) break

    const list = collectVisibleEditableDeep()
    const snap = list.map((e) => `${e.tagName}:${e.getBoundingClientRect().top}`)
    const changed = snap.length !== beforeSnap.length || snap.some((s, i) => s !== beforeSnap[i])
    if (list.length > 0) {
      const near = pickReplyInputNearComment(host, list) ?? list[list.length - 1] ?? null
      if (near && (changed || list.length === 1)) {
        input = near
        break
      }
    }
    const deepAe = getDeepActiveEditable()
    if (deepAe) {
      input = deepAe
      break
    }
    await sleep(100)
  }

  if (!input) {
    return { ok: false, error: "input_not_found", step: "composer" }
  }

  try {
    input.scrollIntoView({ block: "nearest", behavior: "auto" })
  } catch {
    /* ignore */
  }
  await sleep(50)

  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const ta = input as HTMLTextAreaElement
    ta.focus()
    ta.value = ""
    ta.value = text
    ta.dispatchEvent(new Event("input", { bubbles: true }))
    ta.dispatchEvent(new Event("change", { bubbles: true }))
  } else {
    const wrote = await writeBilibiliRichText(input, text)
    if (!wrote) {
      const innerLen = getBrtEditorFilledLength(input)
      biliFillDebug("fillBilibiliReply write failed", "innerLen", innerLen)
      return { ok: false, error: "insert_failed", step: "write" }
    }
  }

  return { ok: true }
}

const ingestDeduper = createCommentIngestDeduper(3000)

function scanVideoComments(): ScrapedComment[] {
  if (!isBilibiliVideoPageUrl(location.href)) return []
  const postUrl = location.href
  const threads = queryAllThreadRenderers()
  const out: ScrapedComment[] = []
  const batchSeen = new Set<string>()

  for (const t of threads) {
    collectFromThread(t, postUrl, batchSeen, out)
  }

  return filterOutSelfBilibiliComments(out)
}

// ─── 排除当前登录用户自己的评论（mid + 昵称兜底）────────────────────────────

let bilibiliViewerMidCache: number | null | undefined
let bilibiliViewerUnameCache: string | null | undefined
let bilibiliViewerCacheAt = 0
const BILI_VIEWER_CACHE_MS = 45_000

function invalidateBilibiliViewerIdentityCache() {
  bilibiliViewerMidCache = undefined
  bilibiliViewerUnameCache = undefined
  bilibiliViewerCacheAt = 0
}

function readBilibiliViewerMidFromCookie(): number | null {
  const m = document.cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/)
  return m ? Number(m[1]) : null
}

function readBilibiliViewerMidFromWindow(): number | null {
  try {
    const w = window as unknown as {
      __BILI_CONFIG__?: { userInfo?: { mid?: unknown }; member?: { mid?: unknown } }
      __INITIAL_STATE__?: { userInfo?: { mid?: unknown }; member?: { mid?: unknown } }
    }
    for (const obj of [w.__BILI_CONFIG__, w.__INITIAL_STATE__]) {
      if (!obj || typeof obj !== "object") continue
      const u = (obj as { userInfo?: { mid?: unknown } }).userInfo
      const mem = (obj as { member?: { mid?: unknown } }).member
      const found = tryParsePositiveMid(u?.mid) ?? tryParsePositiveMid(mem?.mid)
      if (found != null) return found
    }
  } catch {
    /* ignore */
  }
  return null
}

function readBilibiliViewerUnameFromDom(): string | null {
  const sels = [
    ".header-entry-mini .name",
    ".header-entry-mini .username",
    ".vip-m a.username",
    "#nav-user-name",
    ".mini-avatar .name",
    "a.name[href*='space.bilibili.com']",
  ]
  for (const sel of sels) {
    const el = document.querySelector(sel)
    const t = el?.textContent?.replace(/\s+/g, " ").trim()
    if (t && t.length >= 1 && t.length < 80) return t
  }
  return null
}

function getBilibiliViewerIdentity(): { mid: number | null; uname: string | null } {
  const now = Date.now()
  if (
    now - bilibiliViewerCacheAt < BILI_VIEWER_CACHE_MS &&
    bilibiliViewerMidCache !== undefined &&
    bilibiliViewerUnameCache !== undefined
  ) {
    return { mid: bilibiliViewerMidCache ?? null, uname: bilibiliViewerUnameCache ?? null }
  }
  const mid = readBilibiliViewerMidFromCookie() ?? readBilibiliViewerMidFromWindow()
  const uname = readBilibiliViewerUnameFromDom()
  bilibiliViewerMidCache = mid
  bilibiliViewerUnameCache = uname
  bilibiliViewerCacheAt = now
  return { mid, uname }
}

function normalizeBilibiliDisplayName(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

function bilibiliAuthorNamesLikelySame(a: string, b: string): boolean {
  const x = normalizeBilibiliDisplayName(a)
  const y = normalizeBilibiliDisplayName(b)
  if (!x || !y) return false
  return x === y
}

function extractMidFromBilibiliPlatformCommentId(pid: string): number | null {
  const m = pid.match(/^bilibili:mid:(\d+):/)
  return m ? Number(m[1]) : null
}

function isOwnBilibiliComment(row: ScrapedComment, selfMid: number | null, selfUname: string | null): boolean {
  if (selfMid != null) {
    if (row.authorMid != null && row.authorMid === selfMid) return true
    const fromPid = extractMidFromBilibiliPlatformCommentId(row.platformCommentId)
    if (fromPid != null && fromPid === selfMid) return true
  }
  if (selfUname && row.authorName && row.authorName !== "未知用户") {
    if (bilibiliAuthorNamesLikelySame(row.authorName, selfUname)) return true
  }
  return false
}

function filterOutSelfBilibiliComments(rows: ScrapedComment[]): ScrapedComment[] {
  if (!isBilibiliVideoPageUrl(location.href)) return rows
  const { mid, uname } = getBilibiliViewerIdentity()
  if (mid == null && !(uname && uname.trim())) return rows
  return rows.filter((r) => !isOwnBilibiliComment(r, mid, uname?.trim() ?? null))
}

/** 发往侧栏/后台时去掉内部字段 */
function scrapedCommentsToWirePayload(rows: ScrapedComment[]) {
  return rows.map((c) => ({
    platformCommentId: c.platformCommentId,
    authorName: c.authorName,
    content: c.content,
    commentedAt: c.commentedAt,
    postUrl: c.postUrl,
  }))
}

function sendComments(comments: ScrapedComment[]) {
  if (!comments.length) return
  console.log(`[CommentCopilot][bilibili] sending ${comments.length} comments`)
  chrome.runtime.sendMessage({
    type: "COMMENTS_COLLECTED",
    payload: { platform: "bilibili", comments: scrapedCommentsToWirePayload(comments) },
  }).catch(() => {})
}

function getBilibiliPostContent(): { postTitle: string; postContent: string; postUrl: string } {
  const postUrl = location.href
  const h1 =
    (document.querySelector("h1.video-title") as HTMLElement | null) ??
    (document.querySelector(".video-title") as HTMLElement | null) ??
    (document.querySelector("h1") as HTMLElement | null)
  const postTitle = (h1?.innerText ?? document.title).replace(/\s+/g, " ").trim().slice(0, 200)
  const descEl =
    document.querySelector(".video-desc .desc-info-text") ??
    document.querySelector("#v_desc") ??
    document.querySelector(".desc-info-text")
  const postContent = (descEl?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000)
  return { postTitle, postContent, postUrl }
}

async function getAllPageComments(): Promise<ScrapedComment[]> {
  return scrapedCommentsToWirePayload(scanVideoComments())
}

// ─── 滚动联动：左侧 B 站评论区滚动 → 视口中央附近那条 → 通知侧栏同步（同小红书 SCROLL_TO_COMMENT）───
let bilibiliScrollSyncRaf: number | null = null
let bilibiliLastScrollSentPlatformId: string | null = null
let bilibiliScrollTarget: Element | typeof window | null = null
/** 评论区可能在内部可滚动容器里，允许多个 */
let bilibiliScrollExtraEls: Element[] = []

function findBilibiliCommentPlatformIdAtViewportCenter(): string | null {
  if (!isBilibiliVideoPageUrl(location.href)) return null
  const hosts = listAllCommentRendererHosts()
  if (hosts.length === 0) return null

  const viewportCenter = globalThis.innerHeight / 2
  let bestId: string | null = null
  let bestDist = Infinity

  for (const el of hosts) {
    const rpid = extractRpidFromBiliData(readWebComponentData(el))
    if (rpid == null) continue
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) continue
    const elCenter = rect.top + rect.height / 2
    const dist = Math.abs(elCenter - viewportCenter)
    if (dist < bestDist) {
      bestDist = dist
      bestId = `bilibili:rpid:${rpid}`
    }
  }
  return bestId
}

function onBilibiliPageScroll() {
  if (bilibiliScrollSyncRaf != null) return
  bilibiliScrollSyncRaf = globalThis.requestAnimationFrame(() => {
    bilibiliScrollSyncRaf = null
    const id = findBilibiliCommentPlatformIdAtViewportCenter()
    if (id && id !== bilibiliLastScrollSentPlatformId) {
      bilibiliLastScrollSentPlatformId = id
      chrome.runtime
        .sendMessage({
          type: "SCROLL_TO_COMMENT",
          payload: { platformCommentId: id },
        })
        .catch(() => {})
    }
  })
}

function getBilibiliScrollParent(el: Element): Element | typeof window {
  let p: Element | null = el.parentElement
  while (p) {
    const style = getComputedStyle(p)
    const overflow = style.overflowY
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return p
    p = p.parentElement
  }
  return window
}

function setupBilibiliScrollSync() {
  bilibiliLastScrollSentPlatformId = null

  if (bilibiliScrollTarget) {
    bilibiliScrollTarget.removeEventListener("scroll", onBilibiliPageScroll, true)
    bilibiliScrollTarget = null
  }
  for (const el of bilibiliScrollExtraEls) {
    el.removeEventListener("scroll", onBilibiliPageScroll, true)
  }
  bilibiliScrollExtraEls = []

  if (!isBilibiliVideoPageUrl(location.href)) {
    return
  }

  globalThis.addEventListener("scroll", onBilibiliPageScroll, true)
  bilibiliScrollTarget = window

  const extras = new Set<Element>()
  const firstHost = listAllCommentRendererHosts()[0]
  if (firstHost) {
    const parent = getBilibiliScrollParent(firstHost)
    if (parent !== window) extras.add(parent as Element)
  }
  const biliCommentsRoot = document.querySelector("bili-comments")
  if (biliCommentsRoot) {
    const parent = getBilibiliScrollParent(biliCommentsRoot)
    if (parent !== window) extras.add(parent as Element)
  }
  for (const el of extras) {
    el.addEventListener("scroll", onBilibiliPageScroll, true)
    bilibiliScrollExtraEls.push(el)
  }

  onBilibiliPageScroll()
}

const SCAN_THROTTLE_MS = 400
/** 评论区晚挂载时补挂内部 scroll 监听（不重置 lastSent，避免刷屏） */
let bilibiliScrollExtraRetryTimer: ReturnType<typeof setTimeout> | null = null
function maybeAttachBilibiliScrollExtrasWhenReady() {
  if (!isBilibiliVideoPageUrl(location.href)) return
  if (listAllCommentRendererHosts().length === 0 && !document.querySelector("bili-comments")) return
  if (bilibiliScrollExtraEls.length > 0) return
  if (bilibiliScrollExtraRetryTimer != null) return
  bilibiliScrollExtraRetryTimer = setTimeout(() => {
    bilibiliScrollExtraRetryTimer = null
    if (!isBilibiliVideoPageUrl(location.href)) return
    const extras = new Set<Element>()
    const firstHost = listAllCommentRendererHosts()[0]
    if (firstHost) {
      const parent = getBilibiliScrollParent(firstHost)
      if (parent !== window) extras.add(parent as Element)
    }
    const biliCommentsRoot = document.querySelector("bili-comments")
    if (biliCommentsRoot) {
      const parent = getBilibiliScrollParent(biliCommentsRoot)
      if (parent !== window) extras.add(parent as Element)
    }
    if (extras.size === 0) return
    for (const el of extras) {
      el.addEventListener("scroll", onBilibiliPageScroll, true)
      bilibiliScrollExtraEls.push(el)
    }
    onBilibiliPageScroll()
  }, 80)
}

const runThrottledScan = createThrottledScan(
  SCAN_THROTTLE_MS,
  () => {
    if (!isBilibiliVideoPageUrl(location.href)) return
    const all = scanVideoComments()
    const newOnes = ingestDeduper.collectFresh(all)
    if (newOnes.length > 0) sendComments(newOnes)
    maybeAttachBilibiliScrollExtrasWhenReady()
  },
  { label: "bilibili" },
)

async function initialScan(retries = 8, delay = 800) {
  if (!isBilibiliVideoPageUrl(location.href)) return
  const all = scanVideoComments()
  const newOnes = ingestDeduper.collectFresh(all)
  if (newOnes.length > 0) {
    sendComments(newOnes)
  } else if (retries > 0) {
    setTimeout(() => {
      void initialScan(retries - 1, Math.min(delay * 1.2, 5000))
    }, delay)
  }
}

/**
 * 同一页可能被 scripting.executeScript 重复注入；防重复挂 history / MutationObserver / onMessage。
 */
;(function bootYanlingBilibiliContentScript() {
  const G = globalThis as unknown as { __yanlingBilibiliContentScriptBoot?: boolean }
  if (G.__yanlingBilibiliContentScriptBoot) return
  G.__yanlingBilibiliContentScriptBoot = true

  const originalPushState = history.pushState.bind(history)
  history.pushState = function (...args) {
    originalPushState(...args)
    onUrlChange()
  }
  const originalReplaceState = history.replaceState.bind(history)
  history.replaceState = function (...args) {
    originalReplaceState(...args)
    onUrlChange()
  }
  window.addEventListener("popstate", onUrlChange)

  function onUrlChange() {
    currentUrl = location.href
    invalidateBilibiliViewerIdentityCache()
    ingestDeduper.clear()
    chrome.runtime.sendMessage({
      type: "URL_CHANGED",
      payload: { url: currentUrl },
    }).catch(() => {})
    setTimeout(() => {
      void initialScan()
    }, 1200)
    setTimeout(() => {
      setupBilibiliScrollSync()
    }, 1000)
  }

  const observer = new MutationObserver(runThrottledScan)

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "FILL_REPLY") {
      const { platformCommentId, text } = (message as { payload?: { platformCommentId?: string; text?: string } })
        .payload ?? {}
      void fillBilibiliReply(String(platformCommentId ?? ""), String(text ?? ""))
        .then(sendResponse)
        .catch((e) => {
          console.error("[CommentCopilot][bilibili] FILL_REPLY", e)
          sendResponse({ ok: false, error: String(e) })
        })
      return true
    }
    if (message.type === "FILL_NOTE_COMMENT") {
      const { text } = (message as { payload?: { text?: string } }).payload ?? {}
      void fillBilibiliNoteComment(String(text ?? ""))
        .then(sendResponse)
        .catch((e) => {
          console.error("[CommentCopilot][bilibili] FILL_NOTE_COMMENT", e)
          sendResponse({ ok: false, error: String(e) })
        })
      return true
    }
    if (message.type === "GET_ALL_PAGE_COMMENTS") {
      void getAllPageComments()
        .then(sendResponse)
        .catch((e) => {
          console.error("[CommentCopilot][bilibili] GET_ALL_PAGE_COMMENTS", e)
          sendResponse([])
        })
      return true
    }
    if (message.type === "GET_POST_CONTENT") {
      if (!isBilibiliVideoPageUrl(location.href)) {
        sendResponse({ postTitle: "", postContent: "", postUrl: currentUrl })
      } else {
        sendResponse(getBilibiliPostContent())
      }
      return false
    }
    return false
  })

  setTimeout(() => {
    void initialScan()
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => {
      setupBilibiliScrollSync()
    }, 500)
  }, 600)
})()
