import { auth } from '@/auth'
import { db, tenants } from '@/db'
import { eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ ok: false }, { status: 401 })

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1)
  return NextResponse.json({ ok: true, persona: tenant?.persona || '', name: tenant?.name || '' })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session) return NextResponse.json({ ok: false }, { status: 401 })

  const { keywords, autoGenerate } = await req.json()

  let persona = keywords as string

  // 用 AI 根据关键词生成完整人设
  if (autoGenerate && keywords) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          max_tokens: 300,
          messages: [
            {
              role: 'system',
              content: '你是一个品牌文案专家，帮助用户生成小红书账号的回复人设描述。要求：简洁、有个性、适合评论互动场景，100字以内。',
            },
            {
              role: 'user',
              content: `根据以下关键词，生成一段账号人设描述：${keywords}`,
            },
          ],
        }),
      })
      const data = await res.json()
      persona = data.choices?.[0]?.message?.content?.trim() || keywords
    } catch {
      persona = keywords
    }
  }

  await db.update(tenants).set({ persona, updatedAt: new Date() }).where(eq(tenants.id, session.user.tenantId))
  return NextResponse.json({ ok: true, persona })
}
