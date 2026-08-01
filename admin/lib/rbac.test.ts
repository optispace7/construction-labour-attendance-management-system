import { describe, it, expect } from 'vitest';
import { canAccessPath, landingPathForRole, navForRole, NAV_ITEMS, ROUTE_RULES } from './rbac';

describe('navForRole', () => {
  it('gives super admin every nav item', () => {
    const labels = navForRole('SUPER_ADMIN').map((i) => i.label);
    expect(labels).not.toContain('Organizations');
    expect(labels).toContain('Workers');
    expect(labels).toContain('Audit');
  });

  it('gives site admin everything but organizations', () => {
    const labels = navForRole('SITE_ADMIN').map((i) => i.label);
    expect(labels).not.toContain('Organizations');
    expect(labels).toContain('Sites');
    expect(labels).toContain('Vendors');
  });

  it('gives the safety officer operations and people, not administration', () => {
    const labels = navForRole('SUPERVISOR').map((i) => i.label);
    for (const allowed of [
      'Dashboard',
      'Attendance',
      'Reports',
      'Workers',
      'Staff',
      'Visitors',
      'Sites',
      'Vendors',
      'Designations',
    ]) {
      expect(labels).toContain(allowed);
    }
    for (const denied of ['Corrections', 'Users', 'Devices', 'Company', 'Storage', 'Audit']) {
      expect(labels).not.toContain(denied);
    }
  });

  it('keeps the watchman out of the admin panel', () => {
    expect(navForRole('WATCHMAN')).toHaveLength(0);
  });
});

describe('canAccessPath', () => {
  it('refuses the pages a role has no nav entry for', () => {
    // The bug this exists for: /corrections is off the Safety Officer's sidebar,
    // but typing the URL used to open it anyway.
    for (const denied of ['/corrections', '/users', '/devices', '/company', '/storage', '/audit']) {
      expect(canAccessPath('SUPERVISOR', denied)).toBe(false);
      expect(canAccessPath('SITE_ADMIN', denied)).toBe(true);
    }
  });

  it('allows the pages that role does hold', () => {
    for (const allowed of [
      '/',
      '/attendance',
      '/attendance/manual-entries',
      '/reports',
      '/workers',
      '/sites',
      '/safety',
      '/safety/daily',
    ]) {
      expect(canAccessPath('SUPERVISOR', allowed)).toBe(true);
    }
  });

  it('lets the most specific rule win over its parent', () => {
    // /attendance is the Safety Officer's; the repair screen under it is not.
    expect(canAccessPath('SUPERVISOR', '/attendance')).toBe(true);
    expect(canAccessPath('SUPERVISOR', '/attendance/fix')).toBe(false);
    expect(canAccessPath('SUPER_ADMIN', '/attendance/fix')).toBe(true);
  });

  it('matches a dynamic segment without opening the parent up', () => {
    expect(canAccessPath('SUPERVISOR', '/sites')).toBe(true);
    expect(canAccessPath('SUPERVISOR', '/sites/3f1c-uuid/settings')).toBe(false);
    expect(canAccessPath('SITE_ADMIN', '/sites/3f1c-uuid/settings')).toBe(true);
  });

  it('does not let the dashboard rule cover everything below it', () => {
    expect(canAccessPath('SUPERVISOR', '/')).toBe(true);
    // Unknown paths fail closed rather than inheriting '/'.
    expect(canAccessPath('SUPER_ADMIN', '/nothing-here')).toBe(false);
  });

  it('gives the watchman nothing at all', () => {
    for (const path of ['/', '/attendance', '/workers', '/corrections']) {
      expect(canAccessPath('WATCHMAN', path)).toBe(false);
    }
  });

  it('covers every sidebar route with a rule', () => {
    const patterns = new Set(ROUTE_RULES.map((r) => r.pattern));
    for (const item of NAV_ITEMS) expect(patterns.has(item.href)).toBe(true);
  });
});

describe('landingPathForRole', () => {
  it('sends a refused navigation to the role’s own first page', () => {
    expect(landingPathForRole('SUPERVISOR')).toBe('/');
    expect(landingPathForRole('SITE_ADMIN')).toBe('/');
  });

  it('has nowhere to send a watchman, so says so', () => {
    // Null is what stops the guard bouncing them between two refused pages.
    expect(landingPathForRole('WATCHMAN')).toBeNull();
  });

  it('never lands a role on a page it cannot open', () => {
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'] as const) {
      const home = landingPathForRole(role);
      expect(home).not.toBeNull();
      expect(canAccessPath(role, home!)).toBe(true);
    }
  });
});
