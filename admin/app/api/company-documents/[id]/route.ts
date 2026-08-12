import { NextRequest, NextResponse } from 'next/server';
import { API_INTERNAL_BASE_URL } from '@/lib/config';
import { backendAuthHeaders } from '@/lib/server/api';

/**
 * Streams a company document (PDF) from the backend using the httpOnly access
 * cookie — same reason as /api/photo: the JSON-only proxy can't carry binary.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const res = await fetch(`${API_INTERNAL_BASE_URL}/company-documents/${params.id}/file`, {
    headers: backendAuthHeaders(),
    cache: 'no-store',
  });
  if (!res.ok || !res.body) return new NextResponse(null, { status: res.status });
  return new NextResponse(res.body, {
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/pdf',
      // Carries the original file name through to the browser's download.
      'content-disposition': res.headers.get('content-disposition') ?? 'inline',
      'cache-control': 'private, no-store',
    },
  });
}
