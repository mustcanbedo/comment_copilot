import { db, comments } from '@/db'
import { asc, eq, and, ne } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET(req: NextRequest) {
  const tenantId = req.headers.get('x-tenant-id')
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: 'missing x-tenant-id' }, { status: 400, headers: CORS_HEADERS })
  }

  const { searchParams } = new URL(req.url)
  const intentLevel = searchParams.get('intent')
  const status = searchParams.get('status')
  const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 200)

  const rows = await db
    .select()
    .from(comments)
    .where(
      and(
        eq(comments.tenantId, tenantId),
        ne(comments.isAuthorReply, true),
      )
    )
    .orderBy(asc(comments.createdAt))
    .limit(limit)

  const filtered = rows.filter(r => {
    if (intentLevel && r.intentLevel !== intentLevel) return false
    if (status && r.status !== status) return false
    return true
  })

  return NextResponse.json({ ok: true, data: filtered, total: filtered.length }, { headers: CORS_HEADERS })
}
