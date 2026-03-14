'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface UserInfo {
  id: string
  email: string
  name: string
  tenantId: string
}

export default function SettingsPage() {
  const router = useRouter()
  const [me, setMe] = useState<UserInfo | null>(null)
  const [keywords, setKeywords] = useState('')
  const [persona, setPersona] = useState('')
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(data => {
      if (!data.ok) {
        router.push('/login')
        return
      }
      setMe(data.user)
      return fetch('/api/settings/persona').then(r => r.json())
    }).then(d => {
      if (d?.ok) setPersona(d.persona || '')
    })
  }, [router])

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

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-gray-500 hover:text-gray-700 text-sm">返回</Link>
          <h1 className="font-semibold text-gray-900">账号设置</h1>
        </div>
        <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">退出登录</button>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
        <div className="bg-white rounded-2xl p-6 shadow-sm">
          <h2 className="font-semibold text-gray-900 mb-4">账号信息</h2>
          <div className="space-y-2 text-sm text-gray-600">
            <p>邮箱：<span className="text-gray-900">{me?.email}</span></p>
            <p>名称：<span className="text-gray-900">{me?.name || '未设置'}</span></p>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm">
          <h2 className="font-semibold text-gray-900 mb-1">AI 回复人设</h2>
          <p className="text-sm text-gray-500 mb-4">设置你的账号风格，AI 会按照这个风格生成回复建议</p>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">关键词（逗号分隔）</label>
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
                {generating ? '生成中...' : 'AI 生成'}
              </button>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">人设描述（可编辑）</label>
            <textarea
              value={persona}
              onChange={e => setPersona(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-400 resize-none"
            />
          </div>

          <button
            onClick={handleSave}
            disabled={loading}
            className="w-full py-2.5 bg-gray-900 hover:bg-gray-700 text-white font-medium rounded-lg text-sm transition disabled:opacity-50"
          >
            {saved ? '已保存' : loading ? '保存中...' : '保存人设'}
          </button>
        </div>
      </div>
    </div>
  )
}
