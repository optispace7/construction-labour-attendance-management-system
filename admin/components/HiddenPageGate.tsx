'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Box, CircularProgress } from '@mui/material';
import { useRevealedState } from '@/lib/hiddenNav';

/**
 * Wraps a page that is hidden from the sidebar, so its URL is hidden too.
 *
 * Without this, hiding the nav item only moves the link — anyone who had the
 * page open, bookmarked it, or hit browser-back would still be looking at it,
 * which is exactly the complaint this was meant to answer.
 *
 * Renders nothing until the flag has actually been read: the hook starts false
 * on both server and client to keep hydration honest, so deciding on the first
 * paint would bounce a revealed user straight back to the dashboard.
 *
 * Still concealment, not access control — the API is unchanged and will serve
 * this data to anyone whose role holds the safety permissions.
 */
export function HiddenPageGate({ children }: { children: React.ReactNode }) {
  const { revealed, ready } = useRevealedState();
  const router = useRouter();

  React.useEffect(() => {
    if (ready && !revealed) router.replace('/');
  }, [ready, revealed, router]);

  if (!ready || !revealed) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  return <>{children}</>;
}
