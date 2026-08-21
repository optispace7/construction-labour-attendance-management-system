import { UserRole } from './types';

export type NavGroup =
  | 'Overview'
  | 'Operations'
  | 'Safety'
  | 'People'
  | 'Sites & partners'
  | 'Administration';

export interface NavItem {
  label: string;
  href: string;
  roles: UserRole[];
  group: NavGroup;
  /**
   * Roles the item is kept from until the reveal chord is pressed. Concealment
   * for work in progress, never a permission — see `lib/hiddenNav.ts`. A role
   * that is not listed gets an ordinary sidebar entry it can simply click.
   */
  hiddenFor?: UserRole[];
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Overview' },
  { label: 'Attendance', href: '/attendance', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Operations' },
  // Editing a recorded session is the Super Admin's escape hatch (ATTENDANCE_EDIT).
  // Everyone else raises a correction instead, which an admin then approves.
  { label: 'Fix attendance', href: '/attendance/fix', roles: ['SUPER_ADMIN'], group: 'Operations' },
  // Safety Officers raise corrections here as well as on the phone — a run of
  // them is easier to work through at a desk. Deciding them is still an
  // admin's: the page hides approve/reject from anyone without the permission.
  {
    label: 'Corrections',
    href: '/corrections',
    roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'],
    group: 'Operations',
  },
  // Punches a watchman typed in by hand. The Safety Officer is the first
  // reviewer and normally does this on the phone, but they keep the web page
  // too — a run of entries is easier to work through at a desk.
  {
    label: 'Manual entries',
    href: '/attendance/manual-entries',
    roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'],
    group: 'Operations',
  },
  { label: 'Reports', href: '/reports', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Operations' },
  // The safety board is the Safety Officer's own record: they enter the daily
  // figures and read the statistics off them, so both pages are theirs as much
  // as an admin's.
  //
  // These were concealed from the two admin roles while the board was being
  // shaped, because a client holds an admin login to this panel. It is shaped;
  // both pages now ship to everyone whose role carries them, no chord needed.
  {
    label: 'Safety statistics',
    href: '/safety',
    roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'],
    group: 'Safety',
  },
  {
    label: 'Daily task',
    href: '/safety/daily',
    roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'],
    group: 'Safety',
  },
  { label: 'Workers', href: '/workers', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'People' },
  { label: 'Staff', href: '/staff', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'People' },
  { label: 'Visitors', href: '/visitors', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'People' },
  { label: 'Sites', href: '/sites', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Sites & partners' },
  // Licences and insurance held against a site. The Safety Officer reads these
  // — an inspector at the gate asks for the site's licence and they are the one
  // standing there — but the page hides upload, edit and delete from them, and
  // the API refuses those on SETTINGS_MANAGE regardless.
  {
    label: 'Documents',
    href: '/documents',
    roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'],
    group: 'Sites & partners',
  },
  { label: 'Vendors', href: '/vendors', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Sites & partners' },
  { label: 'Designations', href: '/designations', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Sites & partners' },
  { label: 'Users', href: '/users', roles: ['SUPER_ADMIN', 'SITE_ADMIN'], group: 'Administration' },
  { label: 'Devices', href: '/devices', roles: ['SUPER_ADMIN', 'SITE_ADMIN'], group: 'Administration' },
  { label: 'Company', href: '/company', roles: ['SUPER_ADMIN', 'SITE_ADMIN'], group: 'Administration' },
  { label: 'Storage', href: '/storage', roles: ['SUPER_ADMIN', 'SITE_ADMIN'], group: 'Administration' },
  { label: 'Audit', href: '/audit', roles: ['SUPER_ADMIN', 'SITE_ADMIN'], group: 'Administration' },
];

export function navForRole(role: UserRole): NavItem[] {
  return NAV_ITEMS.filter((i) => i.roles.includes(role));
}

/** Whether this role only sees the item after the reveal chord. */
export function isHiddenFor(item: NavItem, role: UserRole): boolean {
  return item.hiddenFor?.includes(role) ?? false;
}

/**
 * The same question asked of a URL rather than a nav item, for the page gate
 * and the shell's bounce-on-hide. Resolved against the same list, by the same
 * most-specific-wins rule as `rolesForPath`, so a page cannot be concealed in
 * the sidebar and open on its own URL — or the other way round.
 */
export function isPathHiddenFor(role: UserRole, pathname: string): boolean {
  let best: NavItem | null = null;
  let bestScore = -1;
  for (const item of NAV_ITEMS) {
    const score = matchScore(item.href, pathname);
    if (score !== null && score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best !== null && isHiddenFor(best, role);
}

// ---------------------------------------------------------------------------
// Route access
// ---------------------------------------------------------------------------

export interface RouteRule {
  /** A route pattern; `[param]` matches any single segment. */
  pattern: string;
  roles: UserRole[];
}

/**
 * Pages with no sidebar entry of their own.
 *
 * Every route under (dashboard) must be listed either here or in NAV_ITEMS.
 * `canAccessPath` denies anything it does not recognise, so a page shipped
 * without a rule is a page nobody can open — which is the failure worth having,
 * rather than one silently open to every role.
 */
const EXTRA_ROUTES: RouteRule[] = [
  // Printable badge sheets, reached from the Workers page.
  { pattern: '/workers/badges', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'] },
  // Shift times, grace periods, geofence. The backend guards these with
  // SETTINGS_MANAGE, which the Safety Officer does not hold — so the page would
  // only ever load empty and fail on save.
  { pattern: '/sites/[id]/settings', roles: ['SUPER_ADMIN', 'SITE_ADMIN'] },
  // A dashboard prototype kept around for comparison. Never a client's page.
  { pattern: '/dashboard-redesign', roles: ['SUPER_ADMIN'] },
];

/** Who may open which page — the one list the nav, the middleware and the
 *  dashboard layout all read, so none of them can drift from the others. */
export const ROUTE_RULES: RouteRule[] = [
  ...NAV_ITEMS.map((i) => ({ pattern: i.href, roles: i.roles })),
  ...EXTRA_ROUTES,
];

const segmentsOf = (p: string) => p.split('/').filter(Boolean);

/**
 * How well a pattern matches a path, or null when it does not.
 *
 * The score is the number of segments the pattern pins down, so the most
 * specific rule wins: `/attendance/fix` beats `/attendance`, and
 * `/sites/[id]/settings` beats `/sites`. Without that, a nested admin-only page
 * would inherit its parent's — more generous — rule.
 */
function matchScore(pattern: string, path: string): number | null {
  const pat = segmentsOf(pattern);
  const got = segmentsOf(path);
  // '/' is the dashboard itself and matches nothing below it.
  if (pat.length === 0) return got.length === 0 ? 0 : null;
  if (got.length < pat.length) return null;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i].startsWith('[')) continue;
    if (pat[i] !== got[i]) return null;
  }
  return pat.length;
}

/** The roles allowed on a path, or null when no rule covers it. */
export function rolesForPath(pathname: string): UserRole[] | null {
  let best: UserRole[] | null = null;
  let bestScore = -1;
  for (const rule of ROUTE_RULES) {
    const score = matchScore(rule.pattern, pathname);
    if (score !== null && score > bestScore) {
      best = rule.roles;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Whether a role may open a page.
 *
 * Fails closed: an unknown path is denied. This is the panel's own gate and is
 * about not showing somebody a page they cannot use — the real boundary is the
 * API, which checks the signed token's role on every call.
 */
export function canAccessPath(role: UserRole, pathname: string): boolean {
  const roles = rolesForPath(pathname);
  return roles !== null && roles.includes(role);
}

/**
 * Where a role goes when it asks for a page it may not have.
 *
 * The first page its own sidebar offers, which for every panel role today is
 * the dashboard. Null for a Watchman: they hold nothing in this panel at all,
 * and bouncing them to a landing page they also cannot open would loop. Hidden
 * items are skipped — a landing nobody can see in the nav is a dead end.
 */
export function landingPathForRole(role: UserRole): string | null {
  return navForRole(role).find((i) => !isHiddenFor(i, role))?.href ?? null;
}

/**
 * Display labels — enum values are kept for DB compatibility, but the UI says
 * "Admin" for SITE_ADMIN and "Safety Officer" for SUPERVISOR everywhere.
 */
export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  SITE_ADMIN: 'Admin',
  WATCHMAN: 'Watchman',
  SUPERVISOR: 'Safety Officer',
};

export function roleLabel(role: UserRole): string {
  return ROLE_LABELS[role] ?? role;
}
