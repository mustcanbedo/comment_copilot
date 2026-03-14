import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Storage } from "@plasmohq/storage"
import { API_BASE, DEFAULT_TENANT_ID } from "../constants"
import "./style.css"

// 虚拟列表：每次只渲染可见区域 ± BUFFER 条评论
const ITEM_ESTIMATED_HEIGHT = 120
const BUFFER = 5

const storage = new Storage()

const intentConfig: Record<string, { emoji: string; label: string }> = {
  hot:  { emoji: "🔥", label: "高意向" },
  warm: { emoji: "✨", label: "中意向" },
  cold: { emoji: "👀", label: "普通" },
  spam: { emoji: "🚫", label: "垃圾" },
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
}

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

type Filter = "all" | "pending" | "hot"

function applyFilter(list: Comment[], filter: Filter): Comment[] {
  if (filter === "hot") return list.filter(c => c.intentLevel === "hot")
  if (filter === "pending") return list.filter(c => c.status === "pending")
  return list
}

function mergeWithDb(pageComments: PageComment[], dbMap: Map<string, Comment>): Comment[] {
  return pageComments.map((pc) => {
    const db = dbMap.get(pc.platformCommentId)
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
}

export default function SidePanel() {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [aiStates, setAiStates] = useState<Record<string, AiState>>({})
  const [filter, setFilter] = useState<Filter>("all")
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 })

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

  // ─── 拉取评论（页面主导 + DB 补充，两路并行）─────────────────────────────
  const fetchComments = useCallback(async () => {
    setLoading(true)
    try {
      const tenantId = (await storage.get<string>("tenantId")) || DEFAULT_TENANT_ID

      // 两路请求并行发出，任一失败不影响另一路
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
            headers: { "x-tenant-id": tenantId },
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

      const list = pageComments.length > 0
        ? applyFilter(mergeWithDb(pageComments, dbInfoRef.current), filter)
        : applyFilter(Array.from(dbInfoRef.current.values()), filter)

      setComments(list)
      setVisibleRange({ start: 0, end: 20 })
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [filter])

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
    const handler = (msg: { type: string; payload?: { platformCommentId: string } }) => {
      if (msg.type === "URL_CHANGED") {
        setComments([])
        setAiStates({})
        dbInfoRef.current = new Map()
        itemHeightsRef.current = {}
        setVisibleRange({ start: 0, end: 20 })
        setSwitching(true)
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
  }, [fetchComments])

  // ─── AI 回复 ─────────────────────────────────────────────────────────────
  // 用 inflightRef 按 commentId 维度防重：不同评论互不干扰，同一评论请求中时不重复发
  const generateReply = useCallback(async (comment: Comment) => {
    if (inflightRef.current.has(comment.id)) return
    inflightRef.current.add(comment.id)

    setAiStates(prev => ({ ...prev, [comment.id]: { loading: true, suggestions: [], copied: null } }))
    try {
      const result = await chrome.runtime.sendMessage({
        type: "GET_AI_REPLY",
        payload: { commentId: comment.id, commentContent: comment.content },
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

  // ─── 渲染 ────────────────────────────────────────────────────────────────
  const pendingCount = useMemo(() => comments.filter(c => c.status === "pending").length, [comments])
  const hotCount = useMemo(() => comments.filter(c => c.intentLevel === "hot").length, [comments])
  const visible = useMemo(
    () => comments.slice(visibleRange.start, visibleRange.end),
    [comments, visibleRange]
  )

  return (
    <div className="panel">
      <header className="panel-header">
        <span className="logo">💬 Comment Copilot</span>
        <button className="refresh-btn" onClick={fetchComments} disabled={loading}>
          {loading ? "…" : "↻"}
        </button>
      </header>

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
            {{ all: "全部", hot: "🔥 高意向", pending: "待处理" }[f]}
          </button>
        ))}
      </div>

      {!loading && comments.length === 0 && (
        <div className="empty">
          {switching ? (
            <><p>正在同步新帖子评论…</p><p className="hint">请稍候</p></>
          ) : (
            <><p>暂无评论</p><p className="hint">打开小红书笔记页面，评论会自动同步</p></>
          )}
        </div>
      )}

      <div className="comment-list" ref={listContainerRef}>
        {topHeight > 0 && <div style={{ height: topHeight, flexShrink: 0 }} />}

        {visible.map(comment => {
          const ai = aiStates[comment.id]
          const intent = intentConfig[comment.intentLevel ?? "cold"]
          return (
            <div
              key={comment.id}
              className="comment-card"
              ref={el => {
                cardRefs.current[comment.id] = el
                if (el && itemHeightsRef.current[comment.id] !== el.offsetHeight) {
                  itemHeightsRef.current[comment.id] = el.offsetHeight
                }
              }}
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
              {ai?.error && (
                <div className="ai-error-row">
                  <span className="ai-error">{ai.error}</span>
                  <button className="retry-btn" onClick={() => generateReply(comment)}>重试</button>
                </div>
              )}
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
    </div>
  )
}
