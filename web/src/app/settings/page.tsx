'use client'

import { useEffect, useState } from 'react'
import { useSession, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [keywords, setKeywords] = useState('')
  const [persona, setPersona] = useState('')
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  useEffect(() => {
    if (status === 'authenticated') {
      fetch('/api/settings/persona').then(r => r.json()).then(d => {
        if (d.ok) setPersona(d.persona || '')
      })
    }
  }, [status])

  async function handleGenerate() {
    if (!keywords.trim()) return
    setGenerating(true)
    const res = await fetch('/api/settings/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords, autoGenerate: true }),
    })
    const data = await res.json()
    setGenerating(false)
    if (data.ok) setPersona(data.persona)
  }

  async function handleSave() {
    setLoading(true)
    await fetch('/api/settings/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: persona, autoGenerate: false }),
    })
    setLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (status === 'loading') return null

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航 */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-gray-500 hover:text-gray-700 text-sm">← 返回</Link>
          <h1 className="font-semibold text-gray-900">⚙️ 账号设置</h1>
        </div>
        <button onClick={() => signOut({ callbackUrl: '/login' })} className="text-sm text-gray-500 hover:text-red-500">
          退出登录
        </button>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
        {/* 账号信息 */}
        <div className="bg-white rounded-2xl p-6 shadow-sm">
          <h2 className="font-semibold text-gray-900 mb-4">账号信息</h2>
          <div className="space-y-2 text-sm text-gray-600">
            <p>邮箱：<span className="text-gray-900">{session?.user.email}</span></p>
            <p>昵称：<span className="text-gray-900">{session?.user.name || '未设置'}</span></p>
          </div>
        </div>

        {/* 人设配置 */}
        <div className="bg-white rounded-2xl p-6 shadow-sm">
          <h2 className="font-semibold text-gray-900 mb-1">AI 回复人设</h2>
          <p className="text-sm text-gray-500 mb-4">设置你的账号风格，AI 会按照这个人设生成回复建议</p>

          {/* 关键词输入 */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              关键词（用逗号分隔）
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={keywords}
                onChange={e => setKeywords(e.target.value)}
                placeholder="例如：科技博主、幽默、专业、亲切"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
              />
              <button
                onClick={handleGenerate}
                disabled={generating || !keywords.trim()}
                className="px-4 py-2 bg-rose-500 hover:bg-rose-600 text-white text-sm font-medium rounded-lg transition disabled:opacity-50 whitespace-nowrap"
              >
                {generating ? 'AI 生成中…' : '✨ AI 生成'}
              </button>
            </div>
          </div>

          {/* 人设预览/编辑 */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              人设描述（可直接编辑）
            </label>
            <textarea
              value={persona}
              onChange={e => setPersona(e.target.value)}
              rows={4}
              placeholder="描述你的账号风格，例如：我是一个专注科技产品评测的博主，回复风格专业但不失亲切，喜欢用数据说话，偶尔加入幽默元素…"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-400 resize-none"
            />
          </div>

          <button
            onClick={handleSave}
            disabled={loading}
            className="w-full py-2.5 bg-gray-900 hover:bg-gray-700 text-white font-medium rounded-lg text-sm transition disabled:opacity-50"
          >
            {saved ? '✅ 已保存' : loading ? '保存中…' : '保存人设'}
          </button>
        </div>
      </div>
    </div>
  )
}
