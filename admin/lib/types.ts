// Shared API types mirroring the backend contracts (docs/03-api-contracts.md).
export type UserRole = 'SUPER_ADMIN' | 'SITE_ADMIN' | 'WATCHMAN' | 'SUPERVISOR';

export interface Me {
  id: string;
  fullName: string;
  email: string | null;
  role: UserRole;
  organizationId: string;
  siteScopes: string[];
}

export interface Organization {
  id: string;
  name: string;
  code: string;
  timezone: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  logoScale?: number | null;
}

/** A PDF on the Company page — a licence, an insurance policy, a registration. */
export interface CompanyDocument {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** YYYY-MM-DD, or null when the document never expires. */
  validUntil: string | null;
  remindDaysBefore: number;
  /** The day the reminder mail goes out (YYYY-MM-DD), null without a validity. */
  remindOn: string | null;
  /** Counted in the company's timezone by the server — negative once expired. */
  daysUntilExpiry: number | null;
  /** Validity the reminder has already been mailed for; null = still to come. */
  reminderSentFor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Site {
  id: string;
  name: string;
  code: string;
  timezone: string;
  isActive: boolean;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusM?: number | null;
}

export interface SiteSettings {
  siteId: string;
  verificationMode: 'MANUAL' | 'AUTO';
  autoLoginCountdownSeconds: number;
  duplicateTapCooldownSeconds: number;
  safetyGapMinutes: number;
  geoEnforcement: boolean;
  geoRadiusMeters: number;
  photoVerificationMode: 'ALWAYS' | 'NEVER' | 'RANDOM';
  photoVerificationRandomPct: number;
  defaultShiftId?: string | null;
}

export type PersonCategory = 'WORKER' | 'STAFF' | 'VISITOR';

export interface Worker {
  id: string;
  workerCode: string;
  fullName: string;
  category?: PersonCategory;
  designationId?: string | null;
  designation?: { name: string } | null;
  fatherName?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  language?: string | null;
  photoUrl?: string | null;
  mobileNumber?: string | null;
  pincode?: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'EXITED' | 'SUSPENDED';
  bloodGroup?: string | null;
  emergencyContactName?: string | null;
  emergencyContactNumber?: string | null;
  screeningDoneOn?: string | null;
  screeningDoneBy?: string | null;
  inductionDoneOn?: string | null;
  inductedBy?: string | null;
  validityTill?: string | null;
  nomineeName?: string | null;
  nomineeRelation?: string | null;
  vendorId?: string | null;
  vendor?: { name: string } | null;
  // Current site assignment (supplies the "Project Name" line on the ID card).
  assignments?: { site?: { name?: string | null } | null }[];
  natureOfContractor?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  ifscCode?: string | null;
  pfNumber?: string | null;
  esiNumber?: string | null;
  govIdType?: string | null;
  aadhaarLast4?: string | null;
  panLast4?: string | null;
  // Visitor-only fields.
  escortName?: string | null;
  visitorCompany?: string | null;
  idProofPhotoId?: string | null;
}

export interface Vendor {
  id: string;
  name: string;
  code: string;
  contactPerson?: string | null;
  contactNumber?: string | null;
  isActive: boolean;
}

export interface Designation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  siteId?: string | null;
  data?: Record<string, unknown> | null;
  createdAt: string;
  readAt?: string | null;
}

export interface DaySummary {
  date: string;
  total: number;
  activeNow: number;
  byDesignation: { designation: string; count: number; active: number }[];
  byVendor: { vendor: string; count: number; active: number }[];
  byCategory: { category: string; count: number; active: number }[];
}

export interface Device {
  id: string;
  deviceUid: string;
  label?: string | null;
  platform?: string | null;
  status: 'PENDING' | 'AUTHORIZED' | 'REVOKED';
  siteId?: string | null;
  lastSeenAt?: string | null;
  createdAt: string;
  /** Owning user (web browsers and personal devices); null for shared/legacy devices. */
  user?: { id: string; fullName: string; role: UserRole } | null;
}

export interface CorrectionRequest {
  id: string;
  workerId: string;
  worker?: { fullName: string; workerCode: string } | null;
  siteId: string;
  workDate: string;
  type: 'LOGIN' | 'LOGOUT' | 'MISSING' | 'WRONG_SITE';
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  notes?: string | null;
  items: { id: string; field: string; proposedValue: unknown; previousValue?: unknown }[];
  requestedBy: string;
  requestedByName?: string | null;
  reviewedBy?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewNotes?: string | null;
  /** Applied by its own author — nobody else reviewed it. */
  autoApplied?: boolean;
  createdAt: string;
}

/**
 * A punch a watchman typed in by hand instead of scanning a badge.
 *
 * Nothing here is attendance yet: a PENDING row means the session has NOT been
 * created (LOGIN) or closed (LOGOUT), so the person is absent from "on site now"
 * and from the SOS headcount until it is accepted.
 */
export interface ManualAttendanceRequest {
  id: string;
  siteId: string;
  workerId: string;
  tapType: 'LOGIN' | 'LOGOUT';
  sessionId?: string | null;
  recordedAt: string;
  reason?: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedBy?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewNotes?: string | null;
  createdAt: string;
  worker?: {
    id: string;
    fullName: string;
    workerCode: string;
    photoUrl?: string | null;
    category?: string | null;
    designation?: { name: string } | null;
    vendor?: { name: string } | null;
  } | null;
  site?: { id: string; name: string; timezone: string } | null;
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}
