import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../../common/audit/audit.service';
import { Permission, roleHasPermission } from '../../common/rbac/permissions';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import {
  CappedSession,
  Cell,
  capWorkerDay,
  isNightTime,
  minutesToHours,
  toCsv,
} from './report.builder';
import {
  ATT_SHEET_LEGEND,
  AttSheetMonth,
  AttSheetRow,
  renderAttendanceSheetXlsx,
  renderManpowerPdf,
  renderPresenceSheetXlsx,
  renderPdf,
  renderXlsx,
} from './report.renderer';
import { CreateReportDto, ReportType } from './dto/report.dto';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether to include sensitive (joining) columns: caller opted in via
   * params.includeSensitive AND holds WORKER_VIEW_SENSITIVE. Records an audit
   * entry the first time it resolves true for a request.
   */
  private async resolveSensitive(
    user: AuthUser,
    params: Record<string, unknown>,
    reportType: ReportType,
  ): Promise<boolean> {
    const wants = params.includeSensitive === true || params.includeSensitive === 'true';
    if (!wants) return false;
    if (!roleHasPermission(user.role, Permission.WORKER_VIEW_SENSITIVE)) return false;
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'WORKER_AADHAAR_REVEAL',
      entityType: 'Report',
      // entityId is a UUID column — a report has no single entity, so leave it
      // null and carry the report type in newValue instead.
      entityId: null,
      newValue: { reportType },
      reason: 'Full-profile report (sensitive data)',
    });
    return true;
  }

  private decryptOrBlank(blob: Uint8Array | null): string {
    if (!blob) return '';
    try {
      return this.crypto.decrypt(Buffer.from(blob));
    } catch {
      return '';
    }
  }

  /** One Intl formatter per timezone — building them per row is expensive. */
  private static readonly stampFormatters = new Map<
    string,
    { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat }
  >();

  /**
   * "05 Aug 2026, 09:30 PM" — an instant as the site read it on the clock.
   *
   * Every timestamp a person sees in a report goes through here. Downloads used
   * to carry the raw UTC instant ("2026-08-05T16:00:00.000Z"), which is neither
   * the date nor the time anyone worked.
   */
  private formatStamp(d: Date, timezone: string): string {
    const tz = timezone || 'Asia/Kolkata';
    let fmt = ReportsService.stampFormatters.get(tz);
    if (!fmt) {
      fmt = {
        date: new Intl.DateTimeFormat('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          timeZone: tz,
        }),
        // en-US for the uppercase AM/PM; en-GB renders it lowercase.
        time: new Intl.DateTimeFormat('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
          timeZone: tz,
        }),
      };
      ReportsService.stampFormatters.set(tz, fmt);
    }
    return `${fmt.date.format(d)}, ${fmt.time.format(d)}`;
  }

  /**
   * Generate a report. All formats render inline in the API process — CSV as
   * text, XLSX/PDF as base64 — so no separate worker deployment is required.
   */
  async create(user: AuthUser, dto: CreateReportDto) {
    const params = dto.params ?? {};
    const sensitive = await this.resolveSensitive(user, params, dto.reportType);

    // The attendance grid has a bespoke (merged-header) XLSX layout, so it gets
    // its own build + render path; CSV/PDF fall back to a flat representation.
    if (dto.reportType === ReportType.ATTENDANCE_SHEET) {
      const sheet = await this.buildAttendanceSheet(user, params, sensitive);
      const job = await this.prisma.reportJob.create({
        data: {
          organizationId: user.organizationId,
          requestedBy: user.userId,
          reportType: dto.reportType,
          format: dto.format,
          params: params as Prisma.InputJsonValue,
          status: 'DONE',
          completedAt: new Date(),
        },
      });
      const base = { jobId: job.id, status: job.status, rowCount: sheet.rows.length };
      const stem = `attendance-sheet-${job.id}`;
      if (dto.format === 'XLSX') {
        const buffer = sheet.presence
          ? await renderPresenceSheetXlsx(sheet.months, sheet.infoHeaders, sheet.rows)
          : await renderAttendanceSheetXlsx(sheet.months, sheet.infoHeaders, sheet.rows);
        return {
          ...base,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contentBase64: buffer.toString('base64'),
          filename: `${stem}.xlsx`,
        };
      }
      if (dto.format === 'PDF') {
        const buffer = await renderPdf(
          'Attendance sheet',
          sheet.flatHeaders,
          sheet.flatRows,
          // Only the times layout has out times that can run to the next morning.
          sheet.presence ? undefined : ATT_SHEET_LEGEND,
        );
        return {
          ...base,
          contentType: 'application/pdf',
          contentBase64: buffer.toString('base64'),
          filename: `${stem}.pdf`,
        };
      }
      return {
        ...base,
        contentType: 'text/csv',
        content: toCsv(sheet.flatHeaders, sheet.flatRows),
        filename: `${stem}.csv`,
      };
    }

    // Daily/weekly/monthly PDFs are the manpower chart dashboard, not a table.
    // CSV and XLSX still carry the underlying rows.
    if (dto.format === 'PDF' && ReportsService.isChartReport(dto.reportType)) {
      const manpower = await this.buildManpower(user, dto.reportType, params);
      const org = await this.prisma.organization.findUnique({
        where: { id: user.organizationId },
        select: { name: true },
      });
      const job = await this.prisma.reportJob.create({
        data: {
          organizationId: user.organizationId,
          requestedBy: user.userId,
          reportType: dto.reportType,
          format: dto.format,
          params: params as Prisma.InputJsonValue,
          status: 'DONE',
          completedAt: new Date(),
        },
      });
      const buffer = await renderManpowerPdf(manpower, org?.name ?? '');
      return {
        jobId: job.id,
        status: job.status,
        rowCount: manpower.totalManDays,
        contentType: 'application/pdf',
        contentBase64: buffer.toString('base64'),
        filename: `manpower-${dto.reportType.toLowerCase()}-${job.id}.pdf`,
      };
    }

    const { headers, rows } = await this.buildRows(user, dto.reportType, params, sensitive);

    const job = await this.prisma.reportJob.create({
      data: {
        organizationId: user.organizationId,
        requestedBy: user.userId,
        reportType: dto.reportType,
        format: dto.format,
        params: params as Prisma.InputJsonValue,
        status: 'DONE',
        completedAt: new Date(),
      },
    });

    const title = `${dto.reportType} report`;
    const base = {
      jobId: job.id,
      status: job.status,
      rowCount: rows.length,
    };

    if (dto.format === 'XLSX') {
      const buffer = await renderXlsx(title, headers, rows);
      return {
        ...base,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentBase64: buffer.toString('base64'),
        filename: `report-${dto.reportType.toLowerCase()}-${job.id}.xlsx`,
      };
    }
    if (dto.format === 'PDF') {
      const buffer = await renderPdf(title, headers, rows);
      return {
        ...base,
        contentType: 'application/pdf',
        contentBase64: buffer.toString('base64'),
        filename: `report-${dto.reportType.toLowerCase()}-${job.id}.pdf`,
      };
    }
    return {
      ...base,
      contentType: 'text/csv',
      content: toCsv(headers, rows),
      filename: `report-${dto.reportType.toLowerCase()}-${job.id}.csv`,
    };
  }

  /** Manpower chart data without persisting a job — powers the chart preview. */
  async previewManpower(user: AuthUser, reportType: ReportType, params: Record<string, unknown>) {
    if (!ReportsService.isChartReport(reportType)) {
      throw Errors.validation({ message: 'Manpower charts cover daily, weekly and monthly only' });
    }
    return this.buildManpower(user, reportType, params);
  }

  /** Build the report rows without persisting a job — powers the admin preview. */
  async preview(user: AuthUser, reportType: ReportType, params: Record<string, unknown> = {}) {
    const sensitive = await this.resolveSensitive(user, params, reportType);
    if (reportType === ReportType.ATTENDANCE_SHEET) {
      const sheet = await this.buildAttendanceSheet(user, params, sensitive);
      return { headers: sheet.flatHeaders, rows: sheet.flatRows, rowCount: sheet.flatRows.length };
    }
    const { headers, rows } = await this.buildRows(user, reportType, params, sensitive);
    return { headers, rows, rowCount: rows.length };
  }

  async get(user: AuthUser, id: string) {
    const job = await this.prisma.reportJob.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!job) throw Errors.notFound('Report job');
    return job;
  }

  list(user: AuthUser, type?: string) {
    return this.prisma.reportJob.findMany({
      where: { organizationId: user.organizationId, ...(type ? { reportType: type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ---- Row builders --------------------------------------------------------

  /**
   * The shared filter for every attendance-session report: org, site/worker,
   * vendor and person-type, plus whichever period the report type carries.
   * Row reports and the manpower charts both run off this, so a filter only
   * ever has to be understood in one place.
   */
  private sessionWhere(
    org: string,
    type: ReportType,
    params: Record<string, unknown>,
  ): Prisma.AttendanceSessionWhereInput {
    const where: Prisma.AttendanceSessionWhereInput = { organizationId: org };
    if (params.siteId) where.siteId = String(params.siteId);
    if (params.workerId) where.workerId = String(params.workerId);
    // vendor and/or person-type (WORKER/STAFF/VISITOR) filters on the worker.
    const workerFilter: Prisma.WorkerWhereInput = {};
    if (params.vendorId) workerFilter.vendorId = String(params.vendorId);
    if (params.category)
      workerFilter.category = String(params.category) as Prisma.WorkerWhereInput['category'];
    if (Object.keys(workerFilter).length) where.worker = workerFilter;
    if (type === ReportType.DAILY && params.date) {
      where.workDate = new Date(String(params.date));
    }
    // Weekly: params.weekStart is the Monday of the week; the range runs the
    // seven days from there, so the admin only ever picks one date.
    if (type === ReportType.WEEKLY && params.weekStart) {
      const start = new Date(`${String(params.weekStart)}T00:00:00.000Z`);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      where.workDate = { gte: start, lt: end };
    }
    if (type === ReportType.MONTHLY && params.month) {
      const [y, m] = String(params.month)
        .split('-')
        .map((n) => parseInt(n, 10));
      where.workDate = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
    }
    // from/to carry full date-times — filter on the actual login timestamp so
    // time-of-day selections in the admin panel are honoured.
    if ((params.from || params.to) && !where.workDate) {
      where.loginAt = {
        ...(params.from ? { gte: new Date(String(params.from)) } : {}),
        ...(params.to ? { lte: new Date(String(params.to)) } : {}),
      };
    }
    if (type === ReportType.OVERTIME) {
      where.overtimeMinutes = { gt: 0 };
    }
    return where;
  }

  /** Whether the caller asked for the statutory hours cap. */
  private static wantsCap(params: Record<string, unknown>): boolean {
    return params.capHours === true || params.capHours === 'true';
  }

  /**
   * Apply the statutory cap across each worker's whole day and return the
   * capped figures keyed by session id. The ceiling is a limit on the day, not
   * on a single tap-in — a split shift of 6h + 6h breaches it just as surely as
   * one forgotten 12-hour logout — so every session a worker has on a work date
   * is capped together. Callers look each session up by id and fall back to the
   * raw row when the cap is off.
   */
  private static capByDay<
    T extends {
      id: string;
      workerId: string;
      workDate: Date;
      workedMinutes: number | null;
      overtimeMinutes: number | null;
      loginAt: Date | null;
      logoutAt: Date | null;
    },
  >(sessions: T[]): Map<string, CappedSession> {
    const byWorkerDay = new Map<string, T[]>();
    for (const s of sessions) {
      const key = `${s.workerId}|${s.workDate.toISOString().slice(0, 10)}`;
      const group = byWorkerDay.get(key);
      if (group) group.push(s);
      else byWorkerDay.set(key, [s]);
    }

    const capped = new Map<string, CappedSession>();
    for (const group of byWorkerDay.values()) {
      // Login order, so the trimming starts at the end of the day. A session
      // with no login stamp sorts last — it cannot anchor a shift boundary.
      const ordered = [...group].sort(
        (a, b) => (a.loginAt?.getTime() ?? Infinity) - (b.loginAt?.getTime() ?? Infinity),
      );
      const result = capWorkerDay(ordered);
      ordered.forEach((s, i) => capped.set(s.id, result[i]));
    }
    return capped;
  }

  /** Report types that render as manpower charts rather than a row table. */
  static isChartReport(type: ReportType): boolean {
    return type === ReportType.DAILY || type === ReportType.WEEKLY || type === ReportType.MONTHLY;
  }

  /**
   * Manpower summary behind the chart report: headline totals and the by-trade
   * / by-vendor splits for the chosen period, plus a day-by-day trend. Labour
   * only — staff and visitors are on site but are not manpower.
   *
   * A daily report still shows a seven-day trend (the period itself is one
   * bar), so the query covers the trend window and the period totals are taken
   * from the subset that falls inside the period.
   */
  async buildManpower(user: AuthUser, type: ReportType, params: Record<string, unknown>) {
    const where = this.sessionWhere(user.organizationId, type, params);
    // Manpower is labour; an explicit category filter still wins so the admin
    // can look at staff deliberately.
    const worker = (where.worker ?? {}) as Prisma.WorkerWhereInput;
    where.worker = { ...worker, ...(params.category ? {} : { category: 'WORKER' }) };

    const dayMs = 86_400_000;
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const { start, end } = this.periodRange(type, params);
    // Daily reports get six days of run-up for context; the others trend across
    // their own period.
    const trendStart = type === ReportType.DAILY ? new Date(start.getTime() - 6 * dayMs) : start;

    const sessions = await this.prisma.attendanceSession.findMany({
      where: { ...where, workDate: { gte: trendStart, lt: end } },
      select: {
        id: true,
        workDate: true,
        workedMinutes: true,
        overtimeMinutes: true,
        loginAt: true,
        logoutAt: true,
        workerId: true,
        worker: {
          select: {
            vendor: { select: { name: true } },
            designation: { select: { name: true } },
          },
        },
      },
      take: 50000,
    });

    // Man-hours honour the same day-wide ceiling as the row reports, so the
    // headline total agrees with the detail rows behind it.
    const capped = ReportsService.wantsCap(params)
      ? ReportsService.capByDay(sessions)
      : new Map<string, CappedSession>();
    const days: string[] = [];
    for (let t = trendStart.getTime(); t < end.getTime(); t += dayMs) days.push(iso(new Date(t)));
    const trendIndex = new Map(days.map((d, i) => [d, i]));
    const trend = new Array<number>(days.length).fill(0);

    const byTrade = new Map<string, number>();
    const byVendor = new Map<string, number>();
    const uniqueWorkers = new Set<string>();
    let manMinutes = 0;
    let inPeriod = 0;

    for (const s of sessions) {
      const key = iso(s.workDate);
      const i = trendIndex.get(key);
      if (i !== undefined) trend[i] += 1;
      // Everything below is period-only; the run-up days are trend context.
      if (s.workDate < start) continue;
      inPeriod += 1;
      uniqueWorkers.add(s.workerId);
      manMinutes += (capped.get(s.id) ?? s).workedMinutes ?? 0;
      const trade = s.worker.designation?.name?.trim() || 'No designation';
      const vendor = s.worker.vendor?.name?.trim() || 'No vendor';
      byTrade.set(trade, (byTrade.get(trade) ?? 0) + 1);
      byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + 1);
    }

    const rank = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    // Days that fall inside the period, for the average — a month report run
    // mid-month should not divide by days that have not happened.
    const periodDays = days.filter((d) => d >= iso(start)).length || 1;

    return {
      reportType: type,
      periodLabel: this.periodLabel(type, start, end),
      days,
      trend,
      // Which trend days belong to the period itself (the rest are run-up).
      periodFrom: iso(start),
      totalManDays: inPeriod,
      uniqueWorkers: uniqueWorkers.size,
      manHours: Math.round((manMinutes / 60) * 10) / 10,
      activeTrades: byTrade.size,
      avgPerDay: Math.round((inPeriod / periodDays) * 10) / 10,
      peak: trend.length ? Math.max(...trend) : 0,
      byTrade: rank(byTrade),
      byVendor: rank(byVendor),
    };
  }

  /** Half-open [start, end) UTC day range for a period-based report type. */
  private periodRange(type: ReportType, params: Record<string, unknown>) {
    const dayMs = 86_400_000;
    const midnight = (v: string) => new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
    if (type === ReportType.DAILY) {
      const start = params.date
        ? midnight(String(params.date))
        : midnight(new Date().toISOString());
      return { start, end: new Date(start.getTime() + dayMs) };
    }
    if (type === ReportType.WEEKLY) {
      const start = params.weekStart
        ? midnight(String(params.weekStart))
        : midnight(new Date().toISOString());
      return { start, end: new Date(start.getTime() + 7 * dayMs) };
    }
    const now = new Date();
    const [y, m] = params.month
      ? String(params.month)
          .split('-')
          .map((n) => parseInt(n, 10))
      : [now.getUTCFullYear(), now.getUTCMonth() + 1];
    return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
  }

  private periodLabel(type: ReportType, start: Date, end: Date): string {
    const fmt = (d: Date) =>
      d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    if (type === ReportType.DAILY) return fmt(start);
    if (type === ReportType.MONTHLY) {
      return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    }
    return `${fmt(start)} — ${fmt(new Date(end.getTime() - 86_400_000))}`;
  }

  private async buildRows(
    user: AuthUser,
    type: ReportType,
    params: Record<string, unknown>,
    sensitive = false,
  ): Promise<{ headers: string[]; rows: (string | number | null)[][] }> {
    const org = user.organizationId;

    if (type === ReportType.CORRECTION) {
      const [reqs, orgRow] = await Promise.all([
        this.prisma.correctionRequest.findMany({
          where: { organizationId: org },
          include: { worker: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.organization.findUnique({ where: { id: org } }),
      ]);
      const tz = orgRow?.timezone || 'Asia/Kolkata';
      return {
        headers: ['Date', 'Worker', 'Type', 'Reason', 'Status', 'Reviewed At'],
        rows: reqs.map((r) => [
          r.workDate.toISOString().slice(0, 10),
          r.worker.fullName,
          r.type,
          r.reason,
          r.status,
          r.reviewedAt ? this.formatStamp(r.reviewedAt, tz) : null,
        ]),
      };
    }

    const where = this.sessionWhere(org, type, params);

    // Workers always come first, then staff, then visitors. Within a category,
    // optional vendor-wise sorting (params.sortBy === 'vendor'), then chronology.
    const vendorSort = params.sortBy === 'vendor';
    const sessions = await this.prisma.attendanceSession.findMany({
      where,
      include: { worker: { include: { vendor: true, designation: true } }, site: true },
      orderBy: [
        { worker: { category: 'asc' } },
        ...(vendorSort
          ? [
              {
                worker: { vendor: { name: 'asc' } },
              } as Prisma.AttendanceSessionOrderByWithRelationInput,
            ]
          : []),
        { workDate: 'asc' },
        { loginAt: 'asc' },
      ],
    });

    const sensitiveHeaders = [
      "Father's Name",
      'DOB',
      'Gender',
      'Blood Group',
      'Mobile',
      'Aadhaar',
      'PAN',
      'Bank Name',
      'Bank Account',
      'IFSC',
      'PF No',
      'ESI No',
      'Emergency Contact',
      'Emergency Number',
      'Join Date',
    ];
    const headers = [
      'Date',
      'Worker Code',
      'Worker',
      'Category',
      'Designation',
      'Vendor',
      'Site',
      'Login Date & Time',
      'Logout Date & Time',
      'Worked (h)',
      'Overtime (h)',
      'Late (min)',
      'State',
      ...(sensitive ? sensitiveHeaders : []),
    ];

    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    const stamp = (d: Date | null, tz: string) => (d ? this.formatStamp(d, tz) : null);
    const sensitiveCells = (w: (typeof sessions)[number]['worker']): (string | number | null)[] => [
      w.fatherName ?? '',
      day(w.dateOfBirth),
      w.gender ?? '',
      w.bloodGroup ?? '',
      w.mobileNumber ?? '',
      this.decryptOrBlank(w.aadhaarCiphertext),
      this.decryptOrBlank(w.panCiphertext),
      w.bankName ?? '',
      this.decryptOrBlank(w.bankAccountCiphertext) || (w.bankAccountNumber ?? ''),
      w.ifscCode ?? '',
      w.pfNumber ?? '',
      w.esiNumber ?? '',
      w.emergencyContactName ?? '',
      w.emergencyContactNumber ?? '',
      day(w.joinDate),
    ];

    // Compliance mode: a day that ran past the statutory 9 hours — a missed
    // logout, or shifts that add up past it — is trimmed back before the rows
    // are written. Capped across the worker's whole day, so the two rows of a
    // split shift can never sum to more than the ceiling.
    const capped = ReportsService.wantsCap(params)
      ? ReportsService.capByDay(sessions)
      : new Map<string, CappedSession>();

    const toRow = (s: (typeof sessions)[number]): (string | number | null)[] => {
      const t = capped.get(s.id) ?? s;
      return [
        s.workDate.toISOString().slice(0, 10),
        s.worker.workerCode,
        s.worker.fullName,
        s.worker.category,
        s.worker.designation?.name ?? '',
        s.worker.vendor?.name ?? '',
        s.site.name,
        // Date *and* time, in the site's own timezone: a night shift logs out on
        // the day after the one the row is filed under, and a bare "08:00" next
        // to a work date of the 5th reads as a mistake rather than a night shift.
        stamp(s.loginAt, s.site.timezone),
        stamp(t.logoutAt, s.site.timezone),
        minutesToHours(t.workedMinutes),
        minutesToHours(t.overtimeMinutes),
        s.lateMinutes ?? 0,
        s.state,
        ...(sensitive ? sensitiveCells(s.worker) : []),
      ];
    };

    // Insert a section divider row when the report spans multiple categories
    // (e.g. "===== WORKERS =====" then "===== STAFF =====").
    const categories = new Set(sessions.map((s) => s.worker.category));
    if (categories.size <= 1) {
      return { headers, rows: sessions.map(toRow) };
    }

    const sectionLabel: Record<string, string> = {
      WORKER: '===== WORKERS =====',
      STAFF: '===== STAFF =====',
      VISITOR: '===== VISITORS =====',
    };
    const rows: (string | number | null)[][] = [];
    let current: string | null = null;
    for (const s of sessions) {
      if (s.worker.category !== current) {
        current = s.worker.category;
        rows.push([sectionLabel[current] ?? current, ...Array(headers.length - 1).fill('')]);
      }
      rows.push(toRow(s));
    }
    return { headers, rows };
  }

  /**
   * Build the attendance grid: every worker as a row, with IN/Out times per day.
   * Accepts a single `month` (YYYY-MM, whole month) or a `from`/`to` date range —
   * which may be a few days or span several months (each month becomes a block,
   * clamped to the selected days).
   */
  private async buildAttendanceSheet(
    user: AuthUser,
    params: Record<string, unknown>,
    sensitive = false,
  ) {
    const orgId = user.organizationId;
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    const tz = org?.timezone || 'Asia/Kolkata';

    // Resolve the list of month blocks to render.
    const monthName = (y: number, m: number) =>
      new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(Date.UTC(y, m - 1, 1)),
      );
    const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    const range = (a: number, b: number) => {
      const out: number[] = [];
      for (let d = a; d <= b; d++) out.push(d);
      return out;
    };
    // Each block is a (possibly partial) month with the exact day numbers to show.
    const blocks: { year: number; month: number; label: string; days: number[] }[] = [];
    if (params.month) {
      const [y, m] = String(params.month)
        .split('-')
        .map((n) => parseInt(n, 10));
      blocks.push({ year: y, month: m, label: monthName(y, m), days: range(1, daysInMonth(y, m)) });
    } else {
      let from = params.from ? new Date(String(params.from)) : new Date();
      let to = params.to ? new Date(String(params.to)) : from;
      if (from > to) [from, to] = [to, from]; // tolerate a reversed range
      const startY = from.getUTCFullYear();
      const startM = from.getUTCMonth() + 1;
      const startD = from.getUTCDate();
      const endY = to.getUTCFullYear();
      const endM = to.getUTCMonth() + 1;
      const endD = to.getUTCDate();
      let y = startY;
      let m = startM;
      while ((y < endY || (y === endY && m <= endM)) && blocks.length < 24) {
        const firstDay = y === startY && m === startM ? startD : 1;
        const lastDay = y === endY && m === endM ? endD : daysInMonth(y, m);
        const days = range(firstDay, lastDay);
        if (days.length) blocks.push({ year: y, month: m, label: monthName(y, m), days });
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
    if (blocks.length === 0) {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth() + 1;
      blocks.push({ year: y, month: m, label: monthName(y, m), days: range(1, daysInMonth(y, m)) });
    }
    const firstBlock = blocks[0];
    const lastBlock = blocks[blocks.length - 1];
    const periodStart = new Date(
      Date.UTC(firstBlock.year, firstBlock.month - 1, firstBlock.days[0]),
    );
    const periodEnd = new Date(
      Date.UTC(lastBlock.year, lastBlock.month - 1, lastBlock.days[lastBlock.days.length - 1] + 1),
    ); // exclusive

    // Workers (the workforce — exclude visitors), with optional vendor/site filters.
    const where: Prisma.WorkerWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      // Default to the workforce (workers + staff); a Person-type filter narrows it.
      category: params.category
        ? (String(params.category) as Prisma.WorkerWhereInput['category'])
        : { in: ['WORKER', 'STAFF'] },
    };
    if (params.vendorId) where.vendorId = String(params.vendorId);
    if (params.siteId) {
      where.assignments = { some: { siteId: String(params.siteId), endDate: null } };
    }
    const workers = await this.prisma.worker.findMany({
      where,
      include: { vendor: true },
      orderBy: [{ category: 'asc' }, { fullName: 'asc' }],
    });

    // Every shift, per worker per day — not just the first IN and last Out.
    // Collapsing a split shift to its outer bounds would read as one unbroken
    // stretch and overstate the day (10:00-12:00 plus 13:00-15:00 is four hours
    // worked, not five), so each shift keeps its own IN/Out and lands in its
    // own block of the sheet.
    const sessions = await this.prisma.attendanceSession.findMany({
      where: {
        organizationId: orgId,
        workerId: { in: workers.map((w) => w.id) },
        workDate: { gte: periodStart, lt: periodEnd },
      },
      select: {
        id: true,
        workerId: true,
        workDate: true,
        loginAt: true,
        logoutAt: true,
        workedMinutes: true,
        overtimeMinutes: true,
      },
    });

    // The sheet prints clock times rather than an hours column, so the cap acts
    // on the stamps themselves — the final Out of an over-long day is pulled
    // back until the day's shifts total no more than the ceiling.
    const capped = ReportsService.wantsCap(params)
      ? ReportsService.capByDay(sessions)
      : new Map<string, CappedSession>();

    const byWorkerDay = new Map<string, Map<string, { inAt: Date | null; outAt: Date | null }[]>>();
    for (const s of sessions) {
      const dkey = s.workDate.toISOString().slice(0, 10);
      let wm = byWorkerDay.get(s.workerId);
      if (!wm) {
        wm = new Map();
        byWorkerDay.set(s.workerId, wm);
      }
      const shifts = wm.get(dkey) ?? [];
      shifts.push({ inAt: s.loginAt, outAt: (capped.get(s.id) ?? s).logoutAt });
      wm.set(dkey, shifts);
    }
    // Chronological within each day, so shift 1 is the morning one. A session
    // with no login stamp sorts last rather than jumping the queue.
    for (const wm of byWorkerDay.values()) {
      for (const shifts of wm.values()) {
        shifts.sort((a, b) => (a.inAt?.getTime() ?? Infinity) - (b.inAt?.getTime() ?? Infinity));
      }
    }

    const timeFmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    });
    const fmtTime = (d: Date | null) => (d ? timeFmt.format(d) : null);
    // The day a stamp fell on in site time, to tell an overnight Out from a
    // same-day one.
    const dayFmt = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: tz,
    });
    /**
     * The Out cell of a day column. A night shift ends the next morning, so its
     * out time sits in the column of the day the shift *started* — "08:00" there
     * would read as an in time. "+1" says it belongs to the following day.
     */
    const shortDay = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      timeZone: tz,
    });
    const fmtOut = (d: Date | null, dkey: string): Cell => {
      if (!d) return null;
      if (dayFmt.format(d) === dkey) return fmtTime(d);
      return { value: fmtTime(d) as string, day: shortDay.format(d), night: true };
    };

    /**
     * A row that holds a night shift is filled from end to end — the serial
     * number through to the out time, blank days included, so the band is
     * unbroken. Filling the out time alone reads as if the two halves of one
     * shift were unrelated, which is the confusion the colour is there to clear
     * up in the first place.
     */
    const markNightRow = (cells: Cell[]): Cell[] =>
      cells.some(isNightTime)
        ? cells.map((c) =>
            isNightTime(c) ? c : { value: c == null ? '' : String(c), night: true },
          )
        : cells;
    const dateFmt = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const fmtDate = (d: Date | null) => (d ? dateFmt.format(d) : '');
    const sex = (g: string | null) => (g === 'M' ? 'Male' : g === 'F' ? 'Female' : (g ?? ''));

    // Extra joining/sensitive columns appended to the info block for the full
    // profile report (demographics like Father's Name/DOB are already present).
    const sensitiveInfoHeaders = [
      'Blood Group',
      'Aadhaar',
      'PAN',
      'Bank Name',
      'Bank Account',
      'IFSC',
      'PF No',
      'ESI No',
      'Emergency Contact',
      'Emergency Number',
    ];
    const infoHeaders = [
      'SL No',
      'Workers Name',
      "Father's Name",
      'EMP - ID NO',
      'Contractor',
      'Nature of Contractor',
      'DOB',
      'Date of Joining',
      'Gender',
      'Mobile number',
      ...(sensitive ? sensitiveInfoHeaders : []),
    ];

    const months: AttSheetMonth[] = blocks.map((b) => ({ label: b.label, days: b.days }));

    // PRESENCE mode: one column per day with P (present) / A (absent), blank for
    // days the worker wasn't employed. TIMES mode (default): IN/Out per day.
    const presence = String(params.attendanceMode ?? '').toUpperCase() === 'PRESENCE';
    const dkeyOf = (w: { joinDate: Date | null; exitDate: Date | null }) => ({
      join: w.joinDate ? w.joinDate.toISOString().slice(0, 10) : null,
      exit: w.exitDate ? w.exitDate.toISOString().slice(0, 10) : null,
    });

    const infoCells = (w: (typeof workers)[number], serial: number): (string | number | null)[] => [
      serial,
      w.fullName,
      w.fatherName ?? '',
      w.workerCode,
      w.vendor?.name ?? '',
      w.natureOfContractor ?? '',
      fmtDate(w.dateOfBirth),
      fmtDate(w.joinDate),
      sex(w.gender),
      w.mobileNumber ?? '',
      ...(sensitive
        ? [
            w.bloodGroup ?? '',
            this.decryptOrBlank(w.aadhaarCiphertext),
            this.decryptOrBlank(w.panCiphertext),
            w.bankName ?? '',
            this.decryptOrBlank(w.bankAccountCiphertext) || (w.bankAccountNumber ?? ''),
            w.ifscCode ?? '',
            w.pfNumber ?? '',
            w.esiNumber ?? '',
            w.emergencyContactName ?? '',
            w.emergencyContactNumber ?? '',
          ]
        : []),
    ];

    /** Every day key in the sheet, in column order. */
    const dayKeys: string[] = [];
    for (const b of blocks) {
      for (const day of b.days) {
        dayKeys.push(
          `${b.year}-${String(b.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        );
      }
    }

    /** One worker's cells for a given shift of the day (0 = their first). */
    const shiftCells = (w: (typeof workers)[number], shiftIndex: number): Cell[] => {
      const wm = byWorkerDay.get(w.id);
      const emp = dkeyOf(w);
      const cells: Cell[] = [];
      for (const dkey of dayKeys) {
        const shift = wm?.get(dkey)?.[shiftIndex];
        if (presence) {
          const employed = (!emp.join || dkey >= emp.join) && (!emp.exit || dkey <= emp.exit);
          cells.push(employed ? (shift ? 'P' : 'A') : '');
        } else {
          cells.push(fmtTime(shift?.inAt ?? null));
          cells.push(fmtOut(shift?.outAt ?? null, dkey));
        }
      }
      return markNightRow(cells);
    };

    // How many times the busiest worker-day was tapped. PRESENCE mode answers
    // "was he here", which a second tap-in does not change, so it stays a
    // single block however many shifts a day held.
    const maxShifts = presence
      ? 1
      : (() => {
          // Counted in a loop rather than spread into Math.max — a long period
          // over a large workforce is more worker-days than an argument list
          // can hold.
          let most = 1;
          for (const wm of byWorkerDay.values()) {
            for (const shifts of wm.values()) most = Math.max(most, shifts.length);
          }
          return most;
        })();

    // One block per shift: the first holds every worker, and each block below
    // it holds only the workers who tapped in that many times on some day in
    // the period, blank on the days they did not. Headings appear only once
    // there is a second block to tell apart from the first.
    const SHIFT_HEADING = [
      'FIRST LOGIN OF THE DAY',
      'SECOND LOGIN OF THE DAY',
      'THIRD LOGIN OF THE DAY',
      'FOURTH LOGIN OF THE DAY',
    ];
    const headingFor = (i: number) => SHIFT_HEADING[i] ?? `LOGIN ${i + 1} OF THE DAY`;

    const rows: AttSheetRow[] = [];
    for (let shiftIndex = 0; shiftIndex < maxShifts; shiftIndex++) {
      const inBlock =
        shiftIndex === 0
          ? workers
          : workers.filter((w) => {
              const wm = byWorkerDay.get(w.id);
              return wm ? [...wm.values()].some((s) => s.length > shiftIndex) : false;
            });
      if (inBlock.length === 0) continue;
      if (maxShifts > 1) {
        rows.push({ heading: headingFor(shiftIndex), info: [], cells: [] });
      }
      // Serial numbers restart in each block — they number the rows of that
      // block, not the workforce.
      inBlock.forEach((w, idx) => {
        const cells = shiftCells(w, shiftIndex);
        rows.push({
          info: infoCells(w, idx + 1),
          cells,
          // The worker's own columns are filled too, so the band runs from the
          // serial number to the out time. They keep their own types — a serial
          // number stays a number in the workbook.
          night: cells.some(isNightTime),
        });
      });
    }

    // Flat representation for the preview table and CSV/PDF exports.
    const flatHeaders = [...infoHeaders];
    for (const b of blocks) {
      for (const day of b.days) {
        if (presence) {
          flatHeaders.push(`${b.label} ${day}`);
        } else {
          flatHeaders.push(`${b.label} ${day} IN`);
          flatHeaders.push(`${b.label} ${day} Out`);
        }
      }
    }
    // A heading spans the sheet in XLSX; flat formats carry it in the first
    // cell with the rest of the row blank, matching the section dividers the
    // other reports already emit.
    const flatRows = rows.map((r) => {
      if (r.heading) {
        return [
          `===== ${r.heading} =====`,
          ...Array<string>(Math.max(0, flatHeaders.length - 1)).fill(''),
        ];
      }
      // The flat formats have no row-level styling to hang the fill on, so a
      // night row's worker columns carry it cell by cell like the times do.
      const info: Cell[] = r.night
        ? r.info.map((c) => ({ value: c == null ? '' : String(c), night: true as const }))
        : r.info;
      return [...info, ...r.cells];
    });

    return { months, infoHeaders, rows, flatHeaders, flatRows, presence };
  }
}
