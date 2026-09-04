import { NextResponse } from 'next/server';
import { serverApi, ApiError } from '@/lib/server/api';
import { getDeviceCredentials, getDeviceUid, setDeviceCredentials } from '@/lib/server/session';

interface DeviceStatus {
  deviceId: string | null;
  status: 'PENDING' | 'AUTHORIZED' | 'REVOKED' | 'UNREGISTERED';
}

/**
 * Polled by the "waiting for approval" screen. Once the device is AUTHORIZED
 * this collects the device token (one-time) and stores it in cookies so the
 * next reload passes the API's device guard.
 */
export async function GET() {
  const uid = await getDeviceUid();
  if (!uid) return NextResponse.json({ status: 'UNREGISTERED', ready: false });

  try {
    const st = await serverApi<DeviceStatus>(`/auth/device/status?uid=${encodeURIComponent(uid)}`);
    let ready = false;
    if (st.status === 'AUTHORIZED' && st.deviceId) {
      const { deviceToken } = await getDeviceCredentials();
      if (!deviceToken) {
        const tok = await serverApi<{ deviceToken: string }>('/auth/device/token', {
          method: 'POST',
          body: { deviceId: st.deviceId },
        });
        await setDeviceCredentials(st.deviceId, tok.deviceToken);
      }
      ready = true;
    }
    return NextResponse.json({ status: st.status, ready });
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json({ status: 'ERROR', ready: false }, { status: e.status });
    }
    throw e;
  }
}
