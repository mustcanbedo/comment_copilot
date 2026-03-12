import { db, users, tenants } from '@/db'
import { eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'

export async function POST(req: NextRequest) {
  const { email, password, name } = await req.json()

  if (!email || !password) {
    return NextResponse.json({ ok: false, error: '邮箱和密码不能为空' }, { status: 400 })
  }
  if (password.length < 8) {
    return NextResponse.json({ ok: false, error: '密码至少 8 位' }, { status: 400 })
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing.length > 0) {
    return NextResponse.json({ ok: false, error: '该邮箱已注册' }, { status: 409 })
  }

  // 创建 tenant
  const [tenant] = await db.insert(tenants).values({
    name: name || email.split('@')[0],
    apiKey: crypto.randomUUID(),
  }).returning()

  // 创建用户
  const passwordHash = await bcrypt.hash(password, 10)
  const [user] = await db.insert(users).values({
    tenantId: tenant.id,
    email,
    passwordHash,
    fullName: name || '',
    role: 'owner',
  }).returning()

  return NextResponse.json({ ok: true, userId: user.id, tenantId: tenant.id })
}
