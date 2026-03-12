'use client'

import { useEffect, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'


interface Comment {
  id: string
  platform: string
  authorName: string
  content: string
  intentLevel: string | null
  status: string
  commentedAt: string
  postUrl: string | null
}

interface AiState {
  loading: boolean
  suggestions: string[]
  copied: number | null
  error?: string
}

const intentConfig: Record<string, { label: string; color: string }> = {
  hot:  { label: '🔥 高意向', color: 'bg-red-100 text-red-700' },
  warm: { label: '✨ 中意向', color: 'bg-yellow-100 text-yellow-700' },
  cold: { label: '👀 普通',   color: 'bg-gray-100 text-gray-600' },
  spam: { label: '🚫 垃圾',   color: 'bg-gray-100 text-gray-400' },
}

const statusConfig: Record<string, string> = {
  pending: '待处理',
  replied: '已回复',
  ignored: '已忽略',
}

export default function DashboardPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'hot' | 'warm' | 'pending'>('all')
  const [aiStates, setAiStates] = useState<Record<string, AiState>>({})

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  const tenantId = session?.user?.tenantId

  async function fetchComments() {
    if (!tenantId) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filter === 'hot') params.set('intent', 'hot')
      if (filter === 'warm') params.set('intent', 'warm')
      if (filter === 'pending') params.set('status', 'pending')

      const res = await fetch(`/api/comments?${params}`, {
        headers: { 'x-tenant-id': tenantId },
      })
      const data = await res.json()
      setComments(data.data ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchComments() }, [filter, tenantId])

  async function generateReply(comment: Comment) {
    if (!tenantId) return
    setAiStates(prev => ({
      ...prev,
      [comment.id]: { loading: true, suggestions: [], copied: null },
    }))

    try {
      const res = await fetch('/api/ai/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify({
          commentId: comment.id,
          commentContent: comment.content,
        }),
      })
      const data = await res.json()
      setAiStates(prev => ({
        ...prev,
        [comment.id]: {
          loading: false,
          suggestions: data.suggestions ?? [],
          copied: null,
          error: data.ok ? undefined : data.error,
        },
      }))
    } catch {
      setAiStates(prev => ({
        ...prev,
        [comment.id]: { loading: false, suggestions: [], copied: null, error: '请求失败' },
      }))
    }
  }

  async function copyText(commentId: string, text: string, index: number) {
    await navigator.clipboard.writeText(text)
    setAiStates(prev => ({
      ...prev,
      [commentId]: { ...prev[commentId], copied: index },
    }))
    setTimeout(() => {
      setAiStates(prev => ({
        ...prev,
        [commentId]: { ...prev[commentId], copied: null },
      }))
    }, 2000)
  }

  const stats = {
    total: comments.length,
    hot: comments.filter(c => c.intentLevel === 'hot').length,
    pending: comments.filter(c => c.status === 'pending').length,
    replied: comments.filter(c => c.status === 'replied').length,
  }

  if (status === 'loading') return null

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-rose-500">💬 Comment Copilot</span>
          <span className="text-sm text-gray-400">控制台</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{session?.user?.email}</span>
          <Link
            href="/settings"
            className="text-sm px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 transition"
          >
            ⚙️ 设置
          </Link>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="text-sm px-3 py-1.5 border border-gray-200 rounded-lg hover:bg-red-50 hover:text-red-500 hover:border-red-200 transition"
          >
            退出
          </button>
          <button
            onClick={fetchComments}
            className="text-sm px-4 py-1.5 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition"
          >
            刷新
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: '全部评论', value: stats.total, color: 'text-gray-700' },
            { label: '🔥 高意向', value: stats.hot, color: 'text-red-600' },
            { label: '待处理', value: stats.pending, color: 'text-yellow-600' },
            { label: '已回复', value: stats.replied, color: 'text-green-600' },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-sm text-gray-500 mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Filter */}
        <div className="flex gap-2 mb-4">
          {(['all', 'hot', 'warm', 'pending'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
                filter === f
                  ? 'bg-rose-500 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {{ all: '全部', hot: '🔥 高意向', warm: '✨ 中意向', pending: '待处理' }[f]}
            </button>
          ))}
        </div>

        {/* Comment List */}
        {loading ? (
          <div className="text-center py-16 text-gray-400">加载中…</div>
        ) : comments.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg">暂无评论</p>
            <p className="text-sm mt-2">安装 Chrome 插件并打开小红书笔记页面，评论会自动同步</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {comments.map(comment => {
              const ai = aiStates[comment.id]
              const intent = intentConfig[comment.intentLevel ?? 'cold']

              return (
                <div key={comment.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-700">{comment.authorName}</span>
                      <span className="text-xs text-gray-400">{comment.platform}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${intent.color}`}>
                        {intent.label}
                      </span>
                      <span className="text-xs text-gray-400">
                        {statusConfig[comment.status] ?? comment.status}
                      </span>
                    </div>
                  </div>

                  <p className="text-sm text-gray-800 leading-relaxed mb-3">{comment.content}</p>

                  {!ai && (
                    <button
                      onClick={() => generateReply(comment)}
                      className="w-full py-2 bg-gradient-to-r from-rose-500 to-pink-500 text-white text-sm rounded-lg font-medium hover:opacity-90 transition"
                    >
                      ✨ 生成 AI 回复
                    </button>
                  )}

                  {ai?.loading && (
                    <div className="text-center text-sm text-gray-400 py-2">AI 思考中…</div>
                  )}

                  {ai?.error && (
                    <div className="text-center text-sm text-red-400 py-2">{ai.error}</div>
                  )}

                  {ai && !ai.loading && ai.suggestions.length > 0 && (
                    <div className="flex flex-col gap-2 mt-1">
                      {ai.suggestions.map((s, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-2 bg-gray-50 border border-gray-100 rounded-lg p-3"
                        >
                          <p className="flex-1 text-sm text-gray-700 leading-relaxed">{s}</p>
                          <button
                            onClick={() => copyText(comment.id, s, i)}
                            className={`shrink-0 text-xs px-3 py-1 rounded-md border transition ${
                              ai.copied === i
                                ? 'bg-green-50 border-green-200 text-green-600'
                                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-100'
                            }`}
                          >
                            {ai.copied === i ? '✅ 已复制' : '复制'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
