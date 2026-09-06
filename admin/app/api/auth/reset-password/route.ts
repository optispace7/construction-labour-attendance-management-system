import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';

/**
 * Finish a password reset, using the token from the emailed link.
 *
 * The token arrives as a query parameter on /login and is posted back here.
 * Better Auth verifies it, sets the password and invalidates the token, so a
 * link cannot be used twice.
 */
export async function POST(req: NextRequest) {
  const { token, newPassword } = (await req.json()) as {
    token?: string;
    newPassword?: string;
  };
  if (!token || !newPassword) {
    return NextResponse.json({ title: 'The reset link is incomplete' }, { status: 400 });
  }

  const res = await apiFetch(
    '/reset-password',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
      cache: 'no-store',
    },
    { betterAuth: true },
  );

  const raw = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // A failure from the platform rather than the API is not JSON, and parsing
    // it blind turns a readable error into an empty object.
    body = { title: 'Could not reset the password', detail: raw.slice(0, 200) };
  }
  return NextResponse.json(body, { status: res.ok ? 200 : res.status });
}
