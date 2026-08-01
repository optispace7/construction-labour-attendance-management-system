'use client';

import * as React from 'react';
import { Me } from './types';
import { canAccessPath } from './rbac';

/**
 * The signed-in user, handed down from the dashboard layout.
 *
 * The layout already fetches /auth/me to build the sidebar, so the pages inside
 * it should not each fetch it again. What they need it for is mostly one thing:
 * not offering a shortcut to a page this role cannot open. A tile that bounces
 * you back to the dashboard is worse than a tile that was never there.
 */
const MeContext = React.createContext<Me | null>(null);

export function MeProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = React.useContext(MeContext);
  if (!me) throw new Error('useMe must be used inside the dashboard layout');
  return me;
}

/** `can('/corrections')` — whether this user may open that page. */
export function useCanAccess(): (pathname: string) => boolean {
  const me = useMe();
  return React.useCallback((pathname: string) => canAccessPath(me.role, pathname), [me.role]);
}
