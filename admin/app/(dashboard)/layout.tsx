import * as React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { serverApi, ApiError } from '@/lib/server/api';
import { Me } from '@/lib/types';
import { AppShell } from '@/components/AppShell';
import { DevicePending } from '@/components/DevicePending';
import { getDeviceCredentials, getDeviceUid } from '@/lib/server/session';
import { canAccessPath, landingPathForRole } from '@/lib/rbac';
import { PATH_HEADER } from '@/lib/config';

interface DeviceStatus {
  deviceId: string | null;
  status: 'PENDING' | 'AUTHORIZED' | 'REVOKED' | 'UNREGISTERED';
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let me: Me;
  try {
    me = await serverApi<Me>('/auth/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/login');
    throw e;
  }

  // Device approval gate: everyone except the Super Admin needs this browser
  // approved (Admin PCs by the Super Admin; Safety Officers by an Admin).
  if (me.role !== 'SUPER_ADMIN') {
    const approver = me.role === 'SITE_ADMIN' ? 'the Super Admin' : 'an Admin';
    const uid = getDeviceUid();
    const { deviceToken } = getDeviceCredentials();
    if (!uid) return <DevicePending approverLabel={approver} />;
    try {
      const st = await serverApi<DeviceStatus>(
        `/auth/device/status?uid=${encodeURIComponent(uid)}`,
      );
      if (st.status !== 'AUTHORIZED' || !deviceToken) {
        return <DevicePending approverLabel={approver} />;
      }
    } catch {
      return <DevicePending approverLabel={approver} />;
    }
  }

  // Route gate, against the role the API just reported rather than the one in
  // the cookie. The middleware turns most of these away before they reach here;
  // this is the copy that cannot be talked out of it with a hand-written token.
  const pathname = headers().get(PATH_HEADER);
  if (pathname && !canAccessPath(me.role, pathname)) {
    // landingPathForRole is null only for a Watchman, who has no page here.
    redirect(landingPathForRole(me.role) ?? '/login');
  }

  return <AppShell me={me}>{children}</AppShell>;
}
