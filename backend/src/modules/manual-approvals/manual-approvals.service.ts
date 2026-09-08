import { Injectable } from '@nestjs/common';
import { ManualApprovalStatus, TapSource } from '../../common/enums';
import { DateTime } from 'luxon';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { D1Service } from '../../infra/d1/d1.service';
import { chunked } from '../../infra/d1/chunked';
import {
  attendanceSessions,
  attendanceTaps,
  designations,
  manualAttendanceRequests,
  shifts,
  siteSettings,
  sites,
  users,
  vendors,
  workers,
} from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { businessDate, minutesOfDay, textToTimeOfDay } from '../../common/time/time.util';
import { computeWorkHours, ShiftConfig } from '../attendance/engine/work-hours.engine';
import { capitalise, describeMovement } from '../attendance/engine/movement-words';
import { ReviewManualDto } from './dto/manual-approval.dto';

/**
 * What the review screens show for one hand-typed punch.
 *
 * Prisma's nested `select` came back nested; the join comes back flat, so the
 * columns and the reshaping sit together and callers see what they always did.
 */
const REQUEST_COLUMNS = {
  id: manualAttendanceRequests.id,
  siteId: manualAttendanceRequests.siteId,
  workerId: manualAttendanceRequests.workerId,
  tapType: manualAttendanceRequests.tapType,
  sessionId: manualAttendanceRequests.sessionId,
  recordedAt: manualAttendanceRequests.recordedAt,
  reason: manualAttendanceRequests.reason,
  status: manualAttendanceRequests.status,
  reviewedBy: manualAttendanceRequests.reviewedBy,
  reviewedAt: manualAttendanceRequests.reviewedAt,
  reviewNotes: manualAttendanceRequests.reviewNotes,
  createdAt: manualAttendanceRequests.createdAt,
  workerFullName: workers.fullName,
  workerCode: workers.workerCode,
  workerPhotoUrl: workers.photoUrl,
  workerCategory: workers.category,
  designationName: designations.name,
  vendorName: vendors.name,
  siteName: sites.name,
  siteTimezone: sites.timezone,
  tapRowId: attendanceTaps.id,
  tapDeviceId: attendanceTaps.deviceId,
  tapLatitude: attendanceTaps.latitude,
  tapLongitude: attendanceTaps.longitude,
} as const;

/** One flat join row back in the nested shape the review screens read. */
function nestRequest(r: Record<string, unknown>) {
  return {
    id: r.id as string,
    siteId: r.siteId as string,
    workerId: r.workerId as string,
    tapType: r.tapType as 'LOGIN' | 'LOGOUT',
    sessionId: r.sessionId as string | null,
    recordedAt: r.recordedAt as Date,
    reason: r.reason as string | null,
    status: r.status as ManualApprovalStatus,
    reviewedBy: r.reviewedBy as string | null,
    reviewedAt: r.reviewedAt as Date | null,
    reviewNotes: r.reviewNotes as string | null,
    createdAt: r.createdAt as Date,
    worker: {
      id: r.workerId as string,
      fullName: r.workerFullName as string,
      workerCode: r.workerCode as string,
      photoUrl: r.workerPhotoUrl as string | null,
      category: r.workerCategory as string,
      designation: r.designationName ? { name: r.designationName as string } : null,
      vendor: r.vendorName ? { name: r.vendorName as string } : null,
    },
    site: {
      id: r.siteId as string,
      name: r.siteName as string,
      timezone: r.siteTimezone as string,
    },
    tap: r.tapRowId
      ? {
          id: r.tapRowId as string,
          deviceId: r.tapDeviceId as string | null,
          latitude: r.tapLatitude as number | null,
          longitude: r.tapLongitude as number | null,
        }
      : null,
  };
}

/**
 * Accept or decline the punches a watchman typed in by hand.
 *
 * A badge scan is evidence: a card was physically at the gate. A worker code
 * typed into the app is not — it is one person's word, and it is the only route
 * into attendance that nothing checks. So a manual entry files a request instead
 * of moving attendance, and this service is the only place that lets it through.
 *
 * Accepting is what writes the session: a LOGIN materialises one at the time the
 * watchman recorded, a LOGOUT closes the session it was filed against. Declining
 * writes nothing at all — the tap stays on file as evidence that someone tried,
 * and attendance is exactly as it was.
 *
 * Held on MANUAL_ATTENDANCE_REVIEW, which the Safety Officer, Site Admin and
 * Super Admin have and the watchman does not — so nobody can wave through their
 * own entry.
 */
@Injectable()
export class ManualApprovalsService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  /** Sites this user may review for; SUPER_ADMIN is unscoped. */
  private scope(user: AuthUser): SQL[] {
    return user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
      ? [inArray(manualAttendanceRequests.siteId, user.siteScopes)]
      : [];
  }

  /** The join every read of a request shares. */
  private requestQuery() {
    return this.d1.db
      .select(REQUEST_COLUMNS)
      .from(manualAttendanceRequests)
      .innerJoin(workers, eq(workers.id, manualAttendanceRequests.workerId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .innerJoin(sites, eq(sites.id, manualAttendanceRequests.siteId))
      // Left: a request whose tap was purged still has to be reviewable.
      .leftJoin(attendanceTaps, eq(attendanceTaps.id, manualAttendanceRequests.tapId));
  }

  /** One request by id, in the shape the screens read. */
  private async findRequest(id: string) {
    const [row] = await this.requestQuery()
      .where(eq(manualAttendanceRequests.id, id))
      .limit(1);
    return row ? nestRequest(row) : null;
  }

  /** The queue. Defaults to what still needs a decision. */
  async list(user: AuthUser, status?: ManualApprovalStatus, siteId?: string) {
    const rows = (
      await this.requestQuery()
        .where(
          and(
            eq(manualAttendanceRequests.organizationId, user.organizationId),
            eq(manualAttendanceRequests.status, status ?? 'PENDING'),
            ...this.scope(user),
            ...(siteId && siteId !== 'all' ? [eq(manualAttendanceRequests.siteId, siteId)] : []),
          ),
        )
        // Oldest first: a man waiting to be put on the register has been waiting
        // longest, and the fire headcount is wrong until he is.
        .orderBy(asc(manualAttendanceRequests.recordedAt))
        .limit(500)
    ).map(nestRequest);

    const reviewerIds = [...new Set(rows.map((r) => r.reviewedBy).filter(Boolean) as string[])];
    const reviewers = await chunked(reviewerIds, (ids) =>
      this.d1.db
        .select({ id: users.id, fullName: users.fullName })
        .from(users)
        .where(inArray(users.id, ids)),
    );
    const nameOf = new Map(reviewers.map((u) => [u.id, u.fullName]));

    return rows.map((r) => ({
      ...r,
      reviewedByName: r.reviewedBy ? (nameOf.get(r.reviewedBy) ?? null) : null,
    }));
  }

  /** How many are waiting — drives the badge on both apps' nav. */
  async pendingCount(user: AuthUser) {
    const [row] = await this.d1.db
      .select({ count: sql<number>`count(*)`.as('count') })
      .from(manualAttendanceRequests)
      .where(
        and(
          eq(manualAttendanceRequests.organizationId, user.organizationId),
          eq(manualAttendanceRequests.status, 'PENDING'),
          ...this.scope(user),
        ),
      );
    return { pending: Number(row?.count ?? 0) };
  }

  private async loadPending(user: AuthUser, id: string) {
    const [row] = await this.requestQuery()
      .where(
        and(
          eq(manualAttendanceRequests.id, id),
          eq(manualAttendanceRequests.organizationId, user.organizationId),
          ...this.scope(user),
        ),
      )
      .limit(1);
    if (!row) throw Errors.notFound('Manual attendance request');
    const request = nestRequest(row);
    if (request.status !== 'PENDING') {
      throw Errors.businessRule(
        `This entry was already ${request.status.toLowerCase()} and cannot be reviewed again.`,
      );
    }
    // The site's default shift, which an approved LOGIN stamps on its session.
    // Read here rather than joined into REQUEST_COLUMNS: only approval needs it,
    // and the queue reads that join five hundred rows at a time.
    const [settings] = await this.d1.db
      .select({ defaultShiftId: siteSettings.defaultShiftId })
      .from(siteSettings)
      .where(eq(siteSettings.siteId, request.siteId))
      .limit(1);
    return {
      ...request,
      organizationId: user.organizationId,
      tapId: row.tapRowId as string | null,
      site: { ...request.site, settings: settings ?? null },
    };
  }

  /**
   * What kind of tap this was, for the "already logged out by ..." sentence.
   *
   * Null in, null out: a session whose tap has been purged still has to produce
   * a readable message, and describeMovement handles the null.
   */
  private async tapDescription(tapId: string | null) {
    if (!tapId) return null;
    const [tap] = await this.d1.db
      .select({
        tapSource: attendanceTaps.tapSource,
        isManualBackup: attendanceTaps.isManualBackup,
      })
      .from(attendanceTaps)
      .where(eq(attendanceTaps.id, tapId))
      .limit(1);
    // Text on SQLite where Prisma had an enum; the values stored are the
    // enum's own, so this narrows rather than changes anything.
    return tap ? { ...tap, tapSource: tap.tapSource as TapSource } : null;
  }

  /**
   * The distance between two instants, said the way a person would say it.
   *
   * "29 seconds after this entry was typed" is the whole explanation for why a
   * queue entry is stale — the watchman typed it and the man scanned a moment
   * later. A bare timestamp leaves the reviewer to work that out themselves.
   */
  private gapInWords(from: Date, to: Date): string {
    const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
    if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minutes` : ''}`;
  }

  private toShiftConfig(shift: {
    startTime: string;
    endTime: string;
    isOvernight: boolean;
    lateGraceMinutes: number;
    earlyGraceMinutes: number;
    otThresholdMinutes: number;
  }): ShiftConfig {
    return {
      // 'HH:MM:SS' text on SQLite, read through the same converter the sites
      // module uses so both give the same minute.
      startTimeMinutes: minutesOfDay(textToTimeOfDay(shift.startTime)),
      endTimeMinutes: minutesOfDay(textToTimeOfDay(shift.endTime)),
      isOvernight: shift.isOvernight,
      lateGraceMinutes: shift.lateGraceMinutes,
      earlyGraceMinutes: shift.earlyGraceMinutes,
      otThresholdMinutes: shift.otThresholdMinutes,
    };
  }

  /**
   * ACCEPT — the only path that turns a hand-typed punch into attendance.
   *
   * The world may have moved since the entry was filed: the worker may have
   * turned up with their badge and scanned in properly, or scanned out. Those
   * cases are refused with a sentence saying what happened, rather than forced
   * through — the reviewer can then decline the stale entry, which is the
   * honest outcome.
   */
  async approve(user: AuthUser, id: string, dto: ReviewManualDto) {
    const request = await this.loadPending(user, id);
    const tz = request.site.timezone;
    // These sentences end up in front of a site admin, so times are site-local
    // and written out — an ISO string tells them nothing about their own day.
    const localTime = (at: Date) =>
      DateTime.fromJSDate(at, { zone: tz }).toFormat('d LLL yyyy, h:mm a');

    // D1 has no interactive transaction, so the decision is made from reads and
    // then committed as one batch. The batch also carries the request update,
    // which used to sit outside the transaction — a crash between the two left
    // an approved session with a request still marked PENDING.
    const applied = await (async () => {
      const reviewedAt = new Date();
      /** The request row's own update, identical on both branches. */
      const closeRequest = (sessionId: string) =>
        this.d1.db
          .update(manualAttendanceRequests)
          .set({
            status: 'APPROVED',
            reviewedBy: user.userId,
            reviewedAt,
            reviewNotes: dto.reviewNotes ?? null,
            sessionId,
            updatedAt: reviewedAt,
          })
          .where(eq(manualAttendanceRequests.id, id));

      if (request.tapType === 'LOGIN') {
        // Only one open session per worker (a DB constraint). If they scanned in
        // for real in the meantime, that record is the true one.
        const [open] = await this.d1.db
          .select({
            id: attendanceSessions.id,
            loginAt: attendanceSessions.loginAt,
            loginTapId: attendanceSessions.loginTapId,
            siteName: sites.name,
          })
          .from(attendanceSessions)
          .leftJoin(sites, eq(sites.id, attendanceSessions.siteId))
          .where(
            and(
              eq(attendanceSessions.workerId, request.workerId),
              eq(attendanceSessions.state, 'OPEN'),
            ),
          )
          .limit(1);
        if (open) {
          const how = describeMovement(await this.tapDescription(open.loginTapId));
          throw Errors.conflict(
            `${request.worker.fullName} is already logged in at ${open.siteName}. ` +
              `${capitalise(how)} logged them in at ${localTime(open.loginAt)}, ` +
              'after this entry was typed. Their attendance is already recorded — decline this ' +
              'entry; accepting it would put them on site twice.',
          );
        }

        const sessionId = randomUUID();
        await this.d1.db.batch([
          this.d1.db.insert(attendanceSessions).values({
            id: sessionId,
            organizationId: request.organizationId,
            workerId: request.workerId,
            siteId: request.siteId,
            shiftId: request.site.settings?.defaultShiftId ?? null,
            workDate: businessDate(request.recordedAt, tz).toISOString().slice(0, 10),
            loginTapId: request.tapId,
            loginAt: request.recordedAt,
            state: 'OPEN',
            isCrossSite: false,
            createdAt: reviewedAt,
            updatedAt: reviewedAt,
          }),
          closeRequest(sessionId),
        ] as never);
        return { sessionId, before: null, after: { loginAt: request.recordedAt } };
      }

      // LOGOUT: close the session this entry was filed against, and only that
      // one — approving must not go hunting for a different session than the
      // watchman meant.
      if (!request.sessionId) {
        throw Errors.conflict(
          'This entry has no session to close. Decline it and fix the day in Fix Attendance.',
        );
      }
      const [sessionRow] = await this.d1.db
        .select({ session: attendanceSessions, shift: shifts })
        .from(attendanceSessions)
        .leftJoin(shifts, eq(shifts.id, attendanceSessions.shiftId))
        .where(eq(attendanceSessions.id, request.sessionId))
        .limit(1);
      if (!sessionRow) throw Errors.conflict('That attendance session no longer exists.');
      const session = sessionRow.session;
      if (session.state !== 'OPEN') {
        // Say what closed it and when. Nine times in ten it is the man's own
        // badge, seconds after the watchman gave up on the scanner and typed
        // the punch instead — and knowing that is what makes it obvious the
        // typed entry can be thrown away without losing anyone's hours.
        const how = describeMovement(
          await this.tapDescription(session.logoutTapId),
          session.closedReason,
        );
        throw Errors.conflict(
          `${request.worker.fullName} has already been logged out` +
            `${session.logoutAt ? ` at ${localTime(session.logoutAt)}` : ''} by ${how}` +
            `${
              session.logoutAt && session.logoutAt > request.recordedAt
                ? `, ${this.gapInWords(request.recordedAt, session.logoutAt)} after this entry ` +
                  'was typed'
                : ''
            }. That logout is already recorded, so there is nothing left to accept — decline ` +
            'this entry and their attendance stays exactly as it is.',
        );
      }
      if (request.recordedAt <= session.loginAt) {
        throw Errors.businessRule(
          'The recorded logout time is not after the login time. Decline this entry and ' +
            'correct the day in Fix Attendance.',
        );
      }

      const hours = computeWorkHours(
        session.loginAt,
        request.recordedAt,
        tz,
        sessionRow.shift ? this.toShiftConfig(sessionRow.shift) : undefined,
      );
      // Visitors are unpaid — the register records their movements, not overtime.
      if (request.worker.category === 'VISITOR') hours.overtimeMinutes = 0;
      const isCrossSite = request.siteId !== session.siteId;

      // Guarded on state: if a badge scan closed this session between the read
      // above and this write, the update matches nothing and the batch reports
      // no change, rather than stamping a second logout over the real one.
      const results = (await this.d1.db.batch([
        this.d1.db
          .update(attendanceSessions)
          .set({
            logoutTapId: request.tapId,
            logoutAt: request.recordedAt,
            state: 'CLOSED',
            workedMinutes: hours.workedMinutes,
            overtimeMinutes: hours.overtimeMinutes,
            lateMinutes: hours.lateMinutes,
            earlyLeaveMinutes: hours.earlyLeaveMinutes,
            logoutSiteId: isCrossSite ? request.siteId : null,
            isCrossSite,
            closedReason: 'MANUAL_APPROVED',
            updatedAt: reviewedAt,
          })
          .where(
            and(eq(attendanceSessions.id, session.id), eq(attendanceSessions.state, 'OPEN')),
          ),
        closeRequest(session.id),
      ] as never)) as unknown as { meta?: { changes?: number } }[];

      if ((results[0]?.meta?.changes ?? 0) === 0) {
        throw Errors.conflict(
          `${request.worker.fullName} was logged out while this entry was being accepted. ` +
            'Their attendance is already recorded — decline this entry.',
        );
      }

      return {
        sessionId: session.id,
        before: { state: 'OPEN', logoutAt: null },
        after: {
          state: 'CLOSED',
          logoutAt: request.recordedAt,
          workedMinutes: hours.workedMinutes,
        },
      };
    })();

    // Already written, as part of the batch that moved the attendance — read
    // back here in the shape the screens expect.
    const updated = await this.findRequest(id);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'MANUAL_ATTENDANCE_APPROVE',
      entityType: 'AttendanceSession',
      entityId: applied.sessionId,
      oldValue: applied.before,
      newValue: {
        ...applied.after,
        requestId: id,
        tapType: request.tapType,
        workerCode: request.worker.workerCode,
        enteredReason: request.reason,
      },
      reason: dto.reviewNotes,
    });

    return updated;
  }

  /**
   * DECLINE — the entry is refused and attendance is left exactly as it was.
   *
   * Nothing is deleted. The tap stays on file, and this row keeps who declined
   * it and why, so a punch that was refused is as traceable as one that was let
   * through.
   */
  async reject(user: AuthUser, id: string, dto: ReviewManualDto) {
    const request = await this.loadPending(user, id);

    const reviewedAt = new Date();
    await this.d1.db
      .update(manualAttendanceRequests)
      .set({
        status: 'REJECTED',
        reviewedBy: user.userId,
        reviewedAt,
        reviewNotes: dto.reviewNotes ?? null,
        updatedAt: reviewedAt,
      })
      .where(eq(manualAttendanceRequests.id, id));
    const updated = await this.findRequest(id);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'MANUAL_ATTENDANCE_REJECT',
      entityType: 'ManualAttendanceRequest',
      entityId: id,
      oldValue: {
        tapType: request.tapType,
        workerCode: request.worker.workerCode,
        workerName: request.worker.fullName,
        recordedAt: request.recordedAt,
        enteredReason: request.reason,
      },
      newValue: null,
      reason: dto.reviewNotes,
    });

    return updated;
  }
}
