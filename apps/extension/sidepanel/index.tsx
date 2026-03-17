import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Storage } from "@plasmohq/storage"
import { API_BASE, DEFAULT_TENANT_ID } from "../constants"
import LoginView, { AUTH_TOKEN_KEY } from "./login-view"
import "./style.css"

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

function applyFilter(list: Comment[], filter: Filter): Comment[] {
  if (filter === "hot") return list.filter(c => c.intentLevel === "hot")
  if (filter === "pending") return list.filter(c => c.status === "pending")
  return list
}

function mergeWithDb(pageComments: PageComment[], dbMap: Map<string, Comment>): Comment[] {
  return pageComments.map((pc) => {
    const db = dbMap.get(pc.platformCommentId)
    return {
      // 统一用 platformCommentId 作为前端列表 ID，避免后端重复数据导致 React key 冲突
      id: pc.platformCommentId,
      platformCommentId: pc.platformCommentId,
      authorName: pc.authorName,
      content: pc.content,
      commentedAt: pc.commentedAt,
      postUrl: pc.postUrl,
      status: db?.status ?? "pending",
      intentLevel: db?.intentLevel ?? null,
      ...(pc.emojiUrls?.length ? { emojiUrls: pc.emojiUrls } : {}),
      ...(pc.attachmentImageUrls?.length ? { attachmentImageUrls: pc.attachmentImageUrls } : {}),
    }
  })
}

// ─── 页面组件：智言（评论列表 + AI 回复） ───────────────────────────────────
function ZhiyanPage(props: {
  comments: Comment[]
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
}) {
  const {
    comments,
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
  } = props

  return (
    <>
      <div className="stats-row">
        <div className="stat-item">
          <span className="stat-num">{comments.length}</span>
          <span className="stat-label">全部</span>
        </div>
        <div className="stat-item hot">
          <span className="stat-num">{hotCount}</span>
          <span className="stat-label">🔥 高意向</span>
        </div>
        <div className="stat-item">
          <span className="stat-num">{pendingCount}</span>
          <span className="stat-label">待处理</span>
        </div>
      </div>

      <div className="filter-row">
        {(["all", "hot", "pending"] as const).map(f => (
          <button
            key={f}
            className={`filter-btn ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {{ all: "全部", hot: "🔥 高意向", pending: "🕐 待处理" }[f]}
          </button>
        ))}
      </div>

      {!loading && comments.length === 0 ? (
        <div className="empty">
          {switching ? (
            <>
              <p>正在同步新帖子评论…</p>
              <p className="hint">请稍候</p>
            </>
          ) : (
            <>
              <p>暂无评论</p>
              <p className="hint">打开小红书笔记页面，评论会自动同步</p>
            </>
          )}
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
}) {
  const { savedReplies, category, setCategory, search, setSearch } = props
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
              <div className="cunyan-text">{item.text}</div>
              <div className="cunyan-meta">
                <span className="cunyan-category">{item.category || "未分类"}</span>
                <span className="cunyan-time">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="cunyan-source">来自评论：{item.fromComment}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 页面组件：我的账户 ─────────────────────────────────────────────────────
function AccountPage({ profile, onLogout }: { profile: UserProfile | null; onLogout: () => void }) {
  const displayName = profile?.name || profile?.email || "未命名用户"
  const avatarChar = (displayName || "?").slice(0, 1).toUpperCase()

  return (
    <div className="settings-root">
      <div className="settings-account">
        <h2 className="settings-title">我的账户</h2>
        <div className="settings-card">
          <div className="settings-avatar">{avatarChar}</div>
          <div className="settings-info">
            <div className="settings-name">{displayName}</div>
            <div className="settings-sub">
              已绑定邮箱：{profile?.email || "—"}
            </div>
          </div>
        </div>
        <p className="settings-hint">更多账号信息与统计即将上线</p>
      </div>
      <button type="button" className="settings-logout-btn" onClick={onLogout}>
        退出登录
      </button>
    </div>
  )
}

// ─── 页面组件：设置 ─────────────────────────────────────────────────────────
function SettingsPage() {
  return (
    <div className="settings-root">
      <div className="settings-account">
        <h2 className="settings-title">设置</h2>
        <div className="settings-card">
          <div className="settings-info">
            <div className="settings-name">通用设置</div>
            <div className="settings-sub">更多偏好与计划配置即将上线</div>
          </div>
        </div>
      </div>
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

  useEffect(() => {
    storage.get<string>(AUTH_TOKEN_KEY).then(token => setIsLoggedIn(!!token)).catch(() => setIsLoggedIn(false))
    const t = setTimeout(() => setIsLoggedIn(v => (v === null ? false : v)), 3000)
    return () => clearTimeout(t)
  }, [])

  // 登录后拉取一次账户信息，用于“我的账户”页面展示
  useEffect(() => {
    if (!isLoggedIn) {
      setUserProfile(null)
      return
    }
    ;(async () => {
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
          if (res.status === 401) {
            // token 失效，回到登录页
            await storage.remove(AUTH_TOKEN_KEY)
            setIsLoggedIn(false)
          }
          return
        }
        const data = await res.json()
        const u = data?.user
        if (u) {
          setUserProfile({
            id: u.id ?? "",
            email: u.email ?? "",
            name: u.name ?? "",
          })
        }
      } catch {
        // 静默失败，不影响主功能
      }
    })()
  }, [isLoggedIn])

  // 初始化加载当前用户的已收藏存言（依赖 userProfile.id）
  useEffect(() => {
    if (!userProfile?.id) {
      setSavedReplies([])
      return
    }
    ;(async () => {
      try {
        const key = getSavedRepliesKey(userProfile.id)
        const list = (await storage.get<SavedReply[]>(key)) || []
        setSavedReplies(list)
      } catch {
        setSavedReplies([])
      }
    })()
  }, [userProfile?.id])

  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const listContainerRef = useRef<HTMLDivElement | null>(null)
  const itemHeightsRef = useRef<Record<string, number>>({})
  const dbInfoRef = useRef<Map<string, Comment>>(new Map())
  // 记录正在请求中的 commentId，防止同一条评论并发重复提交
  const inflightRef = useRef<Set<string>>(new Set())

  // ─── 虚拟列表偏移计算（useMemo，不在渲染时全量遍历）─────────────────────
  const { topHeight, bottomHeight } = useMemo(() => {
    let top = 0
    let bottom = 0
    for (let i = 0; i < comments.length; i++) {
      const h = itemHeightsRef.current[comments[i].id] ?? ITEM_ESTIMATED_HEIGHT
      if (i < visibleRange.start) top += h
      else if (i >= visibleRange.end) bottom += h
    }
    return { topHeight: top, bottomHeight: bottom }
  }, [comments, visibleRange])

  // ─── 更新可见范围 ────────────────────────────────────────────────────────
  const updateVisibleRange = useCallback(() => {
    const container = listContainerRef.current
    if (!container) return
    const { scrollTop, clientHeight } = container
    let offset = 0
    let start = 0
    let end = comments.length

    for (let i = 0; i < comments.length; i++) {
      const h = itemHeightsRef.current[comments[i].id] ?? ITEM_ESTIMATED_HEIGHT
      if (offset + h < scrollTop) { offset += h; start = i + 1 }
      else break
    }
    offset = 0
    for (let i = 0; i < comments.length; i++) {
      offset += itemHeightsRef.current[comments[i].id] ?? ITEM_ESTIMATED_HEIGHT
      if (offset > scrollTop + clientHeight) { end = i + 1; break }
    }
    setVisibleRange({
      start: Math.max(0, start - BUFFER),
      end: Math.min(comments.length, end + BUFFER),
    })
  }, [comments])

  useEffect(() => {
    updateVisibleRange()
    const container = listContainerRef.current
    if (!container) return
    container.addEventListener("scroll", updateVisibleRange, { passive: true })
    return () => container.removeEventListener("scroll", updateVisibleRange)
  }, [comments, updateVisibleRange])

  const clearPost = useCallback(() => {
    setComments([])
    setAiStates({})
    dbInfoRef.current = new Map()
    itemHeightsRef.current = {}
    setVisibleRange({ start: 0, end: 20 })
    setSwitching(true)
  }, [])

  const isNotePage = useCallback((url?: string) => {
    return Boolean(url?.includes("xiaohongshu.com") && /\/explore\/[a-zA-Z0-9]+/.test(url))
  }, [])

  // ─── 拉取评论（页面主导 + DB 补充，两路并行）─────────────────────────────
  // 依赖说明：fetchComments 依赖 filter，因拉取后要 applyFilter(filter)；下方 effect 依赖 [fetchComments]，
  // 故切换「全部/高意向/待处理」时会重新拉取并筛一次。若后续拆 effect，勿误加/误删依赖，避免多余请求或 filter 不同步。
  const fetchComments = useCallback(async () => {
    setLoading(true)
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!isNotePage(tab?.url)) {
        clearPost()
        setSwitching(false)
        setLoading(false)
        return
      }

      const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID
      const token = await storage.get<string>(AUTH_TOKEN_KEY)

      const [pageResult, dbResult] = await Promise.allSettled([
        // 1. 从 content script 拿页面全量评论（顺序与小红书一致）
        chrome.runtime.sendMessage({ type: "GET_ALL_PAGE_COMMENTS" }),
        // 2. 拉 DB 补充信息（status / intentLevel / UUID）
        (async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          const url = tab?.url ?? ""
          const params = new URLSearchParams()
          if (url.includes("xiaohongshu.com") || url.includes("douyin.com")) {
            params.set("postUrl", url)
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
        pageComments.length > 0
          ? applyFilter(mergeWithDb(pageComments, dbInfoRef.current), filter)
          : []

      setComments(list)
      setVisibleRange({ start: 0, end: 20 })
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
      setSwitching(false)
    }
  }, [filter, isNotePage, clearPost])

  useEffect(() => { fetchComments() }, [fetchComments]) // 依赖 fetchComments：filter 变化时其引用会变，从而触发重新拉取与 applyFilter

  // content script 可能还未就绪，仅首次 mount 时补一次兜底
  // 不放入 [fetchComments] 依赖，避免 filter 变化时重复触发
  useEffect(() => {
    const timer = setTimeout(fetchComments, 1500)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── 消息监听 ────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (msg: { type: string; payload?: { platformCommentId: string } }) => {
      if (msg.type === "URL_CHANGED" || msg.type === "PAGE_LEFT_NOTE") {
        clearPost()
        // 同一链接再次进入时 content 会发 URL_CHANGED 并重扫；延迟拉取确保能拿到 GET_ALL_PAGE_COMMENTS
        if (msg.type === "URL_CHANGED") setTimeout(fetchComments, 2000)
      }

      if (msg.type === "COMMENTS_UPDATED") {
        setSwitching(false)
        fetchComments()
      }

      if (msg.type === "SCROLL_TO_COMMENT" && msg.payload?.platformCommentId) {
        const pid = msg.payload.platformCommentId
        setComments(prev => {
          const idx = prev.findIndex(c => c.platformCommentId === pid)
          if (idx === -1) return prev

          setVisibleRange({
            start: Math.max(0, idx - BUFFER),
            end: Math.min(prev.length, idx + BUFFER + 1),
          })

          const id = prev[idx].id
          requestAnimationFrame(() => {
            const card = cardRefs.current[id]
            const container = listContainerRef.current
            if (card && container) {
              const cardRect = card.getBoundingClientRect()
              const containerRect = container.getBoundingClientRect()
              const scrollOffset = cardRect.top - containerRect.top + container.scrollTop
              container.scrollTo({
                top: scrollOffset - (container.clientHeight - card.offsetHeight) / 2,
                behavior: "smooth",
              })
            }
          })
          return prev
        })
      }
    }

    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [fetchComments, clearPost])

  // 切换标签时：非笔记页则清空；是笔记页则主动拉评论（解决同一链接再次进入或切回该标签时不显示评论）
  useEffect(() => {
    const isNotePage = (url?: string) => url?.includes("xiaohongshu.com") && /\/explore\/[a-zA-Z0-9]+/.test(url ?? "")

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      chrome.tabs.get(info.tabId, (tab) => {
        if (chrome.runtime.lastError) return
        if (!isNotePage(tab.url)) clearPost()
        else fetchComments()
      })
    }

    chrome.tabs.onActivated.addListener(onActivated)
    return () => chrome.tabs.onActivated.removeListener(onActivated)
  }, [clearPost, fetchComments])

  // ─── AI 回复 ─────────────────────────────────────────────────────────────
  // 用 inflightRef 按 commentId 维度防重：不同评论互不干扰，同一评论请求中时不重复发
  const generateReply = useCallback(async (comment: Comment) => {
    if (inflightRef.current.has(comment.id)) return
    inflightRef.current.add(comment.id)

    setAiStates(prev => ({ ...prev, [comment.id]: { loading: true, suggestions: [], copied: null } }))
    try {
      const post = await new Promise<{ postTitle: string; postContent: string }>((resolve) => {
        chrome.runtime.sendMessage({ type: "GET_POST_CONTENT" }, (res: { postTitle?: string; postContent?: string }) => {
          resolve({ postTitle: res?.postTitle ?? "", postContent: res?.postContent ?? "" })
        })
      })
      const result = await chrome.runtime.sendMessage({
        type: "GET_AI_REPLY",
        payload: {
          commentId: comment.id,
          commentContent: comment.content,
          postTitle: post.postTitle,
          postContent: post.postContent,
        },
      })
      const errorMsg = result?.ok === false ? (result.error || "生成失败") : undefined
      setAiStates(prev => ({
        ...prev,
        [comment.id]: {
          loading: false,
          suggestions: result?.suggestions ?? [],
          copied: null,
          error: errorMsg,
        },
      }))
    } catch {
      setAiStates(prev => ({
        ...prev,
        [comment.id]: { loading: false, suggestions: [], copied: null, error: "请求失败" },
      }))
    } finally {
      inflightRef.current.delete(comment.id)
    }
  }, [])

  const fillReply = useCallback(async (comment: Comment, text: string, index: number) => {
    setAiStates(prev => ({ ...prev, [comment.id]: { ...prev[comment.id], copied: index } }))
    try {
      const res = await chrome.runtime.sendMessage({
        type: "FILL_REPLY",
        payload: { platformCommentId: comment.platformCommentId, text },
      })
      if (!res?.ok) {
        await navigator.clipboard.writeText(text)
        console.warn("[CommentCopilot] fillReply fallback to clipboard:", res?.error)
      }
    } catch {
      await navigator.clipboard.writeText(text)
    }
    setTimeout(() => {
      setAiStates(prev => ({ ...prev, [comment.id]: { ...prev[comment.id], copied: null } }))
    }, 2000)
  }, [])

  const toggleSaveReply = useCallback(
    async (comment: Comment, text: string) => {
      if (!userProfile?.id) return
      setSavedReplies(prev => {
        const from = comment.content.slice(0, 80)
        const existing = prev.find(r => r.text === text && r.fromComment === from)
        let next: SavedReply[]
        if (existing) {
          next = prev.filter(r => r.id !== existing.id)
        } else {
          const now = new Date().toISOString()
          const item: SavedReply = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            text,
            fromComment: from,
            createdAt: now,
            category: "默认",
          }
          next = [item, ...prev]
        }
        // 异步持久化，不阻塞 UI
        const key = getSavedRepliesKey(userProfile.id)
        storage.set(key, next).catch(() => {})
        return next
      })
    },
    [userProfile?.id]
  )

  const handleLogout = useCallback(async () => {
    await storage.remove(AUTH_TOKEN_KEY)
    setIsLoggedIn(false)
    setUserProfile(null)
  }, [])

  const pendingCount = useMemo(() => comments.filter(c => c.status === "pending").length, [comments])
  const hotCount = useMemo(() => comments.filter(c => c.intentLevel === "hot").length, [comments])
  const visible = useMemo(
    () => comments.slice(visibleRange.start, visibleRange.end),
    [comments, visibleRange]
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
      <div className="main-content">
        {activeNav === "zhiyan" || activeNav === "cunyan" ? (
          <header className="main-header">
            <span className="main-header-title">
              {activeNav === "zhiyan"
                ? "✦ 智言"
                : activeNav === "cunyan"
                ? "✧ 存言"
                : null}
            </span>
            {activeNav === "zhiyan" && (
              <button className="refresh-btn" onClick={fetchComments} disabled={loading} title="刷新评论">
                {loading ? "…" : "↻"}
              </button>
            )}
          </header>
        ) : null}

        {activeNav === "account" && (
          <AccountPage profile={userProfile} onLogout={handleLogout} />
        )}

        {activeNav === "zhiyan" && (
          <ZhiyanPage
            comments={comments}
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
          />
        )}

        {activeNav === "cunyan" && (
          <CunyanPage
            savedReplies={savedReplies}
            category={cunyanCategory}
            setCategory={setCunyanCategory}
            search={cunyanSearch}
            setSearch={setCunyanSearch}
          />
        )}

        {activeNav === "settings" && <SettingsPage />}
      </div>

      <aside className="main-nav">
        <button
          type="button"
          className="nav-avatar"
          onClick={() => setActiveNav("account")}
          title="我的账户"
        >
          我
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
          title="设置"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M19.4 9a1.5 1.5 0 0 0 .3-1.6l-1-1.7a1.5 1.5 0 0 0-1.5-.7L15 5.4a5.3 5.3 0 0 0-2.1-1.2L12.5 2.5a1.5 1.5 0 0 0-1.5-1.2h-2a1.5 1.5 0 0 0-1.5 1.1L7 4.2a5.3 5.3 0 0 0-2.1 1.2L3 5.7a1.5 1.5 0 0 0-1.5.7l-1 1.7A1.5 1.5 0 0 0 .8 9l1.2 1a5.4 5.4 0 0 0 0 2l-1.2 1a1.5 1.5 0 0 0-.3 1.6l1 1.7a1.5 1.5 0 0 0 1.5.7l1.9-.3a5.3 5.3 0 0 0 2.1 1.2l.5 1.7a1.5 1.5 0 0 0 1.5 1.1h2a1.5 1.5 0 0 0 1.5-1.1l.5-1.7a5.3 5.3 0 0 0 2.1-1.2l1.9.3a1.5 1.5 0 0 0 1.5-.7l1-1.7a1.5 1.5 0 0 0-.3-1.6l-1.2-1a5.4 5.4 0 0 0 0-2l1.2-1z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>设置</span>
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
