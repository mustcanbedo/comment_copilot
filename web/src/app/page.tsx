import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-rose-500 mb-2">💬 Comment Copilot</h1>
        <p className="text-gray-500 text-lg">评论区 AI 助手，让每条评论都成为销售机会</p>
      </div>

      <div className="flex gap-4 mt-4">
        <Link
          href="/dashboard"
          className="px-6 py-3 bg-rose-500 text-white rounded-xl font-medium hover:bg-rose-600 transition"
        >
          进入控制台
        </Link>
        <a
          href="/api/health"
          target="_blank"
          className="px-6 py-3 border border-gray-200 rounded-xl font-medium hover:bg-gray-100 transition"
        >
          API 状态
        </a>
      </div>
    </main>
  )
}
