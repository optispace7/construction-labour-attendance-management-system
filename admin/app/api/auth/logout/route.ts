import { NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';
import { clearAuthCookies, getAccessToken } from '@/lib/server/session';

export async function POST() {
  const token = await getAccessToken();
  if (token) {
    // Revoke the session server-side, not just locally. Clearing the cookie
    // only stops this browser sending it; the session row would go on being
    // valid for anyone who had captured the token, for the rest of the week.
    await apiFetch(
      '/sign-out',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{}',
        cache: 'no-store',
      },
      { betterAuth: true },
    ).catch(() => undefined);
  }
  // Always clear, even if the call above failed: a logout that leaves the
  // browser signed in because the network blipped is the wrong way to fail.
  await clearAuthCookies();
  return NextResponse.json({ ok: true });
}
