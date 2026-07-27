import { UserRole } from './types';

export type NavGroup = 'Overview' | 'Operations' | 'People' | 'Sites & partners' | 'Administration';

export interface NavItem {
  label: string;
  href: string;
  roles: UserRole[];
  group: NavGroup;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Overview' },
  { label: 'Attendance', href: '/attendance', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Operations' },
  // Editing a recorded session is the Super Admin's escape hatch (ATTENDANCE_EDIT).
  // Everyone else raises a correction instead, which an admin then approves.
  { label: 'Fix attendance', href: '/attendance/fix', roles: ['SUPER_ADMIN'], group: 'Operations' },
  // Safety Officers raise corrections from the mobile app; the web list is for
  // the admins who approve them, so it stays off the Safety Officer's nav.
  { label: 'Corrections', href: '/corrections', roles: ['SUPER_ADMIN', 'SITE_ADMIN'], group: 'Operations' },
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
  { label: 'Workers', href: '/workers', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'People' },
  { label: 'Staff', href: '/staff', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'People' },
  { label: 'Visitors', href: '/visitors', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'People' },
  { label: 'Sites', href: '/sites', roles: ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'], group: 'Sites & partners' },
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
