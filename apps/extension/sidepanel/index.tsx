import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Storage } from "@plasmohq/storage"
import {
  API_BASE,
  AUTH_TOKEN_KEY,
  canonicalDouyinPostUrl,
  commentCopilotPlatformFromUrl,
  commentCopilotTabFetchDedupeKey,
  DEFAULT_TENANT_ID,
  FEEDBACK_URL,
  getCommentCopilotPageKind,
  isCommentCopilotPageUrl,
  type CommentCopilotPageKind,
  YANLING_DOUYIN_SELF_NICK_STORAGE_KEY,
  YANLING_XHS_SELF_NICK_STORAGE_KEY,
} from "../constants"
import lianxiQrPng from "../assets/lianxi.png"
import LoginView from "./login-view"
import "./style.css"

/**
 * `chrome.runtime.sendMessage` 在常见 Chrome 环境下不向调用方返回 Promise；
 * 直接 `await sendMessage(...)` 会得到 `undefined`，background 里 `sendResponse` 的结果传不回侧栏，网络请求看似「从未发起」。
 */
/** 抖音页：侧栏不弹出操作类 toast（仍复制剪贴板、控制台可排查） */
function isDouyinTabUrl(url?: string | null) {
  return !!url?.includes("douyin.com")
}

function runtimeSendMessage<T = unknown>(message: object): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError
        if (err) {
          reject(new Error(err.message))
          return
        }
        resolve(response as T)
      })
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * 仅使用「当前窗口 + 当前激活标签」——若该标签不是支持页则返回 undefined。
 * 不在窗口内回退到其他 B 站/小红书标签，避免多标签同时打开时侧栏显示「别的页面」的评论或跟评上下文串台。
 */
function pickActiveCommentCopilotTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) {
      resolve(undefined)
      return
    }
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const t0 = tabs[0]
      if (t0?.url && isCommentCopilotPageUrl(t0.url)) resolve(t0)
      else resolve(undefined)
    })
  })
}

/** 仅当消息来自 content 且发送方标签就是当前激活标签时执行 cb（避免后台其他标签的 URL_CHANGED / 滚动 干扰侧栏） */
function whenMessageFromActiveTab(
  sender: chrome.runtime.MessageSender,
  cb: () => void
): void {
  const sid = sender.tab?.id
  if (sid == null) return
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) return
    if (tabs[0]?.id === sid) cb()
  })
}

/**
 * 侧栏点击「回复」时焦点常在侧栏，`active tab` 可能不是视频页 → FILL_REPLY 发到错误标签会「完全没反应」。
 * 优先使用「上次成功拉取评论」的标签；无效时再回退到当前激活的支持页（`pickActiveCommentCopilotTab`）。
 */
function resolveZhiyanTargetTab(storedTabId: number | undefined | null): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.tabs?.get) {
      resolve(undefined)
      return
    }
    if (typeof storedTabId !== "number" || storedTabId < 0) {
      void pickActiveCommentCopilotTab().then(resolve)
      return
    }
    chrome.tabs.get(storedTabId, (tab) => {
      if (chrome.runtime.lastError || !tab?.id || !tab.url || !isCommentCopilotPageUrl(tab.url)) {
        void pickActiveCommentCopilotTab().then(resolve)
        return
      }
      resolve(tab)
    })
  })
}

/** Background 对 AI 接口统一解析后的结果（含 HTTP/body 失败与 code） */
type AiGenResult = { ok?: boolean; error?: string; message?: string; code?: string; suggestions?: string[] }

function aiGenerationErrorMessage(result: AiGenResult | null | undefined): string | undefined {
  if (!result || result.ok !== false) return undefined
  // Background 已对积分不足、英文错误码做中文映射；此处仅兜底
  return result.error || result.message || "生成失败"
}

const LANGUAGES = [{ code: "zh-CN", label: "简体中文" }] as const

class SidePanelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div style={{ padding: 16, background: "#eeece9", minHeight: "100vh", fontSize: 13 }}>
          <p style={{ color: "#c00", marginBottom: 8 }}>出错了</p>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

// 虚拟列表：每次只渲染可见区域 ± BUFFER 条评论
const ITEM_ESTIMATED_HEIGHT = 120
const BUFFER = 5

const storage = new Storage()
const SAVED_REPLIES_KEY_PREFIX = "savedReplies:v1"

const getSavedRepliesKey = (userId: string | null | undefined) =>
  `${SAVED_REPLIES_KEY_PREFIX}:${userId || "anonymous"}`

const intentConfig: Record<string, { emoji: string; label: string; badgeClass: string }> = {
  hot:  { emoji: "🔥", label: "高意向", badgeClass: "hot" },
  warm: { emoji: "✨", label: "中意向", badgeClass: "pending" },
  cold: { emoji: "👀", label: "普通", badgeClass: "cold" },
  spam: { emoji: "🚫", label: "垃圾", badgeClass: "cold" },
}

function getCommentBadge(comment: Comment): { emoji: string; label: string; badgeClass: string } {
  if (comment.intentLevel === "hot") return intentConfig.hot
  if (comment.status === "done" || comment.status === "replied") {
    return { emoji: "✅", label: "已回复", badgeClass: "cold" }
  }
  if (comment.status === "pending") return { emoji: "🕐", label: "待处理", badgeClass: "pending" }
  return intentConfig[comment.intentLevel ?? "cold"]
}

interface Comment {
  id: string
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
  status: string
  intentLevel: string | null
  postUrl: string | null
  /** 与 content 中 [表情] 一一对应的 emoji 图 URL，侧栏用 img 展示 */
  emojiUrls?: string[]
  /** 评论附图（.comment-picture），纯图评论时 content 为【图片】 */
  attachmentImageUrls?: string[]
}

interface PageComment {
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
  postUrl: string
  emojiUrls?: string[]
  attachmentImageUrls?: string[]
  /** 抖音：DOM 内已见当前用户在该楼下的子回复，视为已在页上发出 */
  domSelfReplied?: boolean
}

interface AiState {
  loading: boolean
  suggestions: string[]
  copied: number | null
  error?: string
}

interface UserProfile {
  id: string
  email: string
  name: string
  points?: {
    freeBalance: number
    freeQuota: number
    topupBalance: number
    total: number
  }
}

interface SavedReply {
  id: string
  text: string
  fromComment: string
  createdAt: string
  category: string
}

type Filter = "all" | "pending" | "hot"

type Nav = "account" | "zhiyan" | "cunyan" | "settings"

/** 存言去重/展示用：笔记主评论 AI 建议不关联单条评论 */
const NOTE_COMMENT_SAVE_SNIPPET = "笔记跟评"

function applyFilter(list: Comment[], filter: Filter): Comment[] {
  if (filter === "hot") return list.filter(c => c.intentLevel === "hot")
  if (filter === "pending") return list.filter(c => c.status !== "done" && c.status !== "replied")
  return list
}

function mergeWithDb(pageComments: PageComment[], dbMap: Map<string, Comment>): Comment[] {
  return pageComments.map((pc) => {
    const db = dbMap.get(pc.platformCommentId)
    const statusFromDb = db?.status ?? "pending"
    /** 抖音：页内已见自己的子回复（`domSelfReplied`）时优先于 DB 的 pending，与侧栏填入即已回复互补 */
    const status =
      statusFromDb === "done" || statusFromDb === "replied"
        ? statusFromDb
        : pc.domSelfReplied
          ? "replied"
          : statusFromDb
    return {
      // 统一用 platformCommentId 作为前端列表 ID，避免后端重复数据导致 React key 冲突
      id: pc.platformCommentId,
      platformCommentId: pc.platformCommentId,
      authorName: pc.authorName,
      content: pc.content,
      commentedAt: pc.commentedAt,
      postUrl: pc.postUrl,
      status,
      intentLevel: db?.intentLevel ?? null,
      ...(pc.emojiUrls?.length ? { emojiUrls: pc.emojiUrls } : {}),
      ...(pc.attachmentImageUrls?.length ? { attachmentImageUrls: pc.attachmentImageUrls } : {}),
    }
  })
}

// ─── 页面组件：智言（评论列表 + AI 回复） ───────────────────────────────────
function ZhiyanPage(props: {
  /** 全部评论（统计区用） */
  allComments: Comment[]
  /** 筛选后条数（用于「筛选下为空」提示） */
  filteredCount: number
  loading: boolean
  switching: boolean
  filter: Filter
  visible: Comment[]
  topHeight: number
  bottomHeight: number
  listContainerRef: React.RefObject<HTMLDivElement | null>
  cardRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>
  itemHeightsRef: React.MutableRefObject<Record<string, number>>
  aiStates: Record<string, AiState>
  savedReplies: SavedReply[]
  generateReply: (c: Comment) => void
  fillReply: (c: Comment, text: string, index: number) => void
  toggleSaveReply: (c: Comment, text: string) => void
  hotCount: number
  pendingCount: number
  setFilter: (f: Filter) => void
  /** 当前标签是否为「支持主评 AI」的页面（小红书笔记 / B 站视频等），由 URL 判定 */
  tabCommentPageKind: CommentCopilotPageKind | null
  /** 笔记下方「主评论」AI（/api/ai/note-comment） */
  noteCommentAi: AiState
  generateNoteComment: () => void
  fillNoteSuggestion: (text: string, index: number) => void
  toggleSaveNoteReply: (text: string) => void
}) {
  const {
    allComments,
    filteredCount,
    loading,
    switching,
    filter,
    visible,
    topHeight,
    bottomHeight,
    listContainerRef,
    cardRefs,
    itemHeightsRef,
    aiStates,
    savedReplies,
    generateReply,
    fillReply,
    toggleSaveReply,
    hotCount,
    pendingCount,
    setFilter,
    tabCommentPageKind,
    noteCommentAi,
    generateNoteComment,
    fillNoteSuggestion,
    toggleSaveNoteReply,
  } = props

  const [noteCommentExpanded, setNoteCommentExpanded] = useState(() => {
    try {
      return localStorage.getItem("yanling_note_comment_expanded") === "1"
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem("yanling_note_comment_expanded", noteCommentExpanded ? "1" : "0")
    } catch {
      /* ignore */
    }
  }, [noteCommentExpanded])

  return (
    <>
      <div
        className={`zhiyan-note-comment-card ${tabCommentPageKind ? "" : "zhiyan-note-comment-card--inactive"}`}
      >
        <div className="zhiyan-note-comment-toolbar">
          <button
            type="button"
            className="zhiyan-note-comment-title-area"
            onClick={() => setNoteCommentExpanded(v => !v)}
            aria-expanded={noteCommentExpanded}
          >
            <div className="zhiyan-note-comment-head-text">
              <span className="zhiyan-note-comment-title">
                {tabCommentPageKind === "bilibili-video" || tabCommentPageKind === "douyin-video"
                  ? "视频跟评"
                  : "笔记跟评"}
              </span>
              {noteCommentExpanded ? (
                <span className="zhiyan-note-comment-sub">
                  {tabCommentPageKind === "bilibili-video" || tabCommentPageKind === "douyin-video"
                    ? "发在视频下的主评论，非回复某条评论"
                    : "发在笔记下的主评论，非回复某条评论"}
                </span>
              ) : null}
            </div>
          </button>
          <div className="zhiyan-note-comment-toolbar-actions">
            <button
              type="button"
              className="zhiyan-note-comment-chevron-btn"
              onClick={() => setNoteCommentExpanded(v => !v)}
              aria-label={noteCommentExpanded ? "收起笔记跟评" : "展开笔记跟评"}
            >
              <svg
                className={`zhiyan-note-comment-chevron-icon ${noteCommentExpanded ? "zhiyan-note-comment-chevron-icon--up" : ""}`}
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
        </div>
        {!noteCommentExpanded && noteCommentAi.loading ? (
          <p className="zhiyan-note-comment-collapsed-hint">AI 思考中…</p>
        ) : null}
        {noteCommentExpanded ? (
          !tabCommentPageKind ? (
            <p className="zhiyan-note-comment-hint">
              请先在浏览器里<strong>打开并选中</strong>要操作的标签页：小红书<strong>笔记详情</strong>、哔哩哔哩
              <strong>视频播放页</strong>，或抖音的<strong>视频页 / 首页·精选等信息流</strong>，再使用本功能。
              <span className="zhiyan-note-comment-hint-detail">
                多标签时请<strong>单击</strong>目标标签使其成为当前页。链接里常见 <code>/explore/</code>、
                <code>/video/</code>、<code>modal_id</code> 等，以实际地址栏为准。
              </span>
            </p>
          ) : (
            <>
              {!noteCommentAi.loading &&
                !noteCommentAi.error &&
                noteCommentAi.suggestions.length === 0 && (
                  <button type="button" className="zhiyan-note-comment-generate" onClick={generateNoteComment}>
                    ✨ 生成AI评论
                  </button>
                )}
              {noteCommentAi.loading && <div className="ai-loading zhiyan-note-comment-loading">AI 思考中…</div>}
              {noteCommentAi.error && (
                <div className="ai-error-row">
                  <span className="ai-error">{noteCommentAi.error}</span>
                  <button type="button" className="retry-btn" onClick={generateNoteComment}>
                    重试
                  </button>
                </div>
              )}
              {noteCommentAi.suggestions.length > 0 && (
                <div className="suggestions zhiyan-note-suggestions">
                  {noteCommentAi.suggestions.map((s, i) => {
                    const isSaved = savedReplies.some(
                      r => r.text === s && r.fromComment === NOTE_COMMENT_SAVE_SNIPPET
                    )
                    return (
                      <div key={i} className="suggestion-item">
                        <p className="suggestion-text">{s}</p>
                        <div className="suggestion-actions">
                          <button
                            type="button"
                            className={`fav-btn ${isSaved ? "favored" : ""}`}
                            onClick={() => toggleSaveNoteReply(s)}
                          >
                            {isSaved ? "★ 已收藏" : "☆ 收藏"}
                          </button>
                          <button
                            type="button"
                            className={`copy-btn ${noteCommentAi.copied === i ? "copied" : ""}`}
                            onClick={() => fillNoteSuggestion(s, i)}
                          >
                            {noteCommentAi.copied === i ? "✅ 已填入" : "评论"}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  <button type="button" className="regenerate-btn" onClick={generateNoteComment}>
                    重新生成
                  </button>
                </div>
              )}
            </>
          )
        ) : null}
      </div>

      <div className="stats-row" role="tablist" aria-label="评论筛选">
        <button
          type="button"
          role="tab"
          aria-selected={filter === "all"}
          className={`stat-item ${filter === "all" ? "stat-item--active" : ""}`}
          onClick={() => setFilter("all")}
        >
          <span className="stat-num">{allComments.length}</span>
          <span className="stat-label">全部</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === "hot"}
          className={`stat-item hot ${filter === "hot" ? "stat-item--active" : ""}`}
          onClick={() => setFilter("hot")}
        >
          <span className="stat-num">{hotCount}</span>
          <span className="stat-label">🔥 高意向</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={filter === "pending"}
          className={`stat-item ${filter === "pending" ? "stat-item--active" : ""}`}
          onClick={() => setFilter("pending")}
        >
          <span className="stat-num">{pendingCount}</span>
          <span className="stat-label">🕐 待处理</span>
        </button>
      </div>

      {!loading && allComments.length === 0 ? (
        <div className="empty">
          {switching ? (
            <>
              <p>正在同步新帖子评论…</p>
              <p className="hint">请稍候</p>
            </>
          ) : (
            <>
              <p>暂无评论</p>
              <p className="hint">
                {tabCommentPageKind === "bilibili-video" || tabCommentPageKind === "douyin-video"
                  ? "请展开/滚动到评论区，待评论加载后再看侧栏；若仍为空可尝试刷新视频页。"
                  : tabCommentPageKind === "xhs-note"
                    ? "请打开小红书笔记详情页，评论会自动同步。"
                    : "请打开小红书笔记、哔哩哔哩视频页或抖音视频/信息流页，评论会自动同步。"}
              </p>
            </>
          )}
        </div>
      ) : !loading && filteredCount === 0 ? (
        <div className="empty">
          <p>当前筛选下暂无评论</p>
          <p className="hint">试试切换到「全部」查看</p>
        </div>
      ) : (
        <div className="comment-list" ref={listContainerRef}>
          {topHeight > 0 && <div style={{ height: topHeight, flexShrink: 0 }} />}

          {visible.map(comment => {
            const ai = aiStates[comment.id]
            const badge = getCommentBadge(comment)
            const isHot = comment.intentLevel === "hot"
            return (
              <div
                key={comment.id}
                className="comment-item"
                ref={el => {
                  cardRefs.current[comment.id] = el
                  if (el && itemHeightsRef.current[comment.id] !== el.offsetHeight) {
                    itemHeightsRef.current[comment.id] = el.offsetHeight
                  }
                }}
              >
                <div className="comment-item-meta">
                  <div className="comment-item-avatar">
                    {(comment.authorName || "?").slice(0, 1)}
                  </div>
                  <span className="comment-item-author">{comment.authorName}</span>
                  <span className={`comment-item-badge ${badge.badgeClass}`}>
                    {badge.emoji} {badge.label}
                  </span>
                </div>
                <p className="comment-item-content">
                  {comment.emojiUrls?.length && comment.content.includes("[表情]")
                    ? comment.content.split("[表情]").flatMap((seg, i) => [
                        <span key={`t-${i}`}>{seg}</span>,
                        ...(comment.emojiUrls![i]
                          ? [
                              <img
                                key={`e-${i}`}
                                src={comment.emojiUrls![i]}
                                alt=""
                                className="comment-emoji"
                                referrerPolicy="no-referrer"
                              />,
                            ]
                          : []),
                      ])
                    : comment.content}
                </p>
                {comment.attachmentImageUrls?.length ? (
                  <div className="comment-attachments">
                    {comment.attachmentImageUrls.map((url, i) => (
                      <img
                        key={i}
                        src={url}
                        alt="评论图片"
                        className="comment-attachment-img"
                        referrerPolicy="no-referrer"
                      />
                    ))}
                  </div>
                ) : null}

                {!ai && (
                  <button
                    className={`comment-item-btn ${isHot ? "primary" : "ghost"}`}
                    onClick={() => generateReply(comment)}
                  >
                    ✨ 生成 AI 回复
                  </button>
                )}
                {ai?.loading && <div className="ai-loading">AI 思考中…</div>}
                {ai?.error && (
                  <div className="ai-error-row">
                    <span className="ai-error">{ai.error}</span>
                    <button className="retry-btn" onClick={() => generateReply(comment)}>重试</button>
                  </div>
                )}
                {ai && !ai.loading && ai.suggestions.length > 0 && (
                  <div className="suggestions">
                    {ai.suggestions.map((s, i) => {
                      const isSaved = savedReplies.some(
                        r => r.text === s && r.fromComment === comment.content.slice(0, 80)
                      )
                      return (
                        <div key={i} className="suggestion-item">
                          <p className="suggestion-text">{s}</p>
                          <div className="suggestion-actions">
                            <button
                              className={`fav-btn ${isSaved ? "favored" : ""}`}
                              onClick={() => toggleSaveReply(comment, s)}
                            >
                              {isSaved ? "★ 已收藏" : "☆ 收藏"}
                            </button>
                            <button
                              className={`copy-btn ${ai.copied === i ? "copied" : ""}`}
                              onClick={() => fillReply(comment, s, i)}
                            >
                              {ai.copied === i ? "✅ 已填入" : "回复"}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    <button className="regenerate-btn" onClick={() => generateReply(comment)}>
                      重新生成
                    </button>
                  </div>
                )}
              </div>
            )
          })}

          {bottomHeight > 0 && <div style={{ height: bottomHeight, flexShrink: 0 }} />}
        </div>
      )}
    </>
  )
}

// ─── 页面组件：存言（收藏话术） ───────────────────────────────────────────────
function CunyanPage(props: {
  savedReplies: SavedReply[]
  category: string
  setCategory: (c: string) => void
  search: string
  setSearch: (v: string) => void
  onDelete?: (id: string) => void
}) {
  const { savedReplies, category, setCategory, search, setSearch, onDelete } = props
  const categories = Array.from(new Set(savedReplies.map(r => r.category || "未分类")))
  categories.sort()

  const filtered = savedReplies.filter(r => {
    const matchCat = category === "全部" || r.category === category
    const q = search.trim()
    if (!q) return matchCat
    const lc = q.toLowerCase()
    return matchCat && (r.text.toLowerCase().includes(lc) || r.fromComment.toLowerCase().includes(lc))
  })

  return (
    <div className="cunyan-root">
      <div className="cunyan-controls">
        <select
          className="cunyan-select"
          value={category}
          onChange={e => setCategory(e.target.value)}
        >
          <option value="全部">全部</option>
          {categories.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          className="cunyan-search"
          placeholder="搜索存言…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty cunyan-placeholder">
          <p>暂无存言</p>
          <p className="hint">在智言页收藏 AI 回复，这里会出现你的常用话术</p>
        </div>
      ) : (
        <div className="cunyan-list">
          {filtered.map(item => (
            <div key={item.id} className="cunyan-item">
              <div className="cunyan-item-main">
                <div className="cunyan-text">{item.text}</div>
                <div className="cunyan-meta">
                  <span className="cunyan-category">{item.category || "未分类"}</span>
                  <span className="cunyan-time">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="cunyan-source">来自评论：{item.fromComment}</div>
              </div>
              {onDelete && (
                <button
                  type="button"
                  className="cunyan-delete-btn"
                  onClick={() => onDelete(item.id)}
                  title="删除"
                  aria-label="删除"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const FREE_POINTS_QUOTA = 2000

// ─── 页面组件：我的账户 ─────────────────────────────────────────────────────
function AccountPage({ profile, onLogout }: { profile: UserProfile | null; onLogout: () => void }) {
  const displayName = profile?.name || profile?.email || "未命名用户"
  const avatarChar = (displayName || "?").slice(0, 1).toUpperCase()
  const email = profile?.email || "—"

  const points = profile?.points
  const totalPoints = points?.total ?? 0
  const freeBalance = points?.freeBalance ?? 0
  const freeQuota = points?.freeQuota ?? FREE_POINTS_QUOTA
  const topUpBalance = points?.topupBalance ?? 0

  return (
    <div className="account-root">
      {/* 头像与信息卡片 */}
      <div className="account-profile-card">
        <div className="account-avatar-wrap">
          <div className="account-avatar">{avatarChar}</div>
          <span className="account-avatar-badge" title="编辑头像" />
        </div>
        <div className="account-info">
          <div className="account-name">{displayName}</div>
          <div className="account-email">{email}</div>
        </div>
        <div className="account-actions">
          <button type="button" className="account-btn account-btn-profile" title="编辑资料">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </button>
          <button type="button" className="account-btn account-btn-logout" onClick={onLogout} title="退出登录">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 订阅与积分卡片 */}
      <div className="account-subscription-card">
        <div className="account-sub-header">
          <span className="account-sub-title">言灵 基础版</span>
        </div>
        <div className="account-sub-divider" />
        <div className="account-points-section">
          <div>
            <div className="account-points-row account-points-total">
              <span className="account-points-label">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                积分
                <span className="account-info-icon" title="积分说明">ⓘ</span>
              </span>
              <span className="account-points-value">{totalPoints.toLocaleString()}</span>
            </div>
            <div className="account-points-row">
              <span className="account-points-label">免费积分</span>
              <span className="account-points-muted" title="剩余 / 共">{freeBalance.toLocaleString()} / {freeQuota.toLocaleString()}</span>
            </div>
            <div className="account-points-row">
              <span className="account-points-label">
                充值积分
                <span className="account-info-icon" title="充值说明">ⓘ</span>
              </span>
              <span className="account-points-muted">{topUpBalance.toLocaleString()}</span>
            </div>
          </div>
          <div className="account-contact-qr-wrap">
            <img src={lianxiQrPng} alt="联系客服微信" className="account-contact-qr" width={176} height={176} />
          </div>
          <button type="button" className="account-topup-btn">+ 充值积分</button>
        </div>
      </div>
    </div>
  )
}

// ─── 驭灵设置存储 key ───────────────────────────────────────────────────────
const SETTINGS_KEY = "yuling:settings:v1"

type SyncFreq = "realtime" | "15min" | "manual"

interface YulingSettings {
  language: string
  highIntentReminder: boolean
  productUpdates: boolean
  syncFreq: SyncFreq
}

const defaultSettings: YulingSettings = {
  language: "zh-CN",
  highIntentReminder: false,
  productUpdates: true,
  syncFreq: "manual",
}

// ─── 页面组件：驭灵（设置）────────────────────────────────────────────────────
function SettingsPage() {
  const [settings, setSettings] = useState<YulingSettings>(defaultSettings)

  useEffect(() => {
    storage.get<YulingSettings>(SETTINGS_KEY).then(s => {
      if (s) setSettings({ ...defaultSettings, ...s })
    }).catch(() => {})
  }, [])

  const updateSettings = useCallback((patch: Partial<YulingSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      storage.set(SETTINGS_KEY, next).catch(() => {})
      return next
    })
  }, [])

  return (
    <div className="yuling-root">
      {/* 通用 */}
      <section className="yuling-section">
        <h3 className="yuling-section-title">通用</h3>
        <div className="yuling-row">
          <span className="yuling-row-label">语言</span>
          <select
            className="yuling-select"
            value={settings.language}
            onChange={e => updateSettings({ language: e.target.value })}
          >
            {LANGUAGES.map(lang => (
              <option key={lang.code} value={lang.code}>{lang.label}</option>
            ))}
          </select>
        </div>
      </section>

      {/* 通知偏好 */}
      <section className="yuling-section">
        <h3 className="yuling-section-title">通知偏好</h3>
        <div className="yuling-row yuling-row-with-desc">
          <div>
            <span className="yuling-row-label">高意向评论提醒</span>
            <p className="yuling-row-desc">有新的购买咨询或投诉时推送通知</p>
          </div>
          <label className="yuling-toggle">
            <input
              type="checkbox"
              checked={settings.highIntentReminder}
              disabled
              readOnly
            />
            <span className="yuling-toggle-slider" />
          </label>
        </div>
        <div className="yuling-row yuling-row-with-desc">
          <div>
            <span className="yuling-row-label">接收产品更新</span>
            <p className="yuling-row-desc">新功能发布时通过邮件通知</p>
          </div>
          <label className="yuling-toggle">
            <input
              type="checkbox"
              checked={settings.productUpdates}
              onChange={e => updateSettings({ productUpdates: e.target.checked })}
            />
            <span className="yuling-toggle-slider" />
          </label>
        </div>
      </section>

      {/* 同步 */}
      <section className="yuling-section">
        <h3 className="yuling-section-title">同步</h3>
        <div className="yuling-row yuling-row-col">
          <span className="yuling-row-label">评论同步频率</span>
          <div className="yuling-segmented yuling-segmented-disabled">
            {(["realtime", "15min", "manual"] as const).map(k => (
              <button
                key={k}
                type="button"
                className={`yuling-segmented-btn ${settings.syncFreq === k ? "active" : ""}`}
                disabled
              >
                {k === "realtime" ? "实时" : k === "15min" ? "15分钟" : "手动"}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 关于 */}
      <section className="yuling-section">
        <h3 className="yuling-section-title">关于</h3>
        <button
          type="button"
          className="yuling-link-row"
          onClick={() => {
            if (typeof chrome !== "undefined" && chrome.tabs) {
              chrome.tabs.create({ url: FEEDBACK_URL })
            } else {
              window.open(FEEDBACK_URL, "_blank")
            }
          }}
        >
          <span>意见反馈</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="yuling-row">
          <span className="yuling-row-label">当前版本</span>
          <span className="yuling-row-value">v1.0.0</span>
        </div>
      </section>
    </div>
  )
}

function SidePanel() {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [aiStates, setAiStates] = useState<Record<string, AiState>>({})
  const [filter, setFilter] = useState<Filter>("all")
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 })
  const [activeNav, setActiveNav] = useState<Nav>("zhiyan")
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([])
  const [cunyanCategory, setCunyanCategory] = useState<string>("全部")
  const [cunyanSearch, setCunyanSearch] = useState<string>("")
  const [panelToast, setPanelToast] = useState<string | null>(null)
  /** 当前标签页类型（URL 判定）：用于「笔记/视频跟评」与评论拉取门禁 */
  const [tabCommentPageKind, setTabCommentPageKind] = useState<CommentCopilotPageKind | null>(null)
  const [noteCommentAi, setNoteCommentAi] = useState<AiState>({ loading: false, suggestions: [], copied: null })
  const noteCommentInflightRef = useRef(false)

  /** 供消息回调读取最新列表，避免闭包陈旧 */
  const commentsRef = useRef<Comment[]>([])
  commentsRef.current = comments

  /** 页面滚动联动：当前筛选下找不到目标评论时先切回「全部」，再由此 ref 触发二次滚动 */
  const pendingScrollToPlatformIdRef = useRef<string | null>(null)
  /** 因滚动联动自动切到「全部」时，跳过「切筛选就滚回顶部」避免冲掉定位 */
  const skipNextFilterScrollResetRef = useRef(false)
  /** 上次 `fetchComments` 使用的标签（与列表数据一致）；填回复 / 拉帖子须优先用它，避免侧栏抢焦点选错 tab */
  const zhiyanSourceTabIdRef = useRef<number | undefined>(undefined)
  /** `tabs.onUpdated` 与切标签对齐，避免同一帖子身份连续触发多次拉取 */
  const tabUrlFetchDedupeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!panelToast) return
    const t = setTimeout(() => setPanelToast(null), 3500)
    return () => clearTimeout(t)
  }, [panelToast])

  useEffect(() => {
    storage.get<string>(AUTH_TOKEN_KEY).then(token => setIsLoggedIn(!!token)).catch(() => setIsLoggedIn(false))
    const t = setTimeout(() => setIsLoggedIn(v => (v === null ? false : v)), 3000)
    return () => clearTimeout(t)
  }, [])

  /** Token 失效：清登录态（AI /auth/me 等返回 401 时共用） */
  const sessionExpiredLogout = useCallback(async () => {
    await storage.remove(AUTH_TOKEN_KEY)
    setIsLoggedIn(false)
    setUserProfile(null)
  }, [])

  const fetchUserProfile = useCallback(async (): Promise<void> => {
    if (!isLoggedIn) return
    try {
      const token = await storage.get<string>(AUTH_TOKEN_KEY)
      const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
      if (!token) return
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: {
          "x-tenant-id": tenantId,
          Authorization: `Bearer ${token}`,
        },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          void sessionExpiredLogout()
        }
        return
      }
      const data = await res.json()
      const u = data?.user
      const p = data?.points
      if (u) {
        setUserProfile({
          id: u.id ?? "",
          email: u.email ?? "",
          name: u.name ?? "",
          points: p ? {
            freeBalance: Number(p.freeBalance) || 0,
            freeQuota: Number(p.freeQuota) || 2000,
            topupBalance: Number(p.topupBalance) || 0,
            total: Number(p.total) || 0,
          } : undefined,
        })
      }
    } catch {
      // 静默失败
    }
  }, [isLoggedIn, sessionExpiredLogout])

  useEffect(() => {
    if (!isLoggedIn) {
      setUserProfile(null)
      return
    }
    fetchUserProfile()
  }, [isLoggedIn, fetchUserProfile])

  // 从后端加载存言（依赖 userProfile.id）
  const fetchSavedReplies = useCallback(async () => {
    if (!userProfile?.id) {
      setSavedReplies([])
      return
    }
    try {
      const token = await storage.get<string>(AUTH_TOKEN_KEY)
      const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
      if (!token) return
      const res = await fetch(`${API_BASE}/saved-replies?limit=200`, {
        headers: {
          "x-tenant-id": tenantId,
          Authorization: `Bearer ${token}`,
        },
      })
      const data = await res.json()
      const list = (data?.data ?? []).map((r: { id: string; text: string; fromComment: string; category: string; createdAt: string }) => ({
        id: r.id,
        text: r.text,
        fromComment: r.fromComment ?? "",
        createdAt: r.createdAt,
        category: r.category ?? "默认",
      }))
      setSavedReplies(list)
    } catch {
      setSavedReplies([])
    }
  }, [userProfile?.id])

  useEffect(() => {
    fetchSavedReplies()
  }, [fetchSavedReplies])

  const deleteSavedReply = useCallback(async (id: string) => {
    try {
      const token = await storage.get<string>(AUTH_TOKEN_KEY)
      const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
      if (!token) {
        setPanelToast("请先登录")
        return
      }
      const res = await fetch(`${API_BASE}/saved-replies/${id}`, {
        method: "DELETE",
        headers: {
          "x-tenant-id": tenantId,
          Authorization: `Bearer ${token}`,
        },
      })
      if (res.ok) {
        setSavedReplies(prev => prev.filter(r => r.id !== id))
        setPanelToast("已删除")
      } else {
        setPanelToast("删除失败，请重试")
      }
    } catch {
      setPanelToast("网络错误，请稍后重试")
    }
  }, [])

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const listContainerRef = useRef<HTMLDivElement | null>(null)
  const itemHeightsRef = useRef<Record<string, number>>({})
  const dbInfoRef = useRef<Map<string, Comment>>(new Map())
  // 记录正在请求中的 commentId，防止同一条评论并发重复提交
  const inflightRef = useRef<Set<string>>(new Set())

  const filterRef = useRef(filter)
  filterRef.current = filter

  const scrollCardIntoView = useCallback((commentDomId: string) => {
    requestAnimationFrame(() => {
      const card = cardRefs.current[commentDomId]
      const container = listContainerRef.current
      if (!card || !container) return
      const cardRect = card.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const scrollOffset = cardRect.top - containerRect.top + container.scrollTop
      container.scrollTo({
        top: scrollOffset - (container.clientHeight - card.offsetHeight) / 2,
        behavior: "smooth",
      })
    })
  }, [])

  /** 筛选仅作用于下方列表；统计区始终基于全部评论 */
  const filteredComments = useMemo(() => applyFilter(comments, filter), [comments, filter])

  // 切换筛选时列表回到顶部，避免虚拟列表偏移错乱（滚动联动自动切「全部」时由 skip ref 跳过）
  useEffect(() => {
    if (skipNextFilterScrollResetRef.current) {
      skipNextFilterScrollResetRef.current = false
      return
    }
    listContainerRef.current?.scrollTo({ top: 0 })
    setVisibleRange({ start: 0, end: 20 })
  }, [filter])

  // ─── 虚拟列表偏移计算（useMemo，不在渲染时全量遍历）─────────────────────
  const { topHeight, bottomHeight } = useMemo(() => {
    let top = 0
    let bottom = 0
    for (let i = 0; i < filteredComments.length; i++) {
      const h = itemHeightsRef.current[filteredComments[i].id] ?? ITEM_ESTIMATED_HEIGHT
      if (i < visibleRange.start) top += h
      else if (i >= visibleRange.end) bottom += h
    }
    return { topHeight: top, bottomHeight: bottom }
  }, [filteredComments, visibleRange])

  // ─── 更新可见范围 ────────────────────────────────────────────────────────
  const updateVisibleRange = useCallback(() => {
    const container = listContainerRef.current
    if (!container) return
    const { scrollTop, clientHeight } = container
    let offset = 0
    let start = 0
    let end = filteredComments.length

    for (let i = 0; i < filteredComments.length; i++) {
      const h = itemHeightsRef.current[filteredComments[i].id] ?? ITEM_ESTIMATED_HEIGHT
      if (offset + h < scrollTop) { offset += h; start = i + 1 }
      else break
    }
    offset = 0
    for (let i = 0; i < filteredComments.length; i++) {
      offset += itemHeightsRef.current[filteredComments[i].id] ?? ITEM_ESTIMATED_HEIGHT
      if (offset > scrollTop + clientHeight) { end = i + 1; break }
    }
    setVisibleRange({
      start: Math.max(0, start - BUFFER),
      end: Math.min(filteredComments.length, end + BUFFER),
    })
  }, [filteredComments])

  // 依赖 activeNav：从存言/灵主等切回智言时会新挂载 comment-list，须重新绑定 scroll；
  // 否则监听仍挂在已卸载的 DOM 上，visibleRange/start 滞留，topHeight 撑出大块空白。
  useLayoutEffect(() => {
    if (activeNav !== "zhiyan") return
    updateVisibleRange()
    const container = listContainerRef.current
    if (!container) return
    container.addEventListener("scroll", updateVisibleRange, { passive: true })
    return () => container.removeEventListener("scroll", updateVisibleRange)
  }, [activeNav, filteredComments, updateVisibleRange])

  // 筛选为「高意向/待处理」时页面滚动联动：先切到「全部」后在此 effect 里完成定位
  useEffect(() => {
    const pid = pendingScrollToPlatformIdRef.current
    if (!pid) return

    const filtered = applyFilter(comments, filter)
    const idx = filtered.findIndex(c => c.platformCommentId === pid)
    if (idx === -1) {
      pendingScrollToPlatformIdRef.current = null
      return
    }

    pendingScrollToPlatformIdRef.current = null
    setVisibleRange({
      start: Math.max(0, idx - BUFFER),
      end: Math.min(filtered.length, idx + BUFFER + 1),
    })
    scrollCardIntoView(filtered[idx].id)
  }, [comments, filter, scrollCardIntoView])

  const clearPost = useCallback(() => {
    zhiyanSourceTabIdRef.current = undefined
    setComments([])
    setAiStates({})
    setNoteCommentAi({ loading: false, suggestions: [], copied: null })
    dbInfoRef.current = new Map()
    itemHeightsRef.current = {}
    setVisibleRange({ start: 0, end: 20 })
    setSwitching(true)
  }, [])

  /** 是否为支持评论采集的页面（小红书笔记 / B 站或抖音视频页），非仅「笔记」 */
  const isSupportedCommentPage = useCallback((url?: string) => isCommentCopilotPageUrl(url), [])

  // 侧栏打开时同步当前标签是否笔记页（无 URL_CHANGED 时也能显示「笔记跟评」）
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) return
    void pickActiveCommentCopilotTab().then(tab => {
      setTabCommentPageKind(getCommentCopilotPageKind(tab?.url))
    })
  }, [isLoggedIn])

  // ─── 拉取评论（页面主导 + DB 补充，两路并行）─────────────────────────────
  // 存全部评论；筛选在 UI 层 applyFilter，不触发重复请求。
  const fetchComments = useCallback(async () => {
    setLoading(true)
    try {
      const tab = await pickActiveCommentCopilotTab()
      if (!tab?.id || !isSupportedCommentPage(tab.url)) {
        setTabCommentPageKind(null)
        clearPost()
        setSwitching(false)
        setLoading(false)
        return
      }
      /** 与下方列表同源：避免仅靠 mount/onActivated 时序导致「已有评论但跟评区仍显示未识别」 */
      setTabCommentPageKind(getCommentCopilotPageKind(tab.url))
      zhiyanSourceTabIdRef.current = tab.id

      const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
      const token = await storage.get<string>(AUTH_TOKEN_KEY)

      const [pageResult, dbResult] = await Promise.allSettled([
        // 1. 从 content script 拿页面全量评论（必须带 tabId，避免侧栏焦点导致选错标签）
        runtimeSendMessage<PageComment[]>({ type: "GET_ALL_PAGE_COMMENTS", tabId: tab.id }),
        // 2. 拉 DB 补充信息（status / intentLevel / UUID）
        (async () => {
          const url = tab.url ?? ""
          const params = new URLSearchParams()
          if (
            url.includes("xiaohongshu.com") ||
            url.includes("douyin.com") ||
            url.includes("bilibili.com")
          ) {
            params.set(
              "postUrl",
              url.includes("douyin.com") ? canonicalDouyinPostUrl(url) : url,
            )
          }
          const res = await fetch(`${API_BASE}/comments?${params}`, {
            headers: {
              "x-tenant-id": tenantId,
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          })
          return res.json()
        })(),
      ])

      const pageComments: PageComment[] =
        pageResult.status === "fulfilled" && Array.isArray(pageResult.value) && pageResult.value.length > 0
          ? pageResult.value
          : []

      if (dbResult.status === "fulfilled") {
        const map = new Map<string, Comment>()
        ;((dbResult.value as { data?: Comment[] }).data ?? []).forEach(c => map.set(c.platformCommentId, c))
        dbInfoRef.current = map
      }

      // 只展示当前页 DOM 的评论（用 DB 补充 status/intent）；当前笔记无评论时不要展示其他笔记的评论
      const list =
        pageComments.length > 0 ? mergeWithDb(pageComments, dbInfoRef.current) : []

      setComments(list)
      setVisibleRange({ start: 0, end: 20 })

      /** 抖音：页内已见自己的子回复时同步后端标已回复，避免仅本地状态、刷新后又变待处理 */
      if (tab.url?.includes("douyin.com") && token) {
        for (const pc of pageComments) {
          if (!pc.domSelfReplied) continue
          const db = dbInfoRef.current.get(pc.platformCommentId)
          if (db?.status === "replied" || db?.status === "done") continue
          void runtimeSendMessage<{ ok?: boolean }>({
            type: "MARK_COMMENT_REPLIED",
            payload: { platformCommentId: pc.platformCommentId, platform: "douyin" },
          }).catch(() => {})
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      setSwitching(false)
    }
  }, [isSupportedCommentPage, clearPost])

  useEffect(() => { fetchComments() }, [fetchComments])

  // content script 可能还未就绪，仅首次 mount 时补一次兜底
  // 不放入 [fetchComments] 依赖，避免 filter 变化时重复触发
  useEffect(() => {
    const timer = setTimeout(fetchComments, 1500)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── 消息监听 ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (
      msg: { type: string; payload?: { platformCommentId: string; url?: string } },
      sender: chrome.runtime.MessageSender
    ) => {
      if (msg.type === "URL_CHANGED") {
        whenMessageFromActiveTab(sender, () => {
          const url = msg.payload?.url ?? ""
          setTabCommentPageKind(getCommentCopilotPageKind(url))
          clearPost()
          setTimeout(fetchComments, 2000)
        })
        return
      }
      if (msg.type === "PAGE_LEFT_NOTE") {
        setTabCommentPageKind(null)
        clearPost()
      }

      if (msg.type === "COMMENTS_UPDATED") {
        setSwitching(false)
        fetchComments()
      }

      /** 抖音：折叠/展开子回复后 DOM 可见集合变化；仅处理当前激活标签，避免另一窗口/标签的抖音页误触侧栏 */
      if (msg.type === "PAGE_COMMENTS_DOM_CHANGED") {
        whenMessageFromActiveTab(sender, () => {
          setSwitching(false)
          fetchComments()
        })
        return
      }

      if (msg.type === "SCROLL_TO_COMMENT" && msg.payload?.platformCommentId) {
        whenMessageFromActiveTab(sender, () => {
          const pid = msg.payload!.platformCommentId
          const prev = commentsRef.current
          const fullIdx = prev.findIndex(c => c.platformCommentId === pid)
          if (fullIdx === -1) return

          const f = filterRef.current
          const filtered = applyFilter(prev, f)
          const idxInFiltered = filtered.findIndex(c => c.platformCommentId === pid)

          if (idxInFiltered >= 0) {
            setVisibleRange({
              start: Math.max(0, idxInFiltered - BUFFER),
              end: Math.min(filtered.length, idxInFiltered + BUFFER + 1),
            })
            scrollCardIntoView(filtered[idxInFiltered].id)
            return
          }

          if (f !== "all") {
            pendingScrollToPlatformIdRef.current = pid
            skipNextFilterScrollResetRef.current = true
            setFilter("all")
          }
        })
      }
    }

    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [fetchComments, clearPost, scrollCardIntoView])

  // 切换标签时：非笔记页则清空；是笔记页则主动拉评论（解决同一链接再次进入或切回该标签时不显示评论）
  useEffect(() => {
    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      chrome.tabs.get(info.tabId, (tab) => {
        if (chrome.runtime.lastError) return
        const kind = getCommentCopilotPageKind(tab.url)
        setTabCommentPageKind(kind)
        tabUrlFetchDedupeKeyRef.current = commentCopilotTabFetchDedupeKey(tab.url)
        if (!kind) clearPost()
        else fetchComments()
      })
    }

    chrome.tabs.onActivated.addListener(onActivated)
    return () => chrome.tabs.onActivated.removeListener(onActivated)
  }, [clearPost, fetchComments])

  /**
   * 抖音等 SPA 常用 pushState 更新地址栏（如打开弹层后才带上 modal_id），`URL_CHANGED` 可能晚于或与侧栏时序交错。
   * 监听当前激活标签的 `url` 变化，与地址栏保持一致，避免必须点开评论区才刷新「视频跟评」。
   */
  useEffect(() => {
    if (typeof chrome === "undefined" || !chrome.tabs?.onUpdated) return
    let debounce: ReturnType<typeof setTimeout> | null = null
    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (!changeInfo.url) return
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) return
        if (tabs[0]?.id !== tabId) return
        const url = changeInfo.url
        setTabCommentPageKind(getCommentCopilotPageKind(url))
        const dedupeKey = commentCopilotTabFetchDedupeKey(url)
        if (dedupeKey === tabUrlFetchDedupeKeyRef.current) return
        tabUrlFetchDedupeKeyRef.current = dedupeKey
        if (debounce != null) clearTimeout(debounce)
        debounce = setTimeout(() => {
          debounce = null
          void fetchComments()
        }, 160)
      })
    }
    chrome.tabs.onUpdated.addListener(onUpdated)
    return () => {
      if (debounce != null) clearTimeout(debounce)
      chrome.tabs.onUpdated.removeListener(onUpdated)
    }
  }, [fetchComments])

  // ─── AI 回复 ─────────────────────────────────────────────────────────────
  // 用 inflightRef 按 commentId 维度防重：不同评论互不干扰，同一评论请求中时不重复发
  const generateReply = useCallback(async (comment: Comment) => {
    if (inflightRef.current.has(comment.id)) return
    inflightRef.current.add(comment.id)

    setAiStates(prev => ({ ...prev, [comment.id]: { loading: true, suggestions: [], copied: null } }))
    try {
      const tab = await resolveZhiyanTargetTab(zhiyanSourceTabIdRef.current)
      if (!tab?.id) {
        setAiStates(prev => ({
          ...prev,
          [comment.id]: { loading: false, suggestions: [], copied: null, error: "未找到页面标签" },
        }))
        return
      }
      const post = await runtimeSendMessage<{ postTitle?: string; postContent?: string; postUrl?: string }>({
        type: "GET_POST_CONTENT",
        tabId: tab.id,
      })
      const postTitle = post?.postTitle ?? ""
      const postContent = post?.postContent ?? ""
      const result = await runtimeSendMessage<AiGenResult>({
        type: "GET_AI_REPLY",
        payload: {
          commentId: comment.id,
          commentContent: comment.content,
          postTitle,
          postContent,
        },
      })
      const errorMsg = aiGenerationErrorMessage(result)
      setAiStates(prev => ({
        ...prev,
        [comment.id]: {
          loading: false,
          suggestions: result?.suggestions ?? [],
          copied: null,
          error: errorMsg,
        },
      }))
      if (result?.code === "AUTH_REQUIRED") {
        void sessionExpiredLogout()
      }
      if (result?.ok && result?.suggestions?.length) {
        fetchUserProfile() // 扣费成功，刷新积分展示
      }
    } catch {
      setAiStates(prev => ({
        ...prev,
        [comment.id]: { loading: false, suggestions: [], copied: null, error: "请求失败" },
      }))
    } finally {
      inflightRef.current.delete(comment.id)
    }
  }, [fetchUserProfile, sessionExpiredLogout])

  const generateNoteComment = useCallback(async () => {
    if (noteCommentInflightRef.current) return
    noteCommentInflightRef.current = true
    setNoteCommentAi({ loading: true, suggestions: [], copied: null })
    try {
      /** 跟评必须对应当前正在看的页面，不能用历史 zhiyan 标签（多标签时易串台） */
      const tab = await pickActiveCommentCopilotTab()
      if (!tab?.id) {
        setNoteCommentAi({ loading: false, suggestions: [], copied: null, error: "未找到页面标签" })
        return
      }
      const post = await runtimeSendMessage<{ postTitle?: string; postContent?: string; postUrl?: string }>({
        type: "GET_POST_CONTENT",
        tabId: tab.id,
      })
      const result = await runtimeSendMessage<AiGenResult>({
        type: "GET_AI_NOTE_COMMENT",
        payload: {
          postUrl: post?.postUrl ?? "",
          postTitle: post?.postTitle ?? "",
          postContent: post?.postContent ?? "",
        },
      })
      const errorMsg = aiGenerationErrorMessage(result)
      setNoteCommentAi({
        loading: false,
        suggestions: result?.suggestions ?? [],
        copied: null,
        error: errorMsg,
      })
      if (result?.code === "AUTH_REQUIRED") {
        void sessionExpiredLogout()
      }
      if (result?.ok && result?.suggestions?.length) {
        void fetchUserProfile()
      }
    } catch {
      setNoteCommentAi({ loading: false, suggestions: [], copied: null, error: "请求失败" })
    } finally {
      noteCommentInflightRef.current = false
    }
  }, [fetchUserProfile, sessionExpiredLogout])

  const fillNoteSuggestion = useCallback(async (text: string, index: number) => {
    setNoteCommentAi(prev => ({ ...prev, copied: index }))
    try {
      const tab = await pickActiveCommentCopilotTab()
      if (!tab?.id) {
        await navigator.clipboard.writeText(text)
        setPanelToast("未找到笔记/视频页标签，请先点回页面再试")
        return
      }
      const res = await runtimeSendMessage<{ ok?: boolean; error?: string }>({
        type: "FILL_NOTE_COMMENT",
        tabId: tab.id,
        payload: { text },
      })
      if (!res?.ok) {
        await navigator.clipboard.writeText(text)
        if (!isDouyinTabUrl(tab.url)) {
          const err = res?.error ?? ""
          if (err === "main_composer_not_found") {
            setPanelToast("未找到视频页底部主评论框，请先展开评论区并滚到底部；文案已复制到剪贴板")
          } else {
            const hint = err ? `：${err}` : ""
            setPanelToast(`未能写入主评论框${hint}，已复制到剪贴板`)
          }
        }
        console.warn("[CommentCopilot] fillNoteComment:", res?.error, (res as { step?: string })?.step ?? "")
      }
    } catch {
      await navigator.clipboard.writeText(text)
    }
    setTimeout(() => {
      setNoteCommentAi(prev => ({ ...prev, copied: null }))
    }, 2000)
  }, [])

  const fillReply = useCallback(async (comment: Comment, text: string, index: number) => {
    const clearCopiedSoon = () => {
      setTimeout(() => {
        setAiStates(prev => ({
          ...prev,
          [comment.id]: prev[comment.id] ? { ...prev[comment.id], copied: null } : prev[comment.id],
        }))
      }, 2000)
    }
    setAiStates(prev => ({ ...prev, [comment.id]: { ...prev[comment.id], copied: index } }))
    let tabForMark: chrome.tabs.Tab | undefined
    let fillOk = false
    try {
      const tab = await resolveZhiyanTargetTab(zhiyanSourceTabIdRef.current)
      tabForMark = tab
      if (!tab?.id) {
        await navigator.clipboard.writeText(text)
        setPanelToast("未找到评论所在标签，请先单击视频或笔记页，再点回复")
        clearCopiedSoon()
        return
      }
      const res = await runtimeSendMessage<{ ok?: boolean; error?: string }>({
        type: "FILL_REPLY",
        tabId: tab.id,
        payload: { platformCommentId: comment.platformCommentId, text },
      })
      if (!res?.ok) {
        await navigator.clipboard.writeText(text)
        if (!isDouyinTabUrl(tab.url)) {
          const err = res?.error ?? ""
          const hint = err ? `：${err}` : ""
          setPanelToast(`未能写入页面输入框${hint}，已复制到剪贴板`)
        }
        console.warn("[CommentCopilot] fillReply fallback to clipboard:", res?.error)
      } else {
        fillOk = true
      }
    } catch {
      await navigator.clipboard.writeText(text)
      if (!isDouyinTabUrl(tabForMark?.url)) {
        setPanelToast("回复发送失败，文案已复制到剪贴板")
      }
    }

    clearCopiedSoon()

    // 仅成功写入页面时再标为已回复并同步后端（避免未点开输入框却显示已回复）
    if (!fillOk) return

    const platform = commentCopilotPlatformFromUrl(tabForMark?.url)
    /** 抖音 / 小红书 / B 站：只要成功写入输入框即标「已回复」并同步后端（用户要求：写入即视为已处理） */
    const prevStatus = comment.status
    setComments(prev => prev.map(c => (c.id === comment.id ? { ...c, status: "replied" } : c)))
    try {
      const res = await runtimeSendMessage<{ ok?: boolean }>({
        type: "MARK_COMMENT_REPLIED",
        payload: {
          platformCommentId: comment.platformCommentId,
          platform,
        },
      })
      if (!res?.ok) {
        setComments(prev =>
          prev.map(c => (c.id === comment.id ? { ...c, status: prevStatus } : c))
        )
      }
    } catch {
      setComments(prev =>
        prev.map(c => (c.id === comment.id ? { ...c, status: prevStatus } : c))
      )
    }

  }, [])

  const toggleSaveReply = useCallback(
    async (comment: Comment, text: string) => {
      if (!userProfile?.id) return
      const from = comment.content.slice(0, 80)
      const existing = savedReplies.find(r => r.text === text && r.fromComment === from)

      if (existing) {
        // 取消收藏：调用后端 DELETE
        try {
          const token = await storage.get<string>(AUTH_TOKEN_KEY)
          const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
          if (token) {
            await fetch(`${API_BASE}/saved-replies/${existing.id}`, {
              method: "DELETE",
              headers: {
                "x-tenant-id": tenantId,
                Authorization: `Bearer ${token}`,
              },
            })
          }
        } catch {
          // 静默失败
        }
        setSavedReplies(prev => prev.filter(r => r.id !== existing.id))
      } else {
        // 收藏：调用后端 POST
        try {
          const token = await storage.get<string>(AUTH_TOKEN_KEY)
          const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
          if (!token) return
          const res = await fetch(`${API_BASE}/saved-replies`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-tenant-id": tenantId,
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              text,
              fromCommentId: comment.platformCommentId,
              fromCommentSnippet: from,
              category: "默认",
            }),
          })
          const data = await res.json()
          if (data?.ok && data?.data) {
            const d = data.data
            setSavedReplies(prev => [{
              id: d.id,
              text: d.text,
              fromComment: d.fromComment ?? from,
              createdAt: d.createdAt,
              category: d.category ?? "默认",
            }, ...prev])
          }
        } catch {
          // 静默失败
        }
      }
    },
    [userProfile?.id, savedReplies]
  )

  const toggleSaveNoteReply = useCallback(
    async (text: string) => {
      if (!userProfile?.id) return
      const existing = savedReplies.find(r => r.text === text && r.fromComment === NOTE_COMMENT_SAVE_SNIPPET)

      if (existing) {
        try {
          const token = await storage.get<string>(AUTH_TOKEN_KEY)
          const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
          if (token) {
            await fetch(`${API_BASE}/saved-replies/${existing.id}`, {
              method: "DELETE",
              headers: {
                "x-tenant-id": tenantId,
                Authorization: `Bearer ${token}`,
              },
            })
          }
        } catch {
          /* ignore */
        }
        setSavedReplies(prev => prev.filter(r => r.id !== existing.id))
      } else {
        try {
          const token = await storage.get<string>(AUTH_TOKEN_KEY)
          const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
          if (!token) return
          const res = await fetch(`${API_BASE}/saved-replies`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-tenant-id": tenantId,
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              text,
              fromCommentId: "note-main",
              fromCommentSnippet: NOTE_COMMENT_SAVE_SNIPPET,
              category: "默认",
            }),
          })
          const data = await res.json()
          if (data?.ok && data?.data) {
            const d = data.data
            setSavedReplies(prev => [
              {
                id: d.id,
                text: d.text,
                fromComment: d.fromComment ?? NOTE_COMMENT_SAVE_SNIPPET,
                createdAt: d.createdAt,
                category: d.category ?? "默认",
              },
              ...prev,
            ])
          }
        } catch {
          /* ignore */
        }
      }
    },
    [userProfile?.id, savedReplies]
  )

  const handleLogout = useCallback(async () => {
    await storage.remove(AUTH_TOKEN_KEY)
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await new Promise<void>(res => {
        chrome.storage.local.remove(
          [YANLING_XHS_SELF_NICK_STORAGE_KEY, YANLING_DOUYIN_SELF_NICK_STORAGE_KEY],
          () => res(),
        )
      })
    }
    setNoteCommentAi({ loading: false, suggestions: [], copied: null })
    setIsLoggedIn(false)
    setUserProfile(null)
  }, [])

  const pendingCount = useMemo(() => comments.filter(c => c.status === "pending").length, [comments])
  const hotCount = useMemo(() => comments.filter(c => c.intentLevel === "hot").length, [comments])
  const visible = useMemo(
    () => filteredComments.slice(visibleRange.start, visibleRange.end),
    [filteredComments, visibleRange]
  )

  // ─── 登录态：未登录显示登录页 ────────────────────────────────────────────
  if (isLoggedIn === null) {
    return (
      <div
        className="login-page"
        style={{
          alignItems: "center",
          justifyContent: "center",
          background: "#eeece9",
          minHeight: "100vh",
        }}
      >
        <div className="login-inner">
          <p className="login-subtitle" style={{ color: "#555" }}>加载中…</p>
        </div>
      </div>
    )
  }
  if (!isLoggedIn) {
    return (
      <LoginView
        onSuccess={() => {
          setIsLoggedIn(true)
          setActiveNav("zhiyan")
        }}
      />
    )
  }

  // ─── 渲染（已登录主界面）────────────────────────────────────────────────────
  return (
    <div className="panel">
      {panelToast && (
        <div className="panel-toast" role="status" aria-live="polite">
          {panelToast}
        </div>
      )}
      <div className="main-content">
        {(activeNav === "zhiyan" || activeNav === "cunyan" || activeNav === "account" || activeNav === "settings") ? (
          <header className="main-header">
            <span className="main-header-title">
              {activeNav === "zhiyan" && (
                <>
                  <svg className="main-header-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                  智言
                </>
              )}
              {activeNav === "cunyan" && (
                <>
                  <svg className="main-header-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                  存言
                </>
              )}
              {activeNav === "account" && (
                <>
                  <svg className="main-header-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  灵主
                </>
              )}
              {activeNav === "settings" && (
                <>
                  <svg className="main-header-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
                  </svg>
                  驭灵
                </>
              )}
            </span>
            {activeNav === "zhiyan" && (
              <button className="refresh-btn" onClick={fetchComments} disabled={loading} title="刷新评论">
                {loading ? "…" : "↻"}
              </button>
            )}
          </header>
        ) : null}

        {activeNav === "account" && <AccountPage profile={userProfile} onLogout={handleLogout} />}

        {activeNav === "zhiyan" && (
          <ZhiyanPage
            allComments={comments}
            filteredCount={filteredComments.length}
            loading={loading}
            switching={switching}
            filter={filter}
            visible={visible}
            topHeight={topHeight}
            bottomHeight={bottomHeight}
            listContainerRef={listContainerRef}
            cardRefs={cardRefs}
            itemHeightsRef={itemHeightsRef}
            aiStates={aiStates}
            savedReplies={savedReplies}
            generateReply={generateReply}
            fillReply={fillReply}
            toggleSaveReply={toggleSaveReply}
            hotCount={hotCount}
            pendingCount={pendingCount}
            setFilter={setFilter}
            tabCommentPageKind={tabCommentPageKind}
            noteCommentAi={noteCommentAi}
            generateNoteComment={generateNoteComment}
            fillNoteSuggestion={fillNoteSuggestion}
            toggleSaveNoteReply={toggleSaveNoteReply}
          />
        )}

        {activeNav === "cunyan" && (
          <CunyanPage
            savedReplies={savedReplies}
            category={cunyanCategory}
            setCategory={setCunyanCategory}
            search={cunyanSearch}
            setSearch={setCunyanSearch}
            onDelete={deleteSavedReply}
          />
        )}

        {activeNav === "settings" && <SettingsPage />}
      </div>

      <aside className="main-nav">
        <button
          type="button"
          className={`nav-btn ${activeNav === "account" ? "active" : ""}`}
          onClick={() => setActiveNav("account")}
          title="灵主"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <circle cx="12" cy="9" r="3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path
              d="M6 19.5v-.5a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>灵主</span>
        </button>
        <div className="nav-divider" />
        <button
          type="button"
          className={`nav-btn ${activeNav === "zhiyan" ? "active" : ""}`}
          onClick={() => setActiveNav("zhiyan")}
          title="智言"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>智言</span>
        </button>
        <button
          type="button"
          className={`nav-btn ${activeNav === "cunyan" ? "active" : ""}`}
          onClick={() => setActiveNav("cunyan")}
          title="存言"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5 3h10l4 4v14H5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9.5 11l1.1 2.2 2.4.3-1.8 1.6.5 2.3-2.2-1.1-2.2 1.1.5-2.3-1.8-1.6 2.4-.3L9.5 11z" fill="currentColor"/>
          </svg>
          <span>存言</span>
        </button>

        <button
          type="button"
          className={`nav-btn ${activeNav === "settings" ? "active" : ""}`}
          onClick={() => setActiveNav("settings")}
          title="驭灵"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
          </svg>
          <span>驭灵</span>
        </button>

        {/* 这里原本还有一组旧的“智言/存言/设置”按钮，已删除，避免重复渲染 */}
      </aside>
    </div>
  )
}

export default function SidePanelRoot() {
  return (
    <SidePanelErrorBoundary>
      <SidePanel />
    </SidePanelErrorBoundary>
  )
}
