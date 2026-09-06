import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '@/lib/server/api-fetch';
import {
  getOrCreateDeviceUid,
  setBetterAuthSession,
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

/** Better Auth's sign-in reply, as much of it as this route reads. */
interface LoginResult {
  token?: string;
  user?: { id?: string; email?: string; name?: string; role?: string };
}

/** How long the session cookie lives. Better Auth's default is seven days. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export async function POST(req: NextRequest) {
  const { email, identifier, password } = (await req.json()) as LoginBody;
  // An e-mail address or a user ID: site staff have no mailbox, so the user ID
  // is the only way in for them, and Better Auth splits those across two
  // endpoints rather than accepting either at one.
  const id = (identifier ?? email ?? '').trim();
  const byEmail = id.includes('@');
  const res = await apiFetch(byEmail ? '/sign-in/email' : '/sign-in/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(byEmail ? { email: id, password } : { username: id, password }),
    cache: 'no-store',
  }, { betterAuth: true });

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
  // Better Auth returns the session token in a header for non-browser clients
  // and in the body for browsers; take whichever arrived.
  const token = res.headers.get('set-auth-token') ?? data.token;
  if (!token) {
    return NextResponse.json(
      { title: 'Sign-in failed', detail: 'The server did not return a session.' },
      { status: 502 },
    );
  }
  await setBetterAuthSession(token, SESSION_MAX_AGE);

  // The role has to be asked for. Better Auth's user carries identity and
  // nothing else — no role, no organization — because authorization lives in
  // our users table, not in a table a library owns. Reading `role` off its
  // reply silently yields undefined, which would make the check below false
  // for everybody and skip device approval for every Supervisor and Watchman
  // on the web, while looking like it worked.
  const me = await apiFetch('/auth/me', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const profile = me.ok ? ((await me.json()) as { role?: string; fullName?: string }) : null;
  const role = profile?.role;

  // Device approval: non-super-admin browsers must be approved before any
  // data is served. Register this browser and try to collect its token —
  // that succeeds only once an admin/super admin has authorized it.
  let deviceStatus: string | null = null;
  if (role && role !== 'SUPER_ADMIN') {
    deviceStatus = 'PENDING';
    try {
      const uid = await getOrCreateDeviceUid();
      const reg = await apiFetch(`/auth/device/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
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
            authorization: `Bearer ${token}`,
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

  // The panel keys its navigation off role, so return the profile that has one.
  return NextResponse.json({ user: profile ?? data.user, deviceStatus });
}
