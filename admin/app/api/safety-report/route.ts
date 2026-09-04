import { NextRequest, NextResponse } from 'next/server';
import { API_INTERNAL_BASE_URL } from '@/lib/config';
import { backendAuthHeaders } from '@/lib/server/api';

/**
 * Streams the safety statistics PDF from the backend using the httpOnly access
 * cookie — same reason as /api/photo: the JSON-only proxy can't carry binary.
 *
 * The board used to fetch this through /api/proxy, which parses every backend
 * reply as JSON; the PDF bytes threw on the parse and the export came back 500
 * even when the report had rendered perfectly.
 */
export async function GET(req: NextRequest) {
  const res = await fetch(`${API_INTERNAL_BASE_URL}/safety/stats/pdf${req.nextUrl.search}`, {
    headers: await backendAuthHeaders(),
    cache: 'no-store',
  });
  if (!res.ok || !res.body) return new NextResponse(null, { status: res.status });
  return new NextResponse(res.body, {
    headers: {
      'content-type': 'application/pdf',
      // Carries the backend's safety-<period>-<date>.pdf name to the browser.
      'content-disposition': res.headers.get('content-disposition') ?? 'attachment',
      'cache-control': 'private, no-store',
    },
  });
}
