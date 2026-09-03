import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_ACCESS, COOKIE_REFRESH, PATH_HEADER } from '@/lib/config';
import { canAccessPath, landingPathForRole } from '@/lib/rbac';
import { UserRole } from '@/lib/types';

/**
 * The role in the access token, read without verifying the signature.
 *
 * Deliberately unverified: this middleware runs on the Edge and holds no
 * signing secret, and it does not need one. A forged cookie buys nothing but
 * the sight of a page — every byte of data on it comes from the API, which
 * verifies the same token properly and refuses on role. The authoritative
 * check is the dashboard layout's, against the role /auth/me reports.
 */
function roleFromToken(token?: string): UserRole | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { role?: UserRole }).role ?? null;
  } catch {
    return null;
  }
}

/**
 * Guard the dashboard.
 *
 * Two jobs. First, no session cookie at all means /login. Second — and this is
 * why it has to live here rather than in the layout — a role may only open the
 * pages its sidebar offers it. Next preserves a shared layout across in-app
 * navigations, so a layout-level check does not re-run on every route change;
 * middleware does, including on the RSC request a client-side navigation makes.
 * Typing /corrections into the address bar and clicking through to it are the
 * same thing from here.
 */
export function middleware(req: NextRequest) {
  const hasSession =
    req.cookies.has(COOKIE_ACCESS) || req.cookies.has(COOKIE_REFRESH);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  const { pathname } = req.nextUrl;
  // Route handlers are not pages: the BFF proxy forwards to the API, which does
  // its own permission check, and gating it here by page rules would break it.
  const isPage = !pathname.startsWith('/api/') && !pathname.startsWith('/_next/');

  if (isPage) {
    const role = roleFromToken(req.cookies.get(COOKIE_ACCESS)?.value);
    // No readable role — an expired access token with a refresh still valid, say.
    // Let it through; the layout refreshes the session and checks properly.
    if (role && !canAccessPath(role, pathname)) {
      const home = landingPathForRole(role);
      const url = req.nextUrl.clone();
      url.search = '';
      if (home) {
        url.pathname = home;
        return NextResponse.redirect(url);
      }
      // A Watchman: the phone is their whole product and this panel holds
      // nothing for them, so there is no page to send them to. End the session
      // rather than bounce them around an empty shell.
      url.pathname = '/login';
      const out = NextResponse.redirect(url);
      out.cookies.delete(COOKIE_ACCESS);
      out.cookies.delete(COOKIE_REFRESH);
      return out;
    }
  }

  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    // Protect everything except login, the auth routes, and public/static assets
    // (logo.png must be reachable on the unauthenticated login page).
    // logo.svg is the vector mark the printed ID cards use. It is not a page,
    // so canAccessPath below denies it as an unknown route and the <img> loads
    // a redirect to the dashboard instead — a logo-shaped hole on every card.
    // /download serves the Android APK and must stay public.
    // /zxing holds the QR-reader WebAssembly: a static asset with no secrets,
    // and a redirect served in its place fails to instantiate.
    // /vendor and login-bg.png dress the unauthenticated login page. A 307 to
    // /login in place of a script parses as HTML and throws "Unexpected token
    // '<'", which is how the glass effect silently never loaded.
    '/((?!login|api/auth|download|zxing|vendor|login-bg.png|_next/static|_next/image|favicon.ico|logo.png|logo.svg).*)',
  ],
};
