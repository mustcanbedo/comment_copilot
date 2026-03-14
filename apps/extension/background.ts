import { Storage } from "@plasmohq/storage"

const storage = new Storage()

// 点击插件图标时打开侧边栏
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    // @ts-ignore - chrome.sidePanel 在旧版类型定义里可能不存在
    chrome.sidePanel?.open({ tabId: tab.id })
  }
})

// 本地开发指向 Next.js dev server，生产环境通过 .env 覆盖
const API_BASE = process.env.PLASMO_PUBLIC_API_URL || "http://localhost:3000/api"
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"

// 速率限制：维护最近操作时间戳
const replyTimestamps: number[] = []
const REPLY_THROTTLE_MS = 30_000

function canSendReply(): boolean {
  const now = Date.now()
  // 清理 1 小时前的记录
  const recent = replyTimestamps.filter(t => now - t < 3_600_000)
  replyTimestamps.length = 0
  replyTimestamps.push(...recent)
  if (recent.length === 0) return true
  return now - recent[recent.length - 1] >= REPLY_THROTTLE_MS
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "COMMENTS_COLLECTED") {
    handleCommentsCollected(message.payload).then(sendResponse)
    return true
  }

  if (message.type === "GET_AI_REPLY") {
    handleGetAiReply(message.payload).then(sendResponse)
    return true
  }

  if (message.type === "CIRCUIT_OPEN") {
    chrome.action.setBadgeText({ text: "!" })
    chrome.action.setBadgeBackgroundColor({ color: "#ff4444" })
    sendResponse({ ok: true })
  }

  if (message.type === "SCROLL_TO_COMMENT") {
    chrome.runtime.sendMessage({ type: "SCROLL_TO_COMMENT", payload: message.payload }).catch(() => {})
    sendResponse({ ok: true })
  }

  if (message.type === "URL_CHANGED") {
    chrome.runtime.sendMessage({ type: "URL_CHANGED", payload: message.payload }).catch(() => {})
    sendResponse({ ok: true })
  }

  if (message.type === "FILL_REPLY") {
    // 转发给当前激活 tab 的 content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: "FILL_REPLY",
          payload: message.payload,
        }, (res) => sendResponse(res || { ok: false }))
      } else {
        sendResponse({ ok: false, error: "no active tab" })
      }
    })
    return true
  }
})

async function handleCommentsCollected(payload: {
  platform: string
  comments: object[]
}) {
  const tenantId = (await storage.get("tenantId")) || DEFAULT_TENANT_ID

  try {
    const res = await fetch(`${API_BASE}/ingest/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    console.log("[CommentCopilot] ingest:", data)
    // 通知侧边栏刷新评论列表
    if (data.ok && data.saved > 0) {
      chrome.runtime.sendMessage({ type: "COMMENTS_UPDATED" }).catch(() => {})
    }
    return data
  } catch (err) {
    console.error("[CommentCopilot] ingest error:", err)
    return { ok: false }
  }
}

async function handleGetAiReply(payload: {
  commentId: string
  commentContent: string
  persona?: string
}) {
  if (!canSendReply()) {
    return { ok: false, error: "rate_limited", suggestions: [] }
  }

  const tenantId = (await storage.get("tenantId")) || DEFAULT_TENANT_ID

  try {
    const res = await fetch(`${API_BASE}/ai/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data.ok) {
      replyTimestamps.push(Date.now())
    }
    return data
  } catch (err) {
    console.error("[CommentCopilot] ai reply error:", err)
    return { ok: false, suggestions: [] }
  }
}
