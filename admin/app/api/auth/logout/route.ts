import { NextResponse } from 'next/server';
import { API_INTERNAL_BASE_URL } from '@/lib/config';
import { clearAuthCookies, getRefreshToken } from '@/lib/server/session';

export async function POST() {
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    await fetch(`${API_INTERNAL_BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }
  await clearAuthCookies();
  return NextResponse.json({ ok: true });
}
