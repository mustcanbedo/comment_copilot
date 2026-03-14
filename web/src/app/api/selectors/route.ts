import { NextRequest } from 'next/server'
import { proxyToGo } from '@/lib/backend-proxy'

export async function GET(req: NextRequest) {
  return proxyToGo(req, '/api/selectors')
}
