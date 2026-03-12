import { db, selectorConfigs } from '@/db'
import { eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'

// 默认 selector（兜底，当 DB 无记录时使用）
const DEFAULT_SELECTORS: Record<string, object> = {
  xiaohongshu: {
    commentList: "[class*='comment-item'], .note-comment-card, .comment-item",
    authorName: "[class*='user-name'], [class*='nickname'], .author-name",
    content: "[class*='comment-content'], .content",
    timestamp: "time, [class*='time'], [class*='date']",
    commentId: "[data-comment-id], [data-id]",
  },
  douyin: {
    commentList: ".comment-item, [class*='CommentItem'], [data-e2e='comment-item']",
    authorName: "[class*='user-name'], [data-e2e='comment-user-name']",
    content: "[class*='content'], [data-e2e='comment-content']",
    timestamp: "time, [class*='time']",
    commentId: "[data-comment-id]",
  },
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const platform = searchParams.get('platform')

  if (!platform) {
    return NextResponse.json({ ok: false, error: 'missing platform' }, { status: 400 })
  }

  const [config] = await db
    .select()
    .from(selectorConfigs)
    .where(eq(selectorConfigs.platform, platform))
    .limit(1)

  const selectors = config?.selectors ?? DEFAULT_SELECTORS[platform] ?? null

  if (!selectors) {
    return NextResponse.json({ ok: false, error: 'platform not supported' }, { status: 404 })
  }

  return NextResponse.json({
    ok: true,
    platform,
    version: config?.version ?? 'default',
    selectors,
  }, {
    headers: {
      'Cache-Control': 'public, max-age=3600', // 插件缓存 1 小时
    },
  })
}
