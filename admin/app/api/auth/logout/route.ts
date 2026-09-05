import { NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';
import { clearAuthCookies, getRefreshToken } from '@/lib/server/session';

export async function POST() {
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    await apiFetch(`/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }
  await clearAuthCookies();
  return NextResponse.json({ ok: true });
}
