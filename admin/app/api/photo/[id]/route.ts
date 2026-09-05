import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';
import { backendAuthHeaders } from '@/lib/server/api';

/**
 * Streams worker/staff photos (binary) from the backend using the httpOnly
 * access cookie — the JSON-only /api/proxy route can't carry image bodies.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await apiFetch(`/files/${id}`, {
    headers: await backendAuthHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) return new NextResponse(null, { status: res.status });
  const buf = await res.arrayBuffer();
  return new NextResponse(buf, {
    headers: {
      'content-type': res.headers.get('content-type') ?? 'image/jpeg',
      'cache-control': 'private, max-age=86400',
    },
  });
}
