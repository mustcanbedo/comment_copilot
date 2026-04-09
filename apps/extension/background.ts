import { Storage } from "@plasmohq/storage"
import {
  API_BASE,
  AUTH_TOKEN_KEY,
  DEFAULT_TENANT_ID,
  isCommentCopilotPageUrl,
} from "./constants"
import { parseAiSuggestionsResponse } from "./parse-ai-suggestions-response"

const storage = new Storage()

/** 侧栏发起的消息可带 `tabId`；否则用 lastFocusedWindow（比 currentWindow 更贴近用户正在看的页面标签） */
type MessageWithOptionalTab = { tabId?: number }

function resolveTargetTabId(message: MessageWithOptionalTab, cb: (tabId: number | undefined) => void) {
  if (typeof message.tabId === "number" && message.tabId >= 0) {
    cb(message.tabId)
    return
  }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    cb(tabs[0]?.id)
  })
}

/** 将 manifest 的 match 模式转为可测 URL 的正则（支持 * 通配） */
function urlMatchesPattern(url: string, pattern: string): boolean {
  if (pattern === "<all_urls>") return true
  try {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    return new RegExp(`^${escaped}$`, "i").test(url)
  } catch {
    return false
  }
}

/** 按当前页 URL 从 manifest 取应对应注入的 content_scripts[].js */
function getContentScriptJsFilesForUrl(pageUrl: string | undefined): string[] {
  if (!pageUrl) return []
  const m = chrome.runtime.getManifest() as chrome.runtime.ManifestV3
  for (const cs of m.content_scripts ?? []) {
    if (!cs.js?.length || !cs.matches?.length) continue
    for (const pat of cs.matches) {
      if (urlMatchesPattern(pageUrl, pat)) return cs.js
    }
  }
  return []
}

/** 动态注入（解决「扩展刚更新 / 标签未刷新」时 declarative CS 未挂载 → Receiving end does not exist） */
function injectContentScriptsForTab(tabId: number, pageUrl: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    const files = getContentScriptJsFilesForUrl(pageUrl)
    if (!files.length) {
      resolve()
      return
    }
    chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[CommentCopilot] scripting.executeScript", tabId, chrome.runtime.lastError.message)
      }
      resolve()
    })
  })
}

const RECEIVER_MISSING =
  /Receiving end does not exist|Could not establish connection/i

function sendMessageToTabWithInjectFallback<T>(
  tabId: number,
  payload: object,
  map: (raw: unknown) => T,
  respond: (value: T) => void
) {
  chrome.tabs.get(tabId, (tab) => {
    const pageUrl = tab?.url
    const once = () => {
      chrome.tabs.sendMessage(tabId, payload, (raw) => {
        const err = chrome.runtime.lastError
        if (err) {
          if (RECEIVER_MISSING.test(err.message ?? "") && pageUrl) {
            void injectContentScriptsForTab(tabId, pageUrl).then(() => {
              chrome.tabs.sendMessage(tabId, payload, (raw2) => {
                if (chrome.runtime.lastError) {
                  console.warn("[CommentCopilot] sendMessage retry", chrome.runtime.lastError.message)
                  respond(map(null))
                  return
                }
                respond(map(raw2))
              })
            })
            return
          }
          console.warn("[CommentCopilot] sendMessage", err.message)
          respond(map(null))
          return
        }
        respond(map(raw))
      })
    }
    once()
  })
}

// 点击插件图标时打开侧边栏
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    // @ts-ignore - chrome.sidePanel 在旧版类型定义里可能不存在
    chrome.sidePanel?.open({ tabId: tab.id })
  }
})

// 同一标签内 URL 变化（如从笔记页整页跳转到首页）：若变为非笔记页，通知侧边栏清空
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || isCommentCopilotPageUrl(tab.url)) return
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([active]) => {
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

  // SCROLL_TO_COMMENT / URL_CHANGED 等由 content 广播，sidepanel 同步监听；background 仅 ack，避免未处理报错
  if (
    message.type === "SCROLL_TO_COMMENT" ||
    message.type === "URL_CHANGED" ||
    message.type === "PAGE_COMMENTS_DOM_CHANGED"
  ) {
    sendResponse({ ok: true })
    return
  }

  if (message.type === "FILL_NOTE_COMMENT") {
    resolveTargetTabId(message as MessageWithOptionalTab, (tabId) => {
      if (!tabId) {
        sendResponse({ ok: false, error: "no active tab" })
        return
      }
      sendMessageToTabWithInjectFallback(
        tabId,
        { type: "FILL_NOTE_COMMENT", payload: message.payload },
        (raw) => (raw && typeof raw === "object" ? raw : { ok: false }) as { ok?: boolean; error?: string },
        sendResponse
      )
    })
    return true
  }

  if (message.type === "FILL_REPLY") {
    resolveTargetTabId(message as MessageWithOptionalTab, (tabId) => {
      if (!tabId) {
        sendResponse({ ok: false, error: "no active tab" })
        return
      }
      sendMessageToTabWithInjectFallback(
        tabId,
        { type: "FILL_REPLY", payload: message.payload },
        (raw) => (raw && typeof raw === "object" ? raw : { ok: false }) as { ok?: boolean; error?: string },
        sendResponse
      )
    })
    return true
  }

  if (message.type === "GET_ALL_PAGE_COMMENTS") {
    resolveTargetTabId(message as MessageWithOptionalTab, (tabId) => {
      if (!tabId) {
        sendResponse([])
        return
      }
      sendMessageToTabWithInjectFallback(
        tabId,
        { type: "GET_ALL_PAGE_COMMENTS" },
        (raw) => (Array.isArray(raw) ? raw : []),
        sendResponse
      )
    })
    return true
  }

  if (message.type === "MARK_COMMENT_REPLIED") {
    handleMarkCommentReplied(message.payload).then(sendResponse)
    return true
  }

  if (message.type === "GET_POST_CONTENT") {
    resolveTargetTabId(message as MessageWithOptionalTab, (tabId) => {
      if (!tabId) {
        sendResponse({ postTitle: "", postContent: "", postUrl: "" })
        return
      }
      sendMessageToTabWithInjectFallback(
        tabId,
        { type: "GET_POST_CONTENT" },
        (raw) =>
          raw && typeof raw === "object"
            ? (raw as { postTitle: string; postContent: string; postUrl: string })
            : { postTitle: "", postContent: "", postUrl: "" },
        sendResponse
      )
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
