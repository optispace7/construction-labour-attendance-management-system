import { apiFetch } from './api-fetch';
import {
  getAccessToken,
  getDeviceCredentials,
  getRefreshToken,
  setAuthCookies,
} from './session';

interface ApiOptions {
  method?: string;
  body?: unknown;
  // when false, don't attempt token refresh (used by the refresh call itself)
  allowRefresh?: boolean;
}

/**
 * Server-side fetch to the backend using the access cookie. On 401 it attempts
 * a single refresh (rotating the cookies) and retries. Throws ApiError on
 * non-2xx so server components / route handlers can map it.
 */
export async function serverApi<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await rawCall(path, opts, await getAccessToken());

  if (res.status === 401 && opts.allowRefresh !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const retry = await rawCall(path, opts, refreshed);
      return handle<T>(retry);
    }
  }
  return handle<T>(res);
}

/**
 * Auth + approved-browser credentials for a backend call. The device headers
 * are not optional garnish: DeviceGuard rejects every non-super-admin request
 * that arrives without them, so any route that talks to the backend by hand
 * (the binary streams, which cannot go through the JSON proxy) must send these
 * too or it works only for the super admin.
 */
export async function backendAuthHeaders(token?: string): Promise<Record<string, string>> {
  // Both reads hit the cookie jar, which is async from Next 15 onwards, so the
  // default can no longer be an argument expression.
  const accessToken = token ?? (await getAccessToken());
  const { deviceId, deviceToken } = await getDeviceCredentials();
  return {
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    ...(deviceId && deviceToken ? { 'x-device-id': deviceId, 'x-device-token': deviceToken } : {}),
  };
}

async function rawCall(path: string, opts: ApiOptions, token?: string): Promise<Response> {
  return apiFetch(`${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(await backendAuthHeaders(token)),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
}

async function tryRefresh(): Promise<string | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return null;
  const res = await apiFetch(`/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  await setAuthCookies(data.accessToken, data.refreshToken);
  return data.accessToken;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
