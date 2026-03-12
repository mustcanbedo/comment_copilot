import { db, comments } from '@/db'
import { and, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'

interface CommentItem {
  platformCommentId: string
  authorName: string
  content: string
  commentedAt: string
  postUrl?: string
  isAuthorReply?: boolean
}

interface IngestBody {
  platform: string
  comments: CommentItem[]
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: NextRequest) {
  const tenantId = req.headers.get('x-tenant-id')
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: 'missing x-tenant-id' }, { status: 400, headers: CORS_HEADERS })
  }

  const body: IngestBody = await req.json()
  const { platform, comments: items } = body

  if (!platform || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ ok: false, error: 'invalid payload' }, { status: 400, headers: CORS_HEADERS })
  }

  let saved = 0
  let skipped = 0

  for (const item of items) {
    const existing = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          eq(comments.tenantId, tenantId),
          eq(comments.platform, platform),
          eq(comments.platformCommentId, item.platformCommentId),
        )
      )
      .limit(1)

    if (existing.length > 0) {
      skipped++
      continue
    }

    await db.insert(comments).values({
      tenantId,
      platform,
      platformCommentId: item.platformCommentId,
      authorName: item.authorName,
      content: item.content,
      postUrl: item.postUrl ?? '',
      commentedAt: new Date(item.commentedAt),
      isAuthorReply: item.isAuthorReply ?? false,
      status: item.isAuthorReply ? 'author' : 'pending',
    })
    saved++
  }

  return NextResponse.json({ ok: true, saved, skipped }, { headers: CORS_HEADERS })
}
