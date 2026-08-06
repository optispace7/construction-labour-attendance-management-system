import { Injectable } from '@nestjs/common';
import { ManualApprovalStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { businessDate, minutesOfDay } from '../../common/time/time.util';
import { computeWorkHours, ShiftConfig } from '../attendance/engine/work-hours.engine';
import { capitalise, describeMovement } from '../attendance/engine/movement-words';
import { ReviewManualDto } from './dto/manual-approval.dto';

/** What the review screens show for one hand-typed punch. */
const REQUEST_SELECT = {
  id: true,
  siteId: true,
  workerId: true,
  tapType: true,
  sessionId: true,
  recordedAt: true,
  reason: true,
  status: true,
  reviewedBy: true,
  reviewedAt: true,
  reviewNotes: true,
  createdAt: true,
  worker: {
    select: {
      id: true,
      fullName: true,
      workerCode: true,
      photoUrl: true,
      category: true,
      designation: { select: { name: true } },
      vendor: { select: { name: true } },
    },
  },
  site: { select: { id: true, name: true, timezone: true } },
  tap: { select: { id: true, deviceId: true, latitude: true, longitude: true } },
} as const;

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
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Sites this user may review for; SUPER_ADMIN is unscoped. */
  private scope(user: AuthUser) {
    return user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
      ? { siteId: { in: user.siteScopes } }
      : {};
  }

  /** The queue. Defaults to what still needs a decision. */
  async list(user: AuthUser, status?: ManualApprovalStatus, siteId?: string) {
    const rows = await this.prisma.manualAttendanceRequest.findMany({
      where: {
        organizationId: user.organizationId,
        status: status ?? 'PENDING',
        ...this.scope(user),
        ...(siteId && siteId !== 'all' ? { siteId } : {}),
      },
      select: REQUEST_SELECT,
      // Oldest first: a man waiting to be put on the register has been waiting
      // longest, and the fire headcount is wrong until he is.
      orderBy: { recordedAt: 'asc' },
      take: 500,
    });

    const reviewerIds = [...new Set(rows.map((r) => r.reviewedBy).filter(Boolean) as string[])];
    const reviewers = reviewerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: reviewerIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const nameOf = new Map(reviewers.map((u) => [u.id, u.fullName]));

    return rows.map((r) => ({
      ...r,
      reviewedByName: r.reviewedBy ? (nameOf.get(r.reviewedBy) ?? null) : null,
    }));
  }

  /** How many are waiting — drives the badge on both apps' nav. */
  async pendingCount(user: AuthUser) {
    const count = await this.prisma.manualAttendanceRequest.count({
      where: {
        organizationId: user.organizationId,
        status: 'PENDING',
        ...this.scope(user),
      },
    });
    return { pending: count };
  }

  private async loadPending(user: AuthUser, id: string) {
    const request = await this.prisma.manualAttendanceRequest.findFirst({
      where: { id, organizationId: user.organizationId, ...this.scope(user) },
      include: {
        worker: { select: { fullName: true, workerCode: true, category: true } },
        site: { select: { id: true, name: true, timezone: true, settings: true } },
        tap: true,
      },
    });
    if (!request) throw Errors.notFound('Manual attendance request');
    if (request.status !== 'PENDING') {
      throw Errors.businessRule(
        `This entry was already ${request.status.toLowerCase()} and cannot be reviewed again.`,
      );
    }
    return request;
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
    startTime: Date;
    endTime: Date;
    isOvernight: boolean;
    lateGraceMinutes: number;
    earlyGraceMinutes: number;
    otThresholdMinutes: number;
  }): ShiftConfig {
    return {
      startTimeMinutes: minutesOfDay(shift.startTime),
      endTimeMinutes: minutesOfDay(shift.endTime),
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

    const applied = await this.prisma.$transaction(async (tx) => {
      if (request.tapType === 'LOGIN') {
        // Only one open session per worker (a DB constraint). If they scanned in
        // for real in the meantime, that record is the true one.
        const open = await tx.attendanceSession.findFirst({
          where: { workerId: request.workerId, state: 'OPEN' },
          select: {
            id: true,
            loginAt: true,
            loginTapId: true,
            site: { select: { name: true } },
          },
        });
        if (open) {
          const how = describeMovement(
            open.loginTapId
              ? await tx.attendanceTap.findUnique({
                  where: { id: open.loginTapId },
                  select: { tapSource: true, isManualBackup: true },
                })
              : null,
          );
          throw Errors.conflict(
            `${request.worker.fullName} is already logged in at ${open.site.name}. ` +
              `${capitalise(how)} logged them in at ${localTime(open.loginAt)}, ` +
              'after this entry was typed. Their attendance is already recorded — decline this ' +
              'entry; accepting it would put them on site twice.',
          );
        }

        const session = await tx.attendanceSession.create({
          data: {
            organizationId: request.organizationId,
            workerId: request.workerId,
            siteId: request.siteId,
            shiftId: request.site.settings?.defaultShiftId ?? null,
            workDate: businessDate(request.recordedAt, tz),
            loginTapId: request.tapId,
            loginAt: request.recordedAt,
            state: 'OPEN',
          },
        });
        return { sessionId: session.id, before: null, after: { loginAt: session.loginAt } };
      }

      // LOGOUT: close the session this entry was filed against, and only that
      // one — approving must not go hunting for a different session than the
      // watchman meant.
      if (!request.sessionId) {
        throw Errors.conflict(
          'This entry has no session to close. Decline it and fix the day in Fix Attendance.',
        );
      }
      const session = await tx.attendanceSession.findUnique({
        where: { id: request.sessionId },
        include: { shift: true },
      });
      if (!session) throw Errors.conflict('That attendance session no longer exists.');
      if (session.state !== 'OPEN') {
        // Say what closed it and when. Nine times in ten it is the man's own
        // badge, seconds after the watchman gave up on the scanner and typed
        // the punch instead — and knowing that is what makes it obvious the
        // typed entry can be thrown away without losing anyone's hours.
        const how = describeMovement(
          session.logoutTapId
            ? await tx.attendanceTap.findUnique({
                where: { id: session.logoutTapId },
                select: { tapSource: true, isManualBackup: true },
              })
            : null,
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
        session.shift ? this.toShiftConfig(session.shift) : undefined,
      );
      // Visitors are unpaid — the register records their movements, not overtime.
      if (request.worker.category === 'VISITOR') hours.overtimeMinutes = 0;
      const isCrossSite = request.siteId !== session.siteId;

      const updated = await tx.attendanceSession.update({
        where: { id: session.id },
        data: {
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
        },
      });

      return {
        sessionId: updated.id,
        before: { state: 'OPEN', logoutAt: null },
        after: {
          state: 'CLOSED',
          logoutAt: updated.logoutAt,
          workedMinutes: updated.workedMinutes,
        },
      };
    });

    const updated = await this.prisma.manualAttendanceRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewedBy: user.userId,
        reviewedAt: new Date(),
        reviewNotes: dto.reviewNotes,
        sessionId: applied.sessionId,
      },
      select: REQUEST_SELECT,
    });

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

    const updated = await this.prisma.manualAttendanceRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedBy: user.userId,
        reviewedAt: new Date(),
        reviewNotes: dto.reviewNotes,
      },
      select: REQUEST_SELECT,
    });

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
