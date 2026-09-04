import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  COOKIE_ACCESS,
  COOKIE_DEVICE_ID,
  COOKIE_DEVICE_TOKEN,
} from '../config';

const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));

const { backendAuthHeaders } = await import('./api');

beforeEach(() => jar.clear());

/**
 * The binary routes (/api/photo, /api/worker-documents) bypass the JSON proxy
 * and call the backend directly. Sending only the bearer token there made every
 * image and document download 403 for non-super-admins, whom DeviceGuard
 * requires to present approved-browser credentials.
 */
describe('backendAuthHeaders', () => {
  it('carries the approved-device credentials alongside the token', async () => {
    jar.set(COOKIE_ACCESS, 'access-1');
    jar.set(COOKIE_DEVICE_ID, 'dev-1');
    jar.set(COOKIE_DEVICE_TOKEN, 'devtok-1');

    expect(await backendAuthHeaders()).toEqual({
      authorization: 'Bearer access-1',
      'x-device-id': 'dev-1',
      'x-device-token': 'devtok-1',
    });
  });

  it('omits the device headers when the browser is not yet registered', async () => {
    jar.set(COOKIE_ACCESS, 'access-1');
    expect(await backendAuthHeaders()).toEqual({ authorization: 'Bearer access-1' });
  });

  it('prefers an explicitly passed token (the post-refresh retry)', async () => {
    jar.set(COOKIE_ACCESS, 'stale');
    jar.set(COOKIE_DEVICE_ID, 'dev-1');
    jar.set(COOKIE_DEVICE_TOKEN, 'devtok-1');

    expect(await backendAuthHeaders('fresh')).toMatchObject({ authorization: 'Bearer fresh' });
  });
});
