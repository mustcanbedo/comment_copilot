import { NextRequest } from 'next/server'
import { proxyToGo } from '@/lib/backend-proxy'

export async function POST(req: NextRequest) {
  return proxyToGo(req, '/api/ai/reply')
}

export async function OPTIONS(req: NextRequest) {
  return proxyToGo(req, '/api/ai/reply')
}
