import { NextRequest, NextResponse } from 'next/server'

const BASE = process.env.GO_API_BASE_URL || 'http://localhost:3001'

export async function proxyToGo(
  req: NextRequest,
  path: string,
  methodOverride?: string
) {
  const url = new URL(req.url)
  const target = `${BASE}${path}${url.search}`

  const headers = new Headers(req.headers)
  headers.delete('host')
  headers.delete('connection')
  headers.delete('content-length')

  const method = methodOverride ?? req.method
  const init: RequestInit = { method, headers, redirect: 'manual' }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    init.body = await req.text()
  }

  const resp = await fetch(target, init)
  const body = await resp.arrayBuffer()
  const out = new NextResponse(body, { status: resp.status })

  resp.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'content-encoding') return
    out.headers.set(k, v)
  })
  return out
}

