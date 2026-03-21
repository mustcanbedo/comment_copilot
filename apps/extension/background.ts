import { Storage } from "@plasmohq/storage"
import { API_BASE, AUTH_TOKEN_KEY, DEFAULT_TENANT_ID, isXhsNotePageUrl } from "./constants"
import { parseAiSuggestionsResponse } from "./parse-ai-suggestions-response"

const storage = new Storage()

// 点击插件图标时打开侧边栏
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    // @ts-ignore - chrome.sidePanel 在旧版类型定义里可能不存在
    chrome.sidePanel?.open({ tabId: tab.id })
  }
})

// 同一标签内 URL 变化（如从笔记页整页跳转到首页）：若变为非笔记页，通知侧边栏清空
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || isXhsNotePageUrl(tab.url)) return
  chrome.tabs.query({ active: true, currentWindow: true }, ([active]) => {
    if (active?.id === tabId) {
      chrome.runtime.sendMessage({ type: "PAGE_LEFT_NOTE" }).catch(() => {})
    }
  })
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

  if (message.type === "GET_AI_NOTE_COMMENT") {
    handleGetAiNoteComment(message.payload).then(sendResponse)
    return true
  }

  if (message.type === "CIRCUIT_OPEN") {
    chrome.action.setBadgeText({ text: "!" })
    chrome.action.setBadgeBackgroundColor({ color: "#ff4444" })
    sendResponse({ ok: true })
    return
  }

  // SCROLL_TO_COMMENT / URL_CHANGED / XHS_VIEWER_* 由 content 广播，sidepanel 同步监听；background 仅 ack，避免未处理报错
  if (
    message.type === "SCROLL_TO_COMMENT" ||
    message.type === "URL_CHANGED" ||
    message.type === "XHS_VIEWER_UNRESOLVED" ||
    message.type === "XHS_VIEWER_RESOLVED"
  ) {
    sendResponse({ ok: true })
    return
  }

  if (message.type === "FILL_NOTE_COMMENT") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: "FILL_NOTE_COMMENT",
          payload: message.payload,
        }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message })
            return
          }
          sendResponse(res || { ok: false })
        })
      } else {
        sendResponse({ ok: false, error: "no active tab" })
      }
    })
    return true
  }

  if (message.type === "FILL_REPLY") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: "FILL_REPLY",
          payload: message.payload,
        }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message })
            return
          }
          sendResponse(res || { ok: false })
        })
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
          if (chrome.runtime.lastError) {
            sendResponse([])
            return
          }
          sendResponse(Array.isArray(comments) ? comments : [])
        })
      } else {
        sendResponse([])
      }
    })
    return true
  }

  if (message.type === "MARK_COMMENT_REPLIED") {
    handleMarkCommentReplied(message.payload).then(sendResponse)
    return true
  }

  if (message.type === "GET_POST_CONTENT") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "GET_POST_CONTENT" }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ postTitle: "", postContent: "", postUrl: "" })
            return
          }
          sendResponse(res ?? { postTitle: "", postContent: "", postUrl: "" })
        })
      } else {
        sendResponse({ postTitle: "", postContent: "", postUrl: "" })
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
  const token = await storage.get<string>(AUTH_TOKEN_KEY)

  try {
    const res = await fetch(`${API_BASE}/ingest/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function handleMarkCommentReplied(payload: {
  platformCommentId: string
  platform?: string
}) {
  const tenantId = (await storage.get("tenantId")) || DEFAULT_TENANT_ID
  const token = await storage.get<string>(AUTH_TOKEN_KEY)
  if (!token) return { ok: false, error: "未登录" }

  try {
    const res = await fetch(`${API_BASE}/comments/mark-replied`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        platformCommentId: payload.platformCommentId,
        platform: payload.platform || "xiaohongshu",
      }),
    })
    const data = await res.json()
    return data
  } catch (err) {
    console.error("[CommentCopilot] mark-replied error:", err)
    return { ok: false }
  }
}

async function handleGetAiNoteComment(payload: {
  postUrl: string
  postTitle?: string
  postContent?: string
  persona?: string
  style?: string
}) {
  const tenantId = (await storage.get("tenantId")) || DEFAULT_TENANT_ID
  const token = await storage.get<string>(AUTH_TOKEN_KEY)
  if (!token) {
    return { ok: false, error: "未登录", suggestions: [] as string[] }
  }

  try {
    const res = await fetch(`${API_BASE}/ai/note-comment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })
    return await parseAiSuggestionsResponse(res)
  } catch (err) {
    console.error("[CommentCopilot] ai note-comment error:", err)
    return { ok: false, error: "网络异常", suggestions: [] }
  }
}

async function handleGetAiReply(payload: {
  commentId: string
  commentContent: string
  persona?: string
  postTitle?: string
  postContent?: string
}) {
  const tenantId = (await storage.get("tenantId")) || DEFAULT_TENANT_ID
  const token = await storage.get<string>(AUTH_TOKEN_KEY)
  if (!token) {
    return { ok: false, error: "未登录", suggestions: [] as string[] }
  }

  try {
    const res = await fetch(`${API_BASE}/ai/reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    })
    return await parseAiSuggestionsResponse(res)
  } catch (err) {
    console.error("[CommentCopilot] ai reply error:", err)
    return { ok: false, error: "网络异常", suggestions: [] }
  }
}
