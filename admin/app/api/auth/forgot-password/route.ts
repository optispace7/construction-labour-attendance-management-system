import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';

/**
 * Start a password reset.
 *
 * Better Auth emails a link rather than a code, so this replaces the OTP flow
 * that used to live on the API. It is a route here rather than a call from the
 * browser because the panel never addresses the API directly, and because the
 * reset link's target has to come from the server: it is on Better Auth's
 * trusted-origins list, and letting the client choose it would defeat the
 * point of having one.
 *
 * Only an address works. Site staff sign in with a user ID and have no mailbox
 * — their address is a synthesised .invalid one — so there is nothing to send
 * to and they are told to ask an administrator, which is what the old flow
 * told them too.
 */
export async function POST(req: NextRequest) {
  const { identifier } = (await req.json()) as { identifier?: string };
  const id = identifier?.trim();
  if (!id) {
    return NextResponse.json({ title: 'Enter your email address' }, { status: 400 });
  }
  if (!id.includes('@')) {
    return NextResponse.json(
      {
        emailSent: false,
        message:
          'This account signs in with a user ID and has no email address. ' +
          'Ask your administrator to set a new password for you.',
      },
      { status: 200 },
    );
  }

  const origin = new URL(req.url).origin;
  const res = await apiFetch(
    '/request-password-reset',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: id, redirectTo: `${origin}/login` }),
      cache: 'no-store',
    },
    { betterAuth: true },
  );

  // Better Auth answers the same way whether or not the address is known, so
  // this cannot be used to find out who has an account. Passing its reply
  // through unchanged keeps that true.
  const raw = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { title: 'Could not start the reset', detail: raw.slice(0, 200) };
  }
  if (!res.ok) return NextResponse.json(body, { status: res.status });

  return NextResponse.json({
    emailSent: true,
    message: 'If that address has an account, a reset link is on its way.',
  });
}
