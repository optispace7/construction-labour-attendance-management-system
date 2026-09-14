import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';
import { backendAuthHeaders } from '@/lib/server/api';

/**
 * Fetches a worker-documents zip from the backend using the httpOnly access
 * cookie — same reason as /api/photo: the JSON-only proxy can't carry binary.
 *
 * Read whole and sent on with its size, not piped through. Next re-wraps a
 * passed-through stream, drops the length and has cut long downloads short
 * with an HTTP 200 — the APK did exactly that — which here would save a zip
 * that will not open. Buffering is affordable: the backend caps each zip, and
 * the panel asks for large selections in groups.
 *
 * `x-zip-bytes` repeats the size in a header Next leaves alone, so the browser
 * can tell a complete download from a truncated one.
 */
export async function POST(req: NextRequest) {
  const res = await apiFetch(`/workers/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await backendAuthHeaders()),
    },
    body: await req.text(),
    cache: 'no-store',
  });

  if (!res.ok) {
    // The refusal says what to do about it — "too large, select fewer" — so
    // its body goes on to the page rather than being dropped here.
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  }

  const zip = await res.arrayBuffer();
  if (zip.byteLength === 0) return new NextResponse(null, { status: 502 });
  return new NextResponse(zip, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(zip.byteLength),
      'x-zip-bytes': String(zip.byteLength),
      'cache-control': 'no-store',
    },
  });
}
