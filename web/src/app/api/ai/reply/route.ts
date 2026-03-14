import { db, aiReplies, aiCallLogs, comments, tenants } from '@/db'
import { eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

interface ReplyBody {
  commentId: string
  commentContent: string
  persona?: string
}

export async function POST(req: NextRequest) {
  const tenantId = req.headers.get('x-tenant-id')
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: 'missing x-tenant-id' }, { status: 400 })
  }

  const body: ReplyBody = await req.json()
  const { commentId, commentContent, persona: bodyPersona } = body

  if (!commentId || !commentContent) {
    return NextResponse.json({ ok: false, error: 'invalid payload' }, { status: 400 })
  }

  const [tenant] = await db
    .select({ persona: tenants.persona, defaultModel: tenants.defaultModel })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)

  const persona = bodyPersona ?? tenant?.persona ?? '热情友好的品牌客服'
  const model = tenant?.defaultModel ?? 'deepseek-chat'

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'AI service not configured' }, { status: 500 })
  }

  const systemPrompt = `你是一个${persona}，负责回复小红书/抖音等平台的用户评论。
要求：
1. 回复简短自然，15-40字为宜
2. 语气亲切，符合中文社交媒体风格
3. 不要使用"您"，用"你"更自然
4. 不要在回复中提及微信号、手机号等敏感信息
5. 输出 JSON 格式：{"suggestions": ["回复1", "回复2", "回复3"]}`

  const userPrompt = `用户评论：${commentContent}\n\n请生成3条候选回复。`

  const startMs = Date.now()
  let status: 'success' | 'error' | 'timeout' = 'success'

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 300,
        temperature: 0.8,
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      status = 'error'
      const err = await response.text()
      console.error('[ai/reply] DeepSeek error:', err)
      return NextResponse.json({ ok: false, error: 'AI service error' }, { status: 502 })
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[]
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    const parsed = JSON.parse(data.choices[0].message.content) as { suggestions: string[] }
    const latencyMs = Date.now() - startMs

    const costUsd = (
      (data.usage.prompt_tokens * 0.00000027) +
      (data.usage.completion_tokens * 0.0000011)
    ).toFixed(6)

    await db.insert(aiReplies).values({
      tenantId,
      commentId,
      suggestions: parsed.suggestions,
      modelUsed: model,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      costUsd,
    })

    await db
      .update(comments)
      .set({ status: 'replied' })
      .where(eq(comments.id, commentId))

    await db.insert(aiCallLogs).values({
      tenantId,
      model,
      taskType: 'reply',
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
      latencyMs,
      costUsd,
      status,
    })

    return NextResponse.json({ ok: true, suggestions: parsed.suggestions }, { headers: CORS_HEADERS })
  } catch (err) {
    status = 'error'
    console.error('[ai/reply] error:', err)

    await db.insert(aiCallLogs).values({
      tenantId,
      model,
      taskType: 'reply',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startMs,
      costUsd: '0',
      status,
    }).catch(() => {})

    return NextResponse.json({ ok: false, error: 'internal error' }, { status: 500 })
  }
}
