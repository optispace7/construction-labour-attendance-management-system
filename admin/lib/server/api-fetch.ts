import { getCloudflareContext } from '@opennextjs/cloudflare';
import { apiInternalBaseUrl } from '../config';

/**
 * Calls the API from server-side code.
 *
 * Every server-to-server request goes through here rather than calling `fetch`
 * with a URL, because on the serverless runtime that does not work. A Worker
 * asking for another Worker on the same workers.dev zone by URL is refused by
 * the platform:
 *
 *     upstream status=404  body=error code: 1042
 *
 * A 404 with a plain-text body, which the callers then failed to parse and
 * reported as an empty object — so a platform restriction presented as the
 * login route not existing, and then as "Invalid credentials" on the screen.
 * The URL was correct the entire time.
 *
 * The supported route between two Workers is a service binding, declared as
 * `services` in wrangler.jsonc. It is also the better one: the request goes
 * straight to the other Worker instead of back out to the internet and in
 * again.
 *
 * The plain `fetch` is kept as the fallback so `next dev` against a local or
 * remote API still works, where there is no binding to find.
 */
interface ApiEnv {
  API?: { fetch: (request: Request) => Promise<Response> };
}

async function serviceBinding(): Promise<ApiEnv['API'] | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return (env as ApiEnv).API ?? null;
  } catch {
    // Not running on the Workers runtime at all — `next dev`, or a test.
    return null;
  }
}

/**
 * Better Auth is mounted outside the versioned API.
 *
 * It builds its own paths from its basePath and knows nothing about our URI
 * versioning, so its routes live at /api/better-auth rather than under /api/v1.
 * Rather than keep a second base URL in configuration — one more thing to set
 * correctly in three places — the version suffix is swapped off the one we
 * already have.
 */
function betterAuthBase(): string {
  return apiInternalBaseUrl().replace(/\/api\/v\d+$/, '/api/better-auth');
}

/**
 * `path` is relative to the API base, and must start with a slash —
 * `apiFetch('/auth/login', { method: 'POST', ... })`.
 *
 * Pass `{ betterAuth: true }` to address Better Auth's routes instead.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
  opts?: { betterAuth?: boolean },
): Promise<Response> {
  const url = `${opts?.betterAuth ? betterAuthBase() : apiInternalBaseUrl()}${path}`;
  const api = await serviceBinding();
  if (api) {
    // The hostname is ignored once the binding routes it, but a Request still
    // needs an absolute URL, and keeping the real one means the path and query
    // arrive exactly as the API expects them.
    return api.fetch(new Request(url, init));
  }
  return fetch(url, init);
}
