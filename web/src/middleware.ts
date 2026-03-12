import { auth } from '@/auth'
import { NextResponse } from 'next/server'

export default auth((req) => {
  const isLoggedIn = !!req.auth
  const isAuthPage = req.nextUrl.pathname.startsWith('/login') || req.nextUrl.pathname.startsWith('/register')
  const isApiRoute = req.nextUrl.pathname.startsWith('/api')

  if (isApiRoute) return NextResponse.next()
  if (isAuthPage) return NextResponse.next()
  if (!isLoggedIn) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
})

export const config = {
  matcher: ['/dashboard/:path*', '/settings/:path*'],
}
