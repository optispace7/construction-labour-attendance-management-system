import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { and, asc, eq, inArray, isNull, ne, notInArray, type SQL } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import {
  attendanceSessions,
  designations,
  organizations,
  shifts,
  sites,
  vendors,
  workers,
} from '../../infra/d1/schema.generated';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { businessDate } from '../../common/time/time.util';
import { computeWorkHours, ShiftConfig } from './engine/work-hours.engine';
import { BulkLogoutDto, BulkReopenDto, EditSessionDto } from './dto/session-admin.dto';

/**
 * A session as the fix panel shows it.
 *
 * Prisma's nested `select` came back nested; a join comes back flat, so the
 * columns and the reshaping sit together and every caller gets the same object
 * it always did.
 */
const SESSION_COLUMNS = {
  id: attendanceSessions.id,
  workerId: attendanceSessions.workerId,
  siteId: attendanceSessions.siteId,
  workDate: attendanceSessions.workDate,
  loginAt: attendanceSessions.loginAt,
  logoutAt: attendanceSessions.logoutAt,
  state: attendanceSessions.state,
  workedMinutes: attendanceSessions.workedMinutes,
  overtimeMinutes: attendanceSessions.overtimeMinutes,
  closedReason: attendanceSessions.closedReason,
  loginTapId: attendanceSessions.loginTapId,
  logoutTapId: attendanceSessions.logoutTapId,
  workerFullName: workers.fullName,
  workerCode: workers.workerCode,
  workerCategory: workers.category,
  designationName: designations.name,
  vendorName: vendors.name,
  siteName: sites.name,
  siteTimezone: sites.timezone,
} as const;

type SessionRow = {
  [K in keyof typeof SESSION_COLUMNS]: K extends 'workDate'
    ? string
    : K extends 'loginAt'
      ? Date
      : unknown;
};

/** One flat join row back in the nested shape the panel already reads. */
function nestSession<T extends Record<string, unknown>>(r: T) {
  return {
    id: r.id as string,
    workerId: r.workerId as string,
    siteId: r.siteId as string,
    workDate: r.workDate as string,
    loginAt: r.loginAt as Date,
    logoutAt: r.logoutAt as Date | null,
    state: r.state as string,
    workedMinutes: r.workedMinutes as number | null,
    overtimeMinutes: r.overtimeMinutes as number | null,
    closedReason: r.closedReason as string | null,
    loginTapId: r.loginTapId as string | null,
    logoutTapId: r.logoutTapId as string | null,
    worker: {
      id: r.workerId as string,
      fullName: r.workerFullName as string,
      workerCode: r.workerCode as string,
      category: r.workerCategory as string,
      designation: r.designationName ? { name: r.designationName as string } : null,
      vendor: r.vendorName ? { name: r.vendorName as string } : null,
    },
    site: r.siteId
      ? { id: r.siteId as string, name: r.siteName as string, timezone: r.siteTimezone as string }
      : null,
  };
}

/**
 * Super-admin repairs to attendance records.
 *
 * The watchmen scan people in and out, and the scans are sometimes wrong: the
 * wrong card gets tapped, someone re-scans after already leaving, or a shift
 * ends without anyone scanning out at all. This service is the escape hatch —
 * every method is gated on ATTENDANCE_EDIT (SUPER_ADMIN only) and writes an
 * audit row carrying the before/after and the operator's stated reason.
 *
 * Taps are deliberately left alone. They are the raw evidence of what the
 * scanner saw; only the derived session is corrected, so the audit trail can
 * still show the original scan next to the fix.
 */
@Injectable()
export class SessionAdminService {
  constructor(
    private readonly d1: D1Service,
    private readonly audit: AuditService,
  ) {}

  /** The session join every read here shares. */
  private sessionQuery() {
    return this.d1.db
      .select(SESSION_COLUMNS)
      .from(attendanceSessions)
      .innerJoin(workers, eq(workers.id, attendanceSessions.workerId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(sites, eq(sites.id, attendanceSessions.siteId));
  }

  /** Sites this user may touch; SUPER_ADMIN is unscoped. */
  private scope(user: AuthUser): SQL[] {
    return user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
      ? [inArray(attendanceSessions.siteId, user.siteScopes)]
      : [];
  }

  private async orgTimezone(organizationId: string): Promise<string> {
    const [org] = await this.d1.db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return org?.timezone ?? 'Asia/Kolkata';
  }

  /** Everyone recorded on a given work date — open and closed alike. */
  async day(user: AuthUser, date?: string, siteId?: string) {
    const tz = await this.orgTimezone(user.organizationId);
    const workDate = date ? new Date(`${date}T00:00:00.000Z`) : businessDate(new Date(), tz);
    if (Number.isNaN(workDate.getTime())) throw Errors.businessRule('Invalid date');

    const rows = await this.sessionQuery()
      .where(
        and(
          eq(attendanceSessions.organizationId, user.organizationId),
          eq(attendanceSessions.workDate, workDate.toISOString().slice(0, 10)),
          ...this.scope(user),
          ...(siteId && siteId !== 'all' ? [eq(attendanceSessions.siteId, siteId)] : []),
        ),
      )
      .orderBy(asc(workers.workerCode), asc(attendanceSessions.loginAt));
    const sessions = rows.map(nestSession);

    // A worker with two rows on one day is nearly always a mis-scan, so flag it
    // for the operator rather than making them spot it in a long table.
    const seen = new Map<string, number>();
    for (const s of sessions) seen.set(s.workerId, (seen.get(s.workerId) ?? 0) + 1);

    return {
      date: workDate.toISOString().slice(0, 10),
      timezone: tz,
      sessions: sessions.map((s) => ({ ...s, isDuplicate: (seen.get(s.workerId) ?? 0) > 1 })),
      openCount: sessions.filter((s) => s.state === 'OPEN').length,
    };
  }

  private async loadSession(user: AuthUser, id: string) {
    const [row] = await this.sessionQuery()
      .where(
        and(
          eq(attendanceSessions.id, id),
          eq(attendanceSessions.organizationId, user.organizationId),
          ...this.scope(user),
        ),
      )
      .limit(1);
    if (!row) throw Errors.notFound('Attendance session');
    return nestSession(row);
  }

  /** The shift's rules, so a corrected session is scored like a scanned one. */
  private async shiftConfig(shiftId: string | null): Promise<ShiftConfig | undefined> {
    if (!shiftId) return undefined;
    const [shift] = await this.d1.db
      .select()
      .from(shifts)
      .where(eq(shifts.id, shiftId))
      .limit(1);
    if (!shift) return undefined;
    // 'HH:MM:SS' text on SQLite, where Prisma handed over a Date.
    const mins = (t: string) => {
      const [h, m] = t.split(':').map((n) => parseInt(n, 10));
      return (h || 0) * 60 + (m || 0);
    };
    return {
      startTimeMinutes: mins(shift.startTime),
      endTimeMinutes: mins(shift.endTime),
      isOvernight: shift.isOvernight,
      lateGraceMinutes: shift.lateGraceMinutes,
      earlyGraceMinutes: shift.earlyGraceMinutes,
      otThresholdMinutes: shift.otThresholdMinutes,
    };
  }

  /**
   * Change who a session belongs to and/or when it started and ended.
   *
   * Both edits land in one call because they are usually one story: "that was
   * the wrong man, and he left at six" is a single correction to the operator
   * even though it touches two columns.
   */
  async edit(user: AuthUser, id: string, dto: EditSessionDto) {
    const session = await this.loadSession(user, id);
    const [full] = await this.d1.db
      .select({ shiftId: attendanceSessions.shiftId })
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, id))
      .limit(1);
    if (!full) throw Errors.notFound('Attendance session');

    const loginAt = dto.loginAt ? new Date(dto.loginAt) : session.loginAt;
    const logoutAt =
      dto.logoutAt === undefined ? session.logoutAt : dto.logoutAt ? new Date(dto.logoutAt) : null;

    if (Number.isNaN(loginAt.getTime())) throw Errors.businessRule('Invalid login time');
    if (logoutAt && Number.isNaN(logoutAt.getTime()))
      throw Errors.businessRule('Invalid logout time');
    if (logoutAt && logoutAt <= loginAt)
      throw Errors.businessRule('The logout time must be after the login time');

    let workerId = session.workerId;
    if (dto.workerId && dto.workerId !== session.workerId) {
      const [target] = await this.d1.db
        .select({ id: workers.id, fullName: workers.fullName, workerCode: workers.workerCode })
        .from(workers)
        .where(
          and(
            eq(workers.id, dto.workerId),
            eq(workers.organizationId, user.organizationId),
            isNull(workers.deletedAt),
          ),
        )
        .limit(1);
      if (!target) throw Errors.notFound('Worker');

      // One OPEN session per worker is a DB constraint; catching it here lets us
      // say which record is in the way instead of surfacing a Postgres error.
      const [clash] = await this.d1.db
        .select({
          id: attendanceSessions.id,
          state: attendanceSessions.state,
          loginAt: attendanceSessions.loginAt,
        })
        .from(attendanceSessions)
        .where(
          and(
            eq(attendanceSessions.workerId, target.id),
            eq(attendanceSessions.workDate, session.workDate),
            ne(attendanceSessions.id, session.id),
            ...(logoutAt === null ? [eq(attendanceSessions.state, 'OPEN')] : []),
          ),
        )
        .limit(1);
      if (clash) {
        throw Errors.businessRule(
          `${target.workerCode} ${target.fullName} already has ${
            clash.state === 'OPEN' ? 'an open session' : 'a session'
          } on this day. Delete or fix that record first.`,
        );
      }
      workerId = target.id;
    }

    // Clearing the out time puts the person back on site, and the DB allows only
    // one open session per worker — on any day, not just this one. Say which
    // record is in the way rather than letting Postgres raise the constraint.
    const reopening = logoutAt === null && session.state !== 'OPEN';
    if (reopening) {
      const [openElsewhere] = await this.d1.db
        .select({ workDate: attendanceSessions.workDate })
        .from(attendanceSessions)
        .where(
          and(
            eq(attendanceSessions.workerId, workerId),
            eq(attendanceSessions.state, 'OPEN'),
            ne(attendanceSessions.id, session.id),
          ),
        )
        .limit(1);
      if (openElsewhere) {
        throw Errors.businessRule(
          `This person is already shown as on site on ${openElsewhere.workDate}. ` +
            'Close that record first.',
        );
      }
    }

    const hours = logoutAt
      ? computeWorkHours(
          loginAt,
          logoutAt,
          session.site?.timezone ?? 'Asia/Kolkata',
          await this.shiftConfig(full.shiftId),
        )
      : null;

    await this.d1.db
      .update(attendanceSessions)
      .set({
        workerId,
        loginAt,
        logoutAt,
        state: logoutAt ? 'CLOSED' : 'OPEN',
        workedMinutes: hours?.workedMinutes ?? null,
        overtimeMinutes: hours?.overtimeMinutes ?? null,
        lateMinutes: hours?.lateMinutes ?? null,
        earlyLeaveMinutes: hours?.earlyLeaveMinutes ?? null,
        ...(logoutAt && session.state === 'OPEN' ? { closedReason: 'ADMIN_EDIT' } : {}),
        // A reopened session has not been closed by anything any more.
        ...(logoutAt === null ? { closedReason: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(attendanceSessions.id, id));
    // Read back through the same join, so the caller gets the nested shape
    // Prisma's `select` on the update returned.
    const updated = await this.loadSession(user, id);

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'ATTENDANCE_SESSION_EDIT',
      entityType: 'AttendanceSession',
      entityId: id,
      oldValue: {
        workerId: session.workerId,
        workerCode: session.worker.workerCode,
        loginAt: session.loginAt,
        logoutAt: session.logoutAt,
        state: session.state,
        workedMinutes: session.workedMinutes,
      },
      newValue: {
        workerId: updated.workerId,
        workerCode: updated.worker.workerCode,
        loginAt: updated.loginAt,
        logoutAt: updated.logoutAt,
        state: updated.state,
        workedMinutes: updated.workedMinutes,
      },
      reason: dto.reason,
    });

    return updated;
  }

  /**
   * Remove a session outright — for the person who was never on site, or the
   * phantom row a duplicate scan created.
   */
  async remove(user: AuthUser, id: string, reason: string) {
    const session = await this.loadSession(user, id);

    await this.d1.db.delete(attendanceSessions).where(eq(attendanceSessions.id, id));

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'ATTENDANCE_SESSION_DELETE',
      entityType: 'AttendanceSession',
      entityId: id,
      oldValue: {
        workerId: session.workerId,
        workerCode: session.worker.workerCode,
        workerName: session.worker.fullName,
        workDate: session.workDate,
        loginAt: session.loginAt,
        logoutAt: session.logoutAt,
        state: session.state,
      },
      newValue: null,
      reason,
    });

    return { deleted: true, id };
  }

  /**
   * Close everyone still open on a day at one chosen clock time — the end-of-
   * shift sweep for when the gate closes and nobody scanned out.
   *
   * Sessions that started *after* the chosen time can't take it without going
   * negative, so they are reported back as skipped rather than failing the whole
   * sweep. `dryRun` returns the same shape without writing, which is what the
   * confirmation dialog previews.
   */
  async bulkLogout(user: AuthUser, dto: BulkLogoutDto) {
    const tz = await this.orgTimezone(user.organizationId);
    const workDate = dto.date
      ? new Date(`${dto.date}T00:00:00.000Z`)
      : businessDate(new Date(), tz);
    if (Number.isNaN(workDate.getTime())) throw Errors.businessRule('Invalid date');

    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dto.time);
    if (!match) throw Errors.businessRule('Give the logout time as HH:mm, for example 18:05');

    const openRows = await this.d1.db
      .select({ ...SESSION_COLUMNS, shiftId: attendanceSessions.shiftId })
      .from(attendanceSessions)
      .innerJoin(workers, eq(workers.id, attendanceSessions.workerId))
      .leftJoin(designations, eq(designations.id, workers.designationId))
      .leftJoin(vendors, eq(vendors.id, workers.vendorId))
      .leftJoin(sites, eq(sites.id, attendanceSessions.siteId))
      .where(
        and(
          eq(attendanceSessions.organizationId, user.organizationId),
          eq(attendanceSessions.workDate, workDate.toISOString().slice(0, 10)),
          eq(attendanceSessions.state, 'OPEN'),
          ...this.scope(user),
          ...(dto.siteId && dto.siteId !== 'all'
            ? [eq(attendanceSessions.siteId, dto.siteId)]
            : []),
          ...(dto.sessionIds?.length ? [inArray(attendanceSessions.id, dto.sessionIds)] : []),
        ),
      )
      .orderBy(asc(workers.workerCode));
    const open = openRows.map((r) => ({ ...nestSession(r), shiftId: r.shiftId }));

    const closed: Array<{
      id: string;
      workerCode: string;
      fullName: string;
      loginAt: Date;
      logoutAt: Date;
      workedMinutes: number;
      overtimeMinutes: number;
    }> = [];
    const skipped: Array<{ id: string; workerCode: string; fullName: string; reason: string }> = [];

    for (const s of open) {
      // The chosen wall-clock time on this session's own site day.
      // A night shift ends on the morning after its work date, so the sweep can
      // be told to stamp the following day. Without it a 20:00 start could never
      // be swept at all: every candidate time fell before the login.
      const stampDay = new Date(s.workDate);
      if (dto.nextDay) stampDay.setUTCDate(stampDay.getUTCDate() + 1);

      const logoutAt = this.atLocalTime(
        stampDay,
        Number(match[1]),
        Number(match[2]),
        s.site?.timezone ?? tz,
      );

      if (logoutAt <= s.loginAt) {
        skipped.push({
          id: s.id,
          workerCode: s.worker.workerCode,
          fullName: s.worker.fullName,
          reason: dto.nextDay
            ? 'Logged in after this time on the next day too'
            : 'Logged in after this time — tick "next morning" for a night shift',
        });
        continue;
      }

      const hours = computeWorkHours(
        s.loginAt,
        logoutAt,
        s.site?.timezone ?? tz,
        await this.shiftConfig(s.shiftId),
      );

      if (!dto.dryRun) {
        await this.d1.db
          .update(attendanceSessions)
          .set({
            logoutAt,
            state: 'CLOSED',
            workedMinutes: hours.workedMinutes,
            overtimeMinutes: hours.overtimeMinutes,
            lateMinutes: hours.lateMinutes,
            earlyLeaveMinutes: hours.earlyLeaveMinutes,
            closedReason: 'ADMIN_BULK_LOGOUT',
            updatedAt: new Date(),
          })
          .where(eq(attendanceSessions.id, s.id));
        await this.audit.record({
          organizationId: user.organizationId,
          actorUserId: user.userId,
          actorRole: user.role,
          action: 'ATTENDANCE_SESSION_BULK_LOGOUT',
          entityType: 'AttendanceSession',
          entityId: s.id,
          oldValue: { state: 'OPEN', logoutAt: null, workedMinutes: s.workedMinutes },
          newValue: {
            state: 'CLOSED',
            logoutAt,
            workedMinutes: hours.workedMinutes,
            overtimeMinutes: hours.overtimeMinutes,
          },
          reason: dto.reason,
        });
      }

      closed.push({
        id: s.id,
        workerCode: s.worker.workerCode,
        fullName: s.worker.fullName,
        loginAt: s.loginAt,
        logoutAt,
        workedMinutes: hours.workedMinutes,
        overtimeMinutes: hours.overtimeMinutes,
      });
    }

    return {
      dryRun: dto.dryRun ?? false,
      date: workDate.toISOString().slice(0, 10),
      time: dto.time,
      closed,
      skipped,
    };
  }

  /**
   * Undo the logout on chosen sessions — put those people back on site.
   *
   * The mirror image of the sweep, and just as common: a watchman walks the line
   * tapping cards a second time by mistake, and a whole row of men who are still
   * working end up scanned out a minute after they arrived. Reopening restores
   * the session to how it stood before the stray tap: the out time goes, and the
   * worked/overtime/late figures derived from it go with it.
   *
   * Only the sessions named in `sessionIds` are touched — there is no "reopen
   * everyone" sweep, because closing a day is deliberate and undoing all of it
   * at once is never what someone means.
   *
   * A worker may hold only one open session at a time (a DB constraint), so
   * anyone already on site is reported back as skipped instead of failing the
   * whole batch. `dryRun` returns the same shape without writing.
   */
  async bulkReopen(user: AuthUser, dto: BulkReopenDto) {
    const sessionRows = await this.sessionQuery()
      .where(
        and(
          inArray(attendanceSessions.id, dto.sessionIds),
          eq(attendanceSessions.organizationId, user.organizationId),
          ...this.scope(user),
        ),
      )
      .orderBy(asc(workers.workerCode));
    const sessions = sessionRows.map(nestSession);
    if (!sessions.length) return { dryRun: dto.dryRun ?? false, reopened: [], skipped: [] };

    // Everyone who already holds an open session — they cannot take another.
    const openAlready = await this.d1.db
      .select({
        workerId: attendanceSessions.workerId,
        workDate: attendanceSessions.workDate,
      })
      .from(attendanceSessions)
      .where(
        and(
          inArray(
            attendanceSessions.workerId,
            sessions.map((s) => s.workerId),
          ),
          eq(attendanceSessions.state, 'OPEN'),
          notInArray(
            attendanceSessions.id,
            sessions.map((s) => s.id),
          ),
        ),
      );
    const blocked = new Map(openAlready.map((s) => [s.workerId, s.workDate]));

    const reopened: Array<{
      id: string;
      workerCode: string;
      fullName: string;
      loginAt: Date;
      wasLogoutAt: Date | null;
      wasWorkedMinutes: number | null;
    }> = [];
    const skipped: Array<{ id: string; workerCode: string; fullName: string; reason: string }> = [];

    // Two rows for the same man in one batch would collide with each other, so
    // the first one through claims him and the rest are reported.
    const claimed = new Set<string>();

    for (const s of sessions) {
      if (s.state === 'OPEN') {
        skipped.push({
          id: s.id,
          workerCode: s.worker.workerCode,
          fullName: s.worker.fullName,
          reason: 'Already on site',
        });
        continue;
      }
      const clash = blocked.get(s.workerId);
      if (clash || claimed.has(s.workerId)) {
        skipped.push({
          id: s.id,
          workerCode: s.worker.workerCode,
          fullName: s.worker.fullName,
          reason: clash
            ? `Already on site from ${clash}`
            : 'Another record for this person is being reopened',
        });
        continue;
      }
      claimed.add(s.workerId);

      if (!dto.dryRun) {
        await this.d1.db
          .update(attendanceSessions)
          .set({
            logoutAt: null,
            state: 'OPEN',
            workedMinutes: null,
            overtimeMinutes: null,
            lateMinutes: null,
            earlyLeaveMinutes: null,
            closedReason: null,
            updatedAt: new Date(),
          })
          .where(eq(attendanceSessions.id, s.id));
        await this.audit.record({
          organizationId: user.organizationId,
          actorUserId: user.userId,
          actorRole: user.role,
          action: 'ATTENDANCE_SESSION_REOPEN',
          entityType: 'AttendanceSession',
          entityId: s.id,
          oldValue: {
            state: s.state,
            logoutAt: s.logoutAt,
            workedMinutes: s.workedMinutes,
            closedReason: s.closedReason,
          },
          newValue: { state: 'OPEN', logoutAt: null, workedMinutes: null },
          reason: dto.reason,
        });
      }

      reopened.push({
        id: s.id,
        workerCode: s.worker.workerCode,
        fullName: s.worker.fullName,
        loginAt: s.loginAt,
        wasLogoutAt: s.logoutAt,
        wasWorkedMinutes: s.workedMinutes,
      });
    }

    return { dryRun: dto.dryRun ?? false, reopened, skipped };
  }

  /** The instant of `hh:mm` on `workDate` as read on a clock in `timezone`. */
  private atLocalTime(workDate: Date, hh: number, mm: number, timezone: string): Date {
    return DateTime.fromObject(
      {
        year: workDate.getUTCFullYear(),
        month: workDate.getUTCMonth() + 1,
        day: workDate.getUTCDate(),
        hour: hh,
        minute: mm,
      },
      { zone: timezone },
    ).toJSDate();
  }
}
