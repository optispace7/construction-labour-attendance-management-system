'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Box, CircularProgress } from '@mui/material';
import { useRevealedState } from '@/lib/hiddenNav';
import { isPathHiddenFor } from '@/lib/rbac';
import { useMe } from '@/lib/me';

/**
 * Wraps a page that is hidden from the sidebar, so its URL is hidden too.
 *
 * Without this, hiding the nav item only moves the link — anyone who had the
 * page open, bookmarked it, or hit browser-back would still be looking at it,
 * which is exactly the complaint this was meant to answer.
 *
 * Only for the roles the page is concealed from. A role that has the item in
 * its own sidebar — the Safety Officer, on the safety board — walks straight
 * through, chord or no chord.
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
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const concealed = isPathHiddenFor(me.role, pathname);

  React.useEffect(() => {
    if (concealed && ready && !revealed) router.replace('/');
  }, [concealed, ready, revealed, router]);

  if (!concealed) return <>{children}</>;

  if (!ready || !revealed) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  return <>{children}</>;
}
