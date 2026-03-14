import { Storage } from "@plasmohq/storage"
import { API_BASE, DEFAULT_TENANT_ID } from "./constants"

const storage = new Storage()

// 点击插件图标时打开侧边栏
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    // @ts-ignore - chrome.sidePanel 在旧版类型定义里可能不存在
    chrome.sidePanel?.open({ tabId: tab.id })
  }
})

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

  // SCROLL_TO_COMMENT / URL_CHANGED 由 content script 直接广播到所有扩展页面
  // （sidepanel 会直接收到，background 无需转发，转发反而导致 sidepanel 收到两次）
  if (message.type === "SCROLL_TO_COMMENT" || message.type === "URL_CHANGED") {
    sendResponse({ ok: true })
  }

  if (message.type === "FILL_REPLY") {
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

  if (message.type === "GET_ALL_PAGE_COMMENTS") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "GET_ALL_PAGE_COMMENTS" }, (comments) => {
          sendResponse(Array.isArray(comments) ? comments : [])
        })
      } else {
        sendResponse([])
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
    return await res.json()
  } catch (err) {
    console.error("[CommentCopilot] ai reply error:", err)
    return { ok: false, suggestions: [] }
  }
}
