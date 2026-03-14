import { NextRequest } from 'next/server'
import { proxyToGo } from '@/lib/backend-proxy'

export async function GET(req: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) {
  const { nextauth } = await context.params
  const tail = (nextauth || []).join('/')
  return proxyToGo(req, `/api/auth/${tail}`)
}

export async function POST(req: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) {
  const { nextauth } = await context.params
  const tail = (nextauth || []).join('/')
  return proxyToGo(req, `/api/auth/${tail}`)
}
