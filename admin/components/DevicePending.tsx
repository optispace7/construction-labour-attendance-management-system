'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import LaptopIcon from '@mui/icons-material/Laptop';

/**
 * Shown to non-super-admin users whose browser has not been approved yet.
 * Polls the BFF until an admin/super admin authorizes this device, then
 * reloads into the app.
 */
/** What /api/auth/device answers while this screen polls. */
interface DeviceStatusReply {
  status?: string;
  ready?: boolean;
}

export function DevicePending({ approverLabel }: { approverLabel: string }) {
  const router = useRouter();
  const [status, setStatus] = React.useState<string>('PENDING');

  React.useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/auth/device', { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as DeviceStatusReply;
        if (stop) return;
        setStatus(body.status ?? 'PENDING');
        if (body.ready) {
          router.refresh();
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!stop) timer = setTimeout(tick, 5000);
    };
    let timer = setTimeout(tick, 0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [router]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Card sx={{ width: 440, maxWidth: '95vw' }}>
        <CardContent sx={{ textAlign: 'center', py: 5 }}>
          <LaptopIcon sx={{ fontSize: 48, color: 'warning.main', mb: 1 }} />
          <Typography variant="h6" gutterBottom>
            {status === 'REVOKED' ? 'This device was revoked' : 'Waiting for device approval'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {status === 'REVOKED'
              ? `Access from this browser has been revoked. Contact your ${approverLabel}.`
              : `You have signed in successfully, but this browser must be approved by ${approverLabel} before you can continue. This page checks automatically.`}
          </Typography>
          <Stack direction="row" spacing={1.5} justifyContent="center" alignItems="center">
            {status !== 'REVOKED' && <CircularProgress size={18} />}
            <Typography variant="caption" color="text.secondary">
              {status === 'REVOKED' ? '' : 'Checking every few seconds…'}
            </Typography>
          </Stack>
          <Button onClick={logout} sx={{ mt: 3 }} color="inherit">
            Sign out
          </Button>
        </CardContent>
      </Card>
    </Box>
  );
}
