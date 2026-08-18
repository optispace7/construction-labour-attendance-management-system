import { UserRole } from '@prisma/client';

/** All permissions in the system (see docs/01-architecture.md §3.2). */
export enum Permission {
  ORG_MANAGE = 'org.manage',
  SITE_MANAGE = 'site.manage',
  VENDOR_MANAGE = 'vendor.manage',
  WORKER_MANAGE = 'worker.manage',
  WORKER_VIEW_LIMITED = 'worker.view.limited',
  WORKER_VIEW_SENSITIVE = 'worker.view.sensitive',
  ATTENDANCE_MARK = 'attendance.mark',
  ATTENDANCE_VIEW = 'attendance.view',
  ATTENDANCE_EDIT = 'attendance.edit',
  PAYROLL_VIEW = 'payroll.view',
  SETTINGS_MANAGE = 'settings.manage',
  CORRECTION_REQUEST = 'correction.request',
  CORRECTION_APPROVE = 'correction.approve',
  /** Accept or decline a manual (typed, un-scanned) punch. */
  MANUAL_ATTENDANCE_REVIEW = 'manual.attendance.review',
  REPORTS_ALL = 'reports.all',
  REPORTS_SUMMARY = 'reports.summary',
  /**
   * Read site paperwork — licences, insurance, registrations — and open the
   * files themselves. Filing, renaming and deleting them stays on
   * SETTINGS_MANAGE: the Safety Officer needs the certificate on site, not the
   * ability to withdraw it.
   */
  DOCUMENT_VIEW = 'document.view',
  /** Read the safety statistics board. */
  SAFETY_VIEW = 'safety.view',
  /** Fill in, correct or remove a day's safety figures. */
  SAFETY_MANAGE = 'safety.manage',
  USER_MANAGE = 'user.manage',
  DEVICE_MANAGE = 'device.manage',
  AUDIT_VIEW = 'audit.view',
  EMERGENCY_VIEW = 'emergency.view',
}

/**
 * Role → permission set. EMERGENCY_VIEW is granted to every role unconditionally
 * (emergency data must be visible regardless of other limits).
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: Object.values(Permission),

  SITE_ADMIN: [
    Permission.SITE_MANAGE,
    Permission.VENDOR_MANAGE,
    Permission.WORKER_MANAGE,
    Permission.WORKER_VIEW_LIMITED,
    Permission.WORKER_VIEW_SENSITIVE,
    Permission.ATTENDANCE_VIEW,
    Permission.PAYROLL_VIEW,
    Permission.SETTINGS_MANAGE,
    Permission.CORRECTION_REQUEST,
    Permission.CORRECTION_APPROVE,
    Permission.MANUAL_ATTENDANCE_REVIEW,
    Permission.REPORTS_ALL,
    Permission.DOCUMENT_VIEW,
    Permission.SAFETY_VIEW,
    Permission.SAFETY_MANAGE,
    Permission.DEVICE_MANAGE,
    Permission.USER_MANAGE,
    Permission.AUDIT_VIEW,
    Permission.EMERGENCY_VIEW,
  ],

  WATCHMAN: [Permission.WORKER_VIEW_LIMITED, Permission.ATTENDANCE_MARK, Permission.EMERGENCY_VIEW],

  // SUPERVISOR is displayed as "Safety Officer" in the apps. They work the site
  // on mobile and run the day-to-day records on the admin panel: people, sites,
  // vendors, designations and reports. They are deliberately kept out of system
  // administration (users, devices, company settings, storage, audit) and cannot
  // approve their own corrections. They do hold WORKER_VIEW_SENSITIVE — they are
  // the ones who capture Aadhaar/PAN/bank at registration — and every reveal is
  // audited like any other role's.
  //
  // MANUAL_ATTENDANCE_REVIEW is theirs first: a punch typed in by hand at the
  // gate is the Safety Officer's to accept or decline, because they are the one
  // on site who can say whether that person was really there.
  SUPERVISOR: [
    Permission.WORKER_VIEW_LIMITED,
    Permission.WORKER_VIEW_SENSITIVE,
    Permission.WORKER_MANAGE,
    Permission.SITE_MANAGE,
    Permission.VENDOR_MANAGE,
    Permission.ATTENDANCE_VIEW,
    Permission.CORRECTION_REQUEST,
    Permission.MANUAL_ATTENDANCE_REVIEW,
    Permission.REPORTS_ALL,
    Permission.REPORTS_SUMMARY,
    // Read-only, and deliberately not SETTINGS_MANAGE: an inspector asks for
    // the site's licence at the gate and the Safety Officer is who is standing
    // there. Filing and deleting remain an admin's.
    Permission.DOCUMENT_VIEW,
    // The safety board is the Safety Officer's own record — they are the one
    // who counts the toolbox talks and closes the unsafe acts, so they own both
    // the reading and the writing of it.
    Permission.SAFETY_VIEW,
    Permission.SAFETY_MANAGE,
    Permission.EMERGENCY_VIEW,
  ],
};

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
