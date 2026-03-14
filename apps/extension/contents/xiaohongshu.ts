import type { PlasmoCSConfig } from "plasmo"

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

function extractCommentId(el: Element): string {
  return (
    el.getAttribute("data-comment-id") ||
    el.getAttribute("data-id") ||
    (el.id || null) ||
    // 用 encodeURIComponent 再 btoa，支持中文等非 ASCII 字符
    `xhs_${btoa(encodeURIComponent(
      ((el.querySelector(SELECTORS.authorName) as HTMLElement)?.innerText?.slice(0, 10) ?? "") +
      ((el.querySelector(SELECTORS.content) as HTMLElement)?.innerText?.slice(0, 20) ?? "")
    )).slice(0, 16)}`
  )
}

function parseCommentNode(node: Element): ScrapedComment | null {
  const authorEl = node.querySelector(SELECTORS.authorName) as HTMLElement | null

  // 过滤掉笔记作者自己的评论/回复（带"作者"文字标签）
  const authorTag = node.querySelector('.author-wrapper .tag, .author-tag, [class*="author-tag"]')
  if (authorTag && authorTag.textContent?.trim() === "作者") return null

  // 找第一个没有 class 的 span 作为评论内容
  const innerContainer = node.querySelector('.comment-inner-container')
  const spans = innerContainer ? Array.from(innerContainer.querySelectorAll('span')) : []
  const contentEl = spans.find(s => !s.className && s.textContent && s.textContent.trim().length > 1) ?? null

  // 找时间：内容 span 之后的无 class span
  const timeEl = contentEl?.nextElementSibling as HTMLElement | null

  const authorName = authorEl?.innerText?.trim()
  const content = contentEl?.textContent?.trim()

  if (!authorName || !content || content.length < 2) return null

  return {
    platformCommentId: extractCommentId(node),
    authorName,
    content,
    commentedAt: timeEl?.getAttribute("datetime") || new Date().toISOString(),
    postUrl: location.href,
  }
}

function scanAllComments(): ScrapedComment[] {
  const nodes = document.querySelectorAll(SELECTORS.commentList)

  if (nodes.length === 0) {
    consecutiveFailures++
    if (consecutiveFailures >= MAX_FAILURES) {
      chrome.runtime.sendMessage({ type: "CIRCUIT_OPEN" })
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
  })
}

// 首次扫描，指数退避重试（1s → 1.5s → 2.25s → …，最长 5s）
function initialScan(retries = 5, delay = 1000) {
  const comments = scanAllComments()
  if (comments.length > 0) {
    sendComments(comments)
  } else if (retries > 0) {
    setTimeout(() => initialScan(retries - 1, Math.min(delay * 1.5, 5000)), delay)
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
  if (location.href === currentUrl) return
  currentUrl = location.href
  seenIds.clear()
  // 通知侧边栏：URL 已变化，清空并等待新评论
  chrome.runtime.sendMessage({
    type: "URL_CHANGED",
    payload: { url: currentUrl },
  }).catch(() => {})
  setTimeout(() => {
    initialScan()
    setTimeout(setupScrollSync, 1000)
  }, 1500)
}

// MutationObserver 监听动态加载的新评论
const observer = new MutationObserver(() => {
  const newComments = scanAllComments()
  if (newComments.length > 0) {
    sendComments(newComments)
  }
})

// 填入回复：找到对应评论节点 → 点击"回复"按钮 → 等输入框弹出 → 填入文字
async function fillReply(platformCommentId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  // 找到页面上匹配的评论节点
  const nodes = Array.from(document.querySelectorAll(SELECTORS.commentList))
  const targetNode = nodes.find(n => extractCommentId(n) === platformCommentId)

  if (!targetNode) {
    return { ok: false, error: "comment_not_found" }
  }

  // 找"回复"按钮：小红书用 div.reply.icon-container
  const replyBtn = (
    targetNode.querySelector(".reply.icon-container") ||
    Array.from(targetNode.querySelectorAll("div, span")).find(el => el.textContent?.trim() === "回复")
  ) as HTMLElement | undefined

  if (!replyBtn) {
    return { ok: false, error: "reply_btn_not_found" }
  }

  // 点击"回复"展开输入框
  replyBtn.click()

  // 等待输入框出现（小红书用 p.content-input[contenteditable="true"]）
  const input = await waitForElement('p.content-input[contenteditable="true"]', 2000)

  if (!input) {
    return { ok: false, error: "input_not_found" }
  }

  const el = input as HTMLElement
  el.focus()
  el.textContent = ""

  // 优先用现代 InputEvent（Chrome 60+），触发框架响应式更新
  el.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "insertText",
    data: text,
    bubbles: true,
    cancelable: true,
  }))
  // execCommand 已废弃但仍被 Chrome 支持，作为兜底确保文字实际插入
  document.execCommand("insertText", false, text)
  // 若两者都未写入（极少数环境），直接赋值并派发 input 事件
  if (!el.textContent) {
    el.textContent = text
    el.dispatchEvent(new Event("input", { bubbles: true }))
  }

  el.focus()
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
function getAllPageComments(): ScrapedComment[] {
  const nodes = document.querySelectorAll(SELECTORS.commentList)
  const results: ScrapedComment[] = []
  nodes.forEach((node) => {
    const c = parseCommentNode(node)
    if (c) results.push(c)
  })
  return results
}

// 监听来自 background 的填入指令与数据查询
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FILL_REPLY") {
    const { platformCommentId, text } = message.payload
    fillReply(platformCommentId, text).then(sendResponse)
    return true
  }
  if (message.type === "GET_ALL_PAGE_COMMENTS") {
    sendResponse(getAllPageComments())
    return false
  }
})

// 启动：500ms 后开始扫描（MutationObserver 会持续捕获后续加载的评论）
setTimeout(() => {
  initialScan()
  observer.observe(document.body, { childList: true, subtree: true })
  setTimeout(setupScrollSync, 500)
}, 500)
