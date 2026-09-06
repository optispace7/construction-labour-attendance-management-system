import { cookies } from 'next/headers';

/**
 * Every function here is async because `cookies()` became async in Next 15.
 * Nothing about the cookie handling itself changed — the awaits are the whole
 * migration, and they are load-bearing: a forgotten one yields a Promise where
 * a token is expected, which reads as "not logged in" rather than as an error.
 */
import {
  ACCESS_MAX_AGE,
  COOKIE_ACCESS,
  COOKIE_DEVICE_ID,
  COOKIE_DEVICE_TOKEN,
  COOKIE_DEVICE_UID,
  COOKIE_REFRESH,
  DEVICE_MAX_AGE,
  REFRESH_MAX_AGE,
} from '../config';

const secure = process.env.NODE_ENV === 'production';

export async function setAuthCookies(accessToken: string, refreshToken: string) {
  const jar = await cookies();
  jar.set(COOKIE_ACCESS, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_MAX_AGE,
  });
  jar.set(COOKIE_REFRESH, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_MAX_AGE,
  });
}

/**
 * Store a Better Auth session token as the credential the panel sends.
 *
 * It goes in the same cookie the access token used, because everything that
 * talks to the API reads that one cookie and sends it as a bearer token — and
 * the API now accepts either format. Swapping what goes in leaves the rest of
 * the panel untouched.
 *
 * The lifetime is the session's own, not ACCESS_MAX_AGE. That fifteen minutes
 * belonged to a short-lived JWT that a refresh token silently renewed; a Better
 * Auth session lasts a week and renews itself, so a fifteen-minute cookie would
 * log people out every quarter of an hour while their session was still valid.
 *
 * No refresh cookie is written: there is nothing to refresh with, and leaving a
 * stale one would send the panel down a refresh path that cannot work.
 */
export async function setBetterAuthSession(token: string, maxAgeSeconds: number) {
  const jar = await cookies();
  jar.set(COOKIE_ACCESS, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
  jar.delete(COOKIE_REFRESH);
}

export async function clearAuthCookies() {
  const jar = await cookies();
  jar.delete(COOKIE_ACCESS);
  jar.delete(COOKIE_REFRESH);
}

export async function getAccessToken(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_ACCESS)?.value;
}

export async function getRefreshToken(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_REFRESH)?.value;
}

// ---- Browser device identity (device-approval flow) ----

const deviceCookieOpts = {
  httpOnly: true,
  secure,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: DEVICE_MAX_AGE,
};

/** Stable per-browser UID; created on first login and kept across sessions. */
export async function getOrCreateDeviceUid(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE_DEVICE_UID)?.value;
  if (existing) return existing;
  const uid = `web-${crypto.randomUUID()}`;
  jar.set(COOKIE_DEVICE_UID, uid, deviceCookieOpts);
  return uid;
}

export async function getDeviceUid(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_DEVICE_UID)?.value;
}

export async function setDeviceCredentials(deviceId: string, deviceToken: string) {
  const jar = await cookies();
  jar.set(COOKIE_DEVICE_ID, deviceId, deviceCookieOpts);
  jar.set(COOKIE_DEVICE_TOKEN, deviceToken, deviceCookieOpts);
}

export async function getDeviceCredentials(): Promise<{ deviceId?: string; deviceToken?: string }> {
  const jar = await cookies();
  return {
    deviceId: jar.get(COOKIE_DEVICE_ID)?.value,
    deviceToken: jar.get(COOKIE_DEVICE_TOKEN)?.value,
  };
}
