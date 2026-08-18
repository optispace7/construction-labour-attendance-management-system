import { Permission, roleHasPermission, ROLE_PERMISSIONS } from './permissions';

describe('RBAC permissions', () => {
  it('watchman can mark attendance but cannot edit it', () => {
    expect(roleHasPermission('WATCHMAN', Permission.ATTENDANCE_MARK)).toBe(true);
    expect(roleHasPermission('WATCHMAN', Permission.ATTENDANCE_EDIT)).toBe(false);
    expect(roleHasPermission('WATCHMAN', Permission.PAYROLL_VIEW)).toBe(false);
  });

  it('supervisor can request corrections but not approve them', () => {
    expect(roleHasPermission('SUPERVISOR', Permission.CORRECTION_REQUEST)).toBe(true);
    expect(roleHasPermission('SUPERVISOR', Permission.CORRECTION_APPROVE)).toBe(false);
    expect(roleHasPermission('SUPERVISOR', Permission.ATTENDANCE_EDIT)).toBe(false);
  });

  it('supervisor runs the admin-panel records they were granted', () => {
    for (const p of [
      Permission.WORKER_MANAGE,
      Permission.SITE_MANAGE,
      Permission.VENDOR_MANAGE,
      Permission.ATTENDANCE_VIEW,
      Permission.REPORTS_ALL,
      // They capture Aadhaar/PAN/bank at registration, so they can read it back.
      Permission.WORKER_VIEW_SENSITIVE,
    ]) {
      expect(roleHasPermission('SUPERVISOR', p)).toBe(true);
    }
  });

  it('supervisor is kept out of system administration', () => {
    for (const p of [
      Permission.USER_MANAGE,
      Permission.DEVICE_MANAGE,
      Permission.SETTINGS_MANAGE,
      Permission.AUDIT_VIEW,
      Permission.PAYROLL_VIEW,
    ]) {
      expect(roleHasPermission('SUPERVISOR', p)).toBe(false);
    }
  });

  // A watchman filing a manual punch must never be the one who waves it through.
  it('the three reviewing roles can rule on a manual punch, and the watchman cannot', () => {
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'] as const) {
      expect(roleHasPermission(role, Permission.MANUAL_ATTENDANCE_REVIEW)).toBe(true);
    }
    expect(roleHasPermission('WATCHMAN', Permission.MANUAL_ATTENDANCE_REVIEW)).toBe(false);
  });

  // The Documents page is read-only for the Safety Officer: they need the
  // site's licence to hand to an inspector, not the ability to withdraw it.
  it('supervisor reads site paperwork but cannot file or delete it', () => {
    expect(roleHasPermission('SUPERVISOR', Permission.DOCUMENT_VIEW)).toBe(true);
    expect(roleHasPermission('SUPERVISOR', Permission.SETTINGS_MANAGE)).toBe(false);
  });

  it('the roles that manage settings can read documents too', () => {
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN'] as const) {
      expect(roleHasPermission(role, Permission.DOCUMENT_VIEW)).toBe(true);
      expect(roleHasPermission(role, Permission.SETTINGS_MANAGE)).toBe(true);
    }
  });

  it('keeps the watchman out of site paperwork', () => {
    expect(roleHasPermission('WATCHMAN', Permission.DOCUMENT_VIEW)).toBe(false);
  });

  it('site admin manages vendors', () => {
    expect(roleHasPermission('SITE_ADMIN', Permission.VENDOR_MANAGE)).toBe(true);
  });

  it('every role can view emergency data', () => {
    (['SUPER_ADMIN', 'SITE_ADMIN', 'WATCHMAN', 'SUPERVISOR'] as const).forEach((role) => {
      expect(roleHasPermission(role, Permission.EMERGENCY_VIEW)).toBe(true);
    });
  });

  it('super admin holds every permission', () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN.length).toBe(Object.values(Permission).length);
  });

  it('only super admin manages organizations', () => {
    expect(roleHasPermission('SUPER_ADMIN', Permission.ORG_MANAGE)).toBe(true);
    expect(roleHasPermission('SITE_ADMIN', Permission.ORG_MANAGE)).toBe(false);
  });
});
