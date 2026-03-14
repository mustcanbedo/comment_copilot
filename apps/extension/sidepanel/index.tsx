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

  async function fetchComments() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filter === "hot") params.set("intent", "hot")
      if (filter === "pending") params.set("status", "pending")

      const res = await fetch(`${API_BASE}/comments?${params}`, {
        headers: { "x-tenant-id": TENANT_ID },
      })
      const data = await res.json()
      setComments(data.data || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchComments() }, [filter])

  // 监听来自 content script 的消息
  useEffect(() => {
    const handler = (msg: { type: string; payload?: { platformCommentId: string } }) => {
      if (msg.type === "URL_CHANGED") {
        // 切换帖子：立刻清空，等新评论进来
        setComments([])
        setAiStates({})
        setSwitching(true)
      }
      if (msg.type === "COMMENTS_UPDATED") {
        setSwitching(false)
        fetchComments()
      }
      if (msg.type === "SCROLL_TO_COMMENT" && msg.payload?.platformCommentId) {
        const pid = msg.payload.platformCommentId
        setComments(prev => {
          const match = prev.find(c => c.platformCommentId === pid)
          if (match) {
            cardRefs.current[match.id]?.scrollIntoView({ behavior: "smooth", block: "center" })
          }
          return prev
        })
      }
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

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
