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
let consecutiveFailures = 0
const MAX_FAILURES = 5
let currentUrl = location.href

function extractCommentId(el: Element): string {
  return (
    el.getAttribute("data-comment-id") ||
    el.getAttribute("data-id") ||
    el.id ||
    `xhs_${btoa(
      (el.querySelector(SELECTORS.authorName) as HTMLElement)?.innerText?.slice(0, 10) +
      (el.querySelector(SELECTORS.content) as HTMLElement)?.innerText?.slice(0, 20)
    ).slice(0, 16)}`
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

// 首次扫描，等评论区渲染完成
function initialScan(retries = 5) {
  const comments = scanAllComments()
  if (comments.length > 0) {
    sendComments(comments)
  } else if (retries > 0) {
    // 评论区还没渲染，1秒后重试
    setTimeout(() => initialScan(retries - 1), 1000)
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

  // contenteditable p 元素：先清空再填入
  const el = input as HTMLElement
  el.focus()
  // 清空现有内容
  el.textContent = ""
  // 用 execCommand 填入，触发 Vue/React 的响应式更新
  document.execCommand("insertText", false, text)
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

// 滚动联动：监测哪条评论在视口中央，通知侧边栏高亮
let scrollObserver: IntersectionObserver | null = null

function setupScrollSync() {
  if (scrollObserver) scrollObserver.disconnect()

  const nodes = Array.from(document.querySelectorAll(SELECTORS.commentList))
  if (nodes.length === 0) return

  scrollObserver = new IntersectionObserver((entries) => {
    // 找交叉比例最大的那条（最居中的评论）
    const visible = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)

    if (visible.length > 0) {
      const topEntry = visible[0]
      const commentId = extractCommentId(topEntry.target)
      chrome.runtime.sendMessage({
        type: "SCROLL_TO_COMMENT",
        payload: { platformCommentId: commentId },
      }).catch(() => {})
    }
  }, { threshold: [0.3, 0.6, 1.0] })

  nodes.forEach(n => scrollObserver!.observe(n))
}

// 监听来自 background 的填入指令
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FILL_REPLY") {
    const { platformCommentId, text } = message.payload
    fillReply(platformCommentId, text).then(sendResponse)
    return true
  }
})

// 启动
setTimeout(() => {
  initialScan()
  observer.observe(document.body, { childList: true, subtree: true })
  // 延迟一点等评论节点全部渲染
  setTimeout(setupScrollSync, 1000)
}, 2000)
