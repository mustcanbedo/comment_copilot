import { useEffect, useRef, useState } from "react"
import "./style.css"

interface Comment {
  id: string
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
  status: string
  intentLevel: string | null
  postUrl: string | null
}

// content script 直接返回的页面评论（不经过数据库）
interface PageComment {
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
  postUrl: string
}

interface AiState {
  loading: boolean
  suggestions: string[]
  copied: number | null
  error?: string
}

const API_BASE = process.env.PLASMO_PUBLIC_API_URL || "http://localhost:3000/api"
const TENANT_ID = "00000000-0000-0000-0000-000000000001"

const intentConfig: Record<string, { emoji: string; label: string }> = {
  hot:  { emoji: "🔥", label: "高意向" },
  warm: { emoji: "✨", label: "中意向" },
  cold: { emoji: "👀", label: "普通" },
  spam: { emoji: "🚫", label: "垃圾" },
}

export default function SidePanel() {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [aiStates, setAiStates] = useState<Record<string, AiState>>({})
  const [filter, setFilter] = useState<"all" | "pending" | "hot">("all")
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // 数据库里的补充信息（status、intentLevel、id），按 platformCommentId 索引
  const dbInfoRef = useRef<Map<string, Comment>>(new Map())

  async function fetchComments() {
    setLoading(true)
    try {
      // 1. 先从 content script 拿当前页全量评论（顺序和小红书一致）
      let pageComments: PageComment[] = []
      try {
        const result = await chrome.runtime.sendMessage({ type: "GET_ALL_PAGE_COMMENTS" })
        if (Array.isArray(result) && result.length > 0) {
          pageComments = result as PageComment[]
        }
      } catch {
        // content 未注入（非小红书页）时忽略
      }

      // 2. 同时拉数据库里的状态/intentLevel 等补充信息（不限条数）
      try {
        let postUrl: string | undefined
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        const url = tab?.url ?? ""
        if (url && (url.includes("xiaohongshu.com") || url.includes("douyin.com"))) {
          postUrl = url
        }
        const params = new URLSearchParams({ limit: "1000" })
        if (postUrl) params.set("postUrl", postUrl)
        const res = await fetch(`${API_BASE}/comments?${params}`, {
          headers: { "x-tenant-id": TENANT_ID },
        })
        const data = await res.json()
        const dbList: Comment[] = data.data || []
        const map = new Map<string, Comment>()
        dbList.forEach((c) => map.set(c.platformCommentId, c))
        dbInfoRef.current = map
      } catch {
        // 数据库拉取失败时继续用页面数据
      }

      if (pageComments.length > 0) {
        // 3. 用页面评论作为主列表（顺序、数量与小红书完全一致），补充数据库里的 id/status/intentLevel
        const merged: Comment[] = pageComments.map((pc) => {
          const db = dbInfoRef.current.get(pc.platformCommentId)
          return {
            id: db?.id ?? pc.platformCommentId,             // 数据库 UUID，没入库时用 platformCommentId 代替
            platformCommentId: pc.platformCommentId,
            authorName: pc.authorName,
            content: pc.content,
            commentedAt: pc.commentedAt,
            postUrl: pc.postUrl,
            status: db?.status ?? "pending",
            intentLevel: db?.intentLevel ?? null,
          }
        })

        // 筛选
        const filtered = merged.filter((c) => {
          if (filter === "hot") return c.intentLevel === "hot"
          if (filter === "pending") return c.status === "pending"
          return true
        })
        setComments(filtered)
      } else {
        // 4. 没有页面数据时（非小红书页或未加载），直接用数据库列表兜底
        const fallback = Array.from(dbInfoRef.current.values()).filter((c) => {
          if (filter === "hot") return c.intentLevel === "hot"
          if (filter === "pending") return c.status === "pending"
          return true
        })
        setComments(fallback)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchComments() }, [filter])

  // 静默刷新：从 content 拿最新页面评论，合并数据库信息后更新列表，不显示 loading
  async function silentRefresh() {
    try {
      const result = await chrome.runtime.sendMessage({ type: "GET_ALL_PAGE_COMMENTS" })
      if (!Array.isArray(result) || result.length === 0) return
      const pageComments = result as PageComment[]
      const merged: Comment[] = pageComments.map((pc) => {
        const db = dbInfoRef.current.get(pc.platformCommentId)
        return {
          id: db?.id ?? pc.platformCommentId,
          platformCommentId: pc.platformCommentId,
          authorName: pc.authorName,
          content: pc.content,
          commentedAt: pc.commentedAt,
          postUrl: pc.postUrl,
          status: db?.status ?? "pending",
          intentLevel: db?.intentLevel ?? null,
        }
      })
      setComments(prev => {
        // 只在条数或内容确实有变化时才更新，避免无谓 re-render
        if (merged.length === prev.length &&
            merged.every((c, i) => c.platformCommentId === prev[i]?.platformCommentId)) {
          return prev
        }
        return merged.filter((c) => {
          if (filter === "hot") return c.intentLevel === "hot"
          if (filter === "pending") return c.status === "pending"
          return true
        })
      })
    } catch {
      // content 未注入时忽略
    }
  }

  // 监听来自 content script 的消息
  useEffect(() => {
    const handler = (msg: { type: string; payload?: { platformCommentId: string } }) => {
      if (msg.type === "URL_CHANGED") {
        // 切换帖子：立刻清空，等新评论进来
        setComments([])
        setAiStates({})
        dbInfoRef.current = new Map()
        setSwitching(true)
      }
      if (msg.type === "COMMENTS_UPDATED") {
        // 有新评论入库：更新 dbInfoRef 后静默刷新列表
        setSwitching(false)
        const pid = (msg as { type: string; payload?: { platformCommentId?: string } }).payload?.platformCommentId
        void pid // 暂不使用，静默全量刷新即可
        silentRefresh()
      }
      if (msg.type === "SCROLL_TO_COMMENT" && msg.payload?.platformCommentId) {
        const pid = msg.payload.platformCommentId
        // 先静默同步最新评论（滚动加载可能有新增），再定位
        silentRefresh().then(() => {
          setComments(prev => {
            const match = prev.find(c => c.platformCommentId === pid)
            if (match) {
              const id = match.id
              requestAnimationFrame(() => {
                cardRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" })
              })
            }
            return prev
          })
        })
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [filter])

  async function generateReply(comment: Comment) {
    setAiStates(prev => ({
      ...prev,
      [comment.id]: { loading: true, suggestions: [], copied: null },
    }))

    try {
      const result = await chrome.runtime.sendMessage({
        type: "GET_AI_REPLY",
        payload: { commentId: comment.id, commentContent: comment.content },
      })
      setAiStates(prev => ({
        ...prev,
        [comment.id]: {
          loading: false,
          suggestions: result?.suggestions || [],
          copied: null,
          error: result?.ok === false ? (result.error || "生成失败") : undefined,
        },
      }))
    } catch {
      setAiStates(prev => ({
        ...prev,
        [comment.id]: { loading: false, suggestions: [], copied: null, error: "请求失败" },
      }))
    }
  }

  async function fillReply(comment: Comment, text: string, index: number) {
    setAiStates(prev => ({
      ...prev,
      [comment.id]: { ...prev[comment.id], copied: index },
    }))

    try {
      const res = await chrome.runtime.sendMessage({
        type: "FILL_REPLY",
        payload: { platformCommentId: comment.platformCommentId, text },
      })

      if (!res?.ok) {
        // 填入失败时降级为复制到剪贴板
        await navigator.clipboard.writeText(text)
        console.warn("[CommentCopilot] fillReply fallback to clipboard:", res?.error)
      }
    } catch {
      await navigator.clipboard.writeText(text)
    }

    setTimeout(() => {
      setAiStates(prev => ({
        ...prev,
        [comment.id]: { ...prev[comment.id], copied: null },
      }))
    }, 2000)
  }

  const pendingCount = comments.filter(c => c.status === "pending").length
  const hotCount = comments.filter(c => c.intentLevel === "hot").length

  return (
    <div className="panel">
      <header className="panel-header">
        <span className="logo">💬 Comment Copilot</span>
        <button className="refresh-btn" onClick={fetchComments} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </header>

      {/* 统计 */}
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

      {/* 筛选 */}
      <div className="filter-row">
        {(["all", "hot", "pending"] as const).map(f => (
          <button
            key={f}
            className={`filter-btn ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {{ all: "全部", hot: "🔥 高意向", pending: "待处理" }[f]}
          </button>
        ))}
      </div>

      {/* 评论列表 */}
      {!loading && comments.length === 0 && (
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
      )}

      <div className="comment-list">
        {comments.map(comment => {
          const ai = aiStates[comment.id]
          const intent = intentConfig[comment.intentLevel ?? "cold"]

          return (
            <div
              key={comment.id}
              className="comment-card"
              ref={el => { cardRefs.current[comment.id] = el }}
            >
              <div className="comment-meta">
                <span className="author">{comment.authorName}</span>
                <span className="intent-badge">{intent.emoji} {intent.label}</span>
              </div>
              <p className="comment-content">{comment.content}</p>

              {!ai && (
                <button className="reply-btn" onClick={() => generateReply(comment)}>
                  ✨ 生成 AI 回复
                </button>
              )}

              {ai?.loading && <div className="ai-loading">AI 思考中…</div>}
              {ai?.error && <div className="ai-error">{ai.error}</div>}

              {ai && !ai.loading && ai.suggestions.length > 0 && (
                <div className="suggestions">
                  {ai.suggestions.map((s, i) => (
                    <div key={i} className="suggestion-item">
                      <p className="suggestion-text">{s}</p>
                      <button
                        className={`copy-btn ${ai.copied === i ? "copied" : ""}`}
                        onClick={() => fillReply(comment, s, i)}
                      >
                        {ai.copied === i ? "✅ 已填入" : "回复"}
                      </button>
                    </div>
                  ))}
                  <button
                    className="regenerate-btn"
                    onClick={() => generateReply(comment)}
                  >
                    重新生成
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
