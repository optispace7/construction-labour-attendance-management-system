/** Shapes returned by the dashboard endpoints. Kept beside the page that owns them. */

export interface StatPerson {
  fullName: string;
  workerCode: string;
  siteName: string | null;
  loginAt: string;
  /** The business day the session belongs to. */
  workDate?: string;
  /** Open since an earlier day — i.e. never scanned out. */
  carriedOver?: boolean;
}

export interface StatBucket {
  count: number;
  people: StatPerson[];
}

export interface GateTally {
  checkedIn: number;
  onSite: number;
  checkedOut: number;
  lateArrivals: number;
  workersCheckedIn: number;
}

export interface DashboardStats {
  onSiteNow: {
    total: number;
    byCategory: Record<string, StatBucket>;
    /** Open sessions that started today. Absent on an older API. */
    today?: number;
    /** Open sessions left over from an earlier day — nobody scanned them out. */
    carriedOver?: number;
  };
  missedLogout: { date: string; total: number; byCategory: Record<string, StatBucket> };
  /** Added alongside the redesign — absent on an API older than the panel. */
  workforce?: { total: number; byCategory: Record<string, number> };
  movement?: { date: string; today: GateTally; yesterday: GateTally };
}

export interface Manpower {
  days: string[];
  trend: number[];
  from: string;
  to: string;
  totalManDays: number;
  totalToday: number;
  manHoursToday: number;
  activeTrades: number;
  byTrade: { trade: string; count: number }[];
  byVendor: { vendor: string; count: number }[];
}

/**
 * Per-vendor daily attendance across a 30-day window.
 *
 * `series` carries the top eight vendors only; anything past that is summed into
 * `otherTotals` so the day totals still reconcile. `splits` breaks each day down
 * by designation, which is what the side panel reads.
 */
export interface VendorTrend {
  days: string[];
  series: {
    vendor: string;
    total: number;
    data: number[];
    splits: Record<string, number>[];
  }[];
  totals: number[];
  totalSplits: Record<string, number>[];
  otherTotals: number[];
  hiddenVendorCount: number;
}

export interface DashboardCharts {
  vendorTrend: VendorTrend;
  manpower: Manpower;
  siteWise: { site: string; onSite: number }[];
  distribution: { category: string; onSite: number }[];
  correctionsBySite: { site: string; pending: number }[];
  vendorToday: { vendor: string; count: number }[];
}

export interface StorageUsageLite {
  level: 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
  usedPercent: number | null;
}

export interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  entityName: string | null;
  createdAt: string;
}
