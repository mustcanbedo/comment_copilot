'use client'

import { useState } from 'react'

interface RegisterProps {
  /** 注册成功后的回调 */
  onSuccess?: () => void
  /** 跳转到登录页 */
  onGoLogin?: () => void
  /** 后端注册接口地址，默认指向 Go backend */
  apiBase?: string
}

export default function Register({ onSuccess, onGoLogin, apiBase = '' }: RegisterProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${apiBase}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || '注册失败')
      } else {
        onSuccess?.()
      }
    } catch {
      setError('网络错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">💬 Comment Copilot</h1>
          <p className="text-gray-500 text-sm mt-1">创建你的账号</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">昵称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
              placeholder="你的名字"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
              placeholder="至少 8 位"
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-rose-500 hover:bg-rose-600 text-white font-medium rounded-lg text-sm transition disabled:opacity-50"
          >
            {loading ? '注册中…' : '创建账号'}
          </button>
        </form>

        {onGoLogin && (
          <p className="text-center text-sm text-gray-500 mt-6">
            已有账号？{' '}
            <button
              onClick={onGoLogin}
              className="text-rose-500 hover:underline bg-transparent border-none cursor-pointer"
            >
              直接登录
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
