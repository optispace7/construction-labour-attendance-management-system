import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';
import {
  getOrCreateDeviceUid,
  setAuthCookies,
  setDeviceCredentials,
} from '@/lib/server/session';

/** Short human-readable browser label for the Devices page ("Chrome on Windows"). */
function browserLabel(ua: string | null): string {
  if (!ua) return 'Web browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : 'PC';
  return `${browser} on ${os}`;
}

/** What the login form posts. */
interface LoginBody {
  email?: string;
  identifier?: string;
  password?: string;
}

/** What the backend returns on a successful login. */
/** The device-registration reply, as much of it as this route reads. */
interface DeviceRegistration {
  status?: string;
  deviceId?: string;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user?: { role?: string };
}

export async function POST(req: NextRequest) {
  const { email, identifier, password } = (await req.json()) as LoginBody;
  const res = await apiFetch(`/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: identifier ?? email, password }),
    cache: 'no-store',
  });

  if (!res.ok) {
    // Read as text first. A failure from the platform rather than the API —
    // the 1042 that a Worker-to-Worker URL fetch used to produce — is not
    // JSON, and parsing it blind turned a diagnosable error into an empty
    // object and a misleading "Invalid credentials" on the screen.
    const raw = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { title: 'Server error', detail: raw.slice(0, 200) || 'The server could not be reached.' };
    }
    return NextResponse.json(body, { status: res.status });
  }

  const data = (await res.json()) as LoginResult;
  await setAuthCookies(data.accessToken, data.refreshToken);

  // Device approval: non-super-admin browsers must be approved before any
  // data is served. Register this browser and try to collect its token —
  // that succeeds only once an admin/super admin has authorized it.
  let deviceStatus: string | null = null;
  if (data.user?.role && data.user.role !== 'SUPER_ADMIN') {
    deviceStatus = 'PENDING';
    try {
      const uid = await getOrCreateDeviceUid();
      const reg = await apiFetch(`/auth/device/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${data.accessToken}`,
        },
        body: JSON.stringify({
          deviceUid: uid,
          platform: 'web',
          label: browserLabel(req.headers.get('user-agent')),
        }),
        cache: 'no-store',
      });
      const regBody = (await reg.json()) as DeviceRegistration;
      deviceStatus = regBody.status ?? 'PENDING';
      if (reg.ok && regBody.status === 'AUTHORIZED' && regBody.deviceId) {
        const tok = await apiFetch(`/auth/device/token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${data.accessToken}`,
          },
          body: JSON.stringify({ deviceId: regBody.deviceId }),
          cache: 'no-store',
        });
        if (tok.ok) {
          const tokBody = (await tok.json()) as { deviceToken: string };
          await setDeviceCredentials(regBody.deviceId, tokBody.deviceToken);
        }
      }
    } catch {
      // Registration failures surface as the pending-approval screen.
    }
  }

  return NextResponse.json({ user: data.user, deviceStatus });
}
