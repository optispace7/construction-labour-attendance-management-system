import { apiFetch } from './api-fetch';
import {
  getAccessToken,
  getDeviceCredentials,
} from './session';

interface ApiOptions {
  method?: string;
  body?: unknown;
  // when false, don't attempt token refresh (used by the refresh call itself)
  allowRefresh?: boolean;
}

/**
 * Server-side fetch to the backend using the access cookie. On 401 it attempts
 * Throws ApiError on
 * non-2xx so server components / route handlers can map it.
 */
export async function serverApi<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  // No retry on 401. A Better Auth session is extended by the server as it is
  // used and has no refresh token to present, so a 401 means the session is
  // genuinely over — retrying the same request with the same cookie can only
  // produce the same 401, one round trip later.
  const res = await rawCall(path, opts, await getAccessToken());
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
