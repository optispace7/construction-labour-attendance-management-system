import { Injectable } from '@nestjs/common';
import { CorrectionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { businessDate, minutesOfDay } from '../../common/time/time.util';
import { computeWorkHours, ShiftConfig } from '../attendance/engine/work-hours.engine';
import { CreateCorrectionDto, ReviewCorrectionDto } from './dto/correction.dto';

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, dto: CreateCorrectionDto) {
    const request = await this.prisma.correctionRequest.create({
      data: {
        organizationId: user.organizationId,
        workerId: dto.workerId,
        siteId: dto.siteId,
        sessionId: dto.sessionId,
        workDate: new Date(dto.workDate),
        type: dto.type,
        reason: dto.reason,
        notes: dto.notes,
        requestedBy: user.userId,
        items: {
          create: dto.items.map((i) => ({
            field: i.field,
            proposedValue: i.proposedValue as Prisma.InputJsonValue,
          })),
        },
      },
      include: { items: true },
    });

    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'CORRECTION_REQUEST',
      entityType: 'CorrectionRequest',
      entityId: request.id,
      newValue: { type: dto.type, reason: dto.reason, items: dto.items },
    });
    return request;
  }

  async list(user: AuthUser, status?: CorrectionStatus, siteId?: string, workerId?: string) {
    const rows = await this.prisma.correctionRequest.findMany({
      where: {
        organizationId: user.organizationId,
        ...(status ? { status } : {}),
        ...(siteId ? { siteId } : {}),
        ...(workerId ? { workerId } : {}),
      },
      include: {
        items: true,
        worker: { select: { fullName: true, workerCode: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Resolve the requester/reviewer UUIDs to human names so the admin sees
    // *who* filed each correction and who reviewed it, not raw IDs.
    const userIds = [
      ...new Set(rows.flatMap((r) => [r.requestedBy, r.reviewedBy]).filter(Boolean) as string[]),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true, role: true },
        })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.fullName]));

    return rows.map((r) => ({
      ...r,
      requestedByName: nameOf.get(r.requestedBy) ?? null,
      reviewedByName: r.reviewedBy ? (nameOf.get(r.reviewedBy) ?? null) : null,
    }));
  }

  async get(user: AuthUser, id: string) {
    const req = await this.prisma.correctionRequest.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { items: true, session: true },
    });
    if (!req) throw Errors.notFound('Correction request');
    return req;
  }

  async cancel(user: AuthUser, id: string) {
    const req = await this.get(user, id);
    if (req.status !== 'PENDING')
      throw Errors.businessRule('Only pending requests can be cancelled');
    const updated = await this.prisma.correctionRequest.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'CORRECTION_CANCEL',
      entityType: 'CorrectionRequest',
      entityId: id,
    });
    return updated;
  }

  async reject(user: AuthUser, id: string, dto: ReviewCorrectionDto) {
    const req = await this.get(user, id);
    if (req.status !== 'PENDING') throw Errors.businessRule('Request is not pending');
    const updated = await this.prisma.correctionRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedBy: user.userId,
        reviewedAt: new Date(),
        reviewNotes: dto.reviewNotes,
      },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      actorUserId: user.userId,
      actorRole: user.role,
      action: 'CORRECTION_REJECT',
      entityType: 'CorrectionRequest',
      entityId: id,
      reason: dto.reviewNotes,
    });
    return updated;
  }

  /**
   * APPROVE — the ONLY path that mutates attendance from a correction.
   * Runs in a transaction: re-validate freshness → apply field changes →
   * recompute hours → mark APPROVED → write an audit record with old/new.
   */
  async approve(user: AuthUser, id: string, dto: ReviewCorrectionDto) {
    return this.prisma.$transaction(async (tx) => {
      const req = await tx.correctionRequest.findFirst({
        where: { id, organizationId: user.organizationId },
        include: { items: true },
      });
      if (!req) throw Errors.notFound('Correction request');
      if (req.status !== 'PENDING') throw Errors.businessRule('Request is not pending');

      let sessionBefore: Record<string, unknown> | null = null;
      let sessionAfter: Record<string, unknown> | null = null;
      let appliedSessionId: string | null = null;

      {
        const patch: Prisma.AttendanceSessionUpdateInput = {};
        for (const item of req.items) {
          const v = item.proposedValue as unknown;
          switch (item.field) {
            case 'login_at':
              patch.loginAt = new Date(v as string);
              break;
            case 'logout_at':
              patch.logoutAt = new Date(v as string);
              break;
            case 'site_id':
              patch.site = { connect: { id: v as string } };
              break;
            case 'shift_id':
              patch.shift = { connect: { id: v as string } };
              break;
            default:
              throw Errors.businessRule(`Unsupported correction field: ${item.field}`);
          }
        }

        const site = await tx.site.findFirst({
          where: { id: req.siteId, organizationId: req.organizationId },
          include: { settings: true },
        });
        if (!site) throw Errors.notFound('Site');

        // Which day does this correction mean? NOT req.workDate — the mobile
        // builds that from local midnight and converts to UTC, so at +05:30 it
        // lands on the previous day and the Date column truncates it there. The
        // proposed timestamp is an unambiguous instant, so derive the day from
        // it and only fall back to workDate when nothing was proposed.
        const anchor = (patch.loginAt ?? patch.logoutAt) as Date | undefined;
        const targetDate = anchor ? businessDate(anchor, site.timezone) : req.workDate;

        // Requests filed from the mobile app don't pin a sessionId, so fall back
        // to the worker's session for the target day. Without this the approval
        // silently changed nothing and attendance/reports kept the old values.
        let session = req.sessionId
          ? await tx.attendanceSession.findUnique({
              where: { id: req.sessionId },
              include: { shift: true, site: true },
            })
          : await tx.attendanceSession.findFirst({
              where: {
                organizationId: req.organizationId,
                workerId: req.workerId,
                workDate: targetDate,
              },
              include: { shift: true, site: true },
              orderBy: { loginAt: 'desc' },
            });

        if (req.sessionId && !session) throw Errors.conflict('Target session no longer exists');

        // Freshness: if a pinned session changed after the request was filed, abort.
        // Resolved-by-date sessions are deliberately exempt — they are looked up
        // fresh at approval time, so "current row wins" is the intended behaviour.
        if (req.sessionId && session && session.updatedAt > req.createdAt) {
          throw Errors.conflict('Session changed since the request was filed; please re-file');
        }

        // A logout that lands before its own login is a typo, not a correction.
        // Nothing downstream rejects it: the session closes with negative time,
        // the hours engine floors that to zero, and the day quietly reads as
        // worked-nothing. The Fix-attendance panel already refuses this; the
        // approval path did not, and two days in August were saved that way.
        // Compared against whatever the row will hold afterwards, so correcting
        // only one end of a session is checked against the end left alone.
        const finalLoginAt = (patch.loginAt as Date | undefined) ?? session?.loginAt;
        const finalLogoutAt = (patch.logoutAt as Date | undefined) ?? session?.logoutAt;
        if (finalLoginAt && finalLogoutAt && finalLogoutAt <= finalLoginAt) {
          throw Errors.businessRule(
            'The corrected logout time is not after the login time. Fix the times on the ' +
              'request — approving this would record the day as zero hours worked.',
          );
        }

        // A MISSING correction has no row to patch — the whole point is that the
        // worker was never scanned in. Materialise the session from the proposed
        // login time instead of approving into the void.
        if (!session) {
          if (!patch.loginAt) {
            // Refuse rather than guess: a logout-only correction with no session
            // on the target day (e.g. an overnight shift whose logout falls on
            // the next day) needs a human, not an invented row.
            throw Errors.conflict(
              `No attendance session for ${targetDate.toISOString().slice(0, 10)}; ` +
                'the correction must propose a login time',
            );
          }
          // uq_open_session_per_worker allows only ONE open session per worker,
          // so a login-only correction can't be materialised while the worker is
          // still clocked in somewhere. Land it CLOSED when a logout is proposed.
          if (!patch.logoutAt) {
            const alreadyOpen = await tx.attendanceSession.findFirst({
              where: { workerId: req.workerId, state: 'OPEN' },
            });
            if (alreadyOpen) {
              throw Errors.conflict(
                'Worker already has an open session; add a logout time to the correction or close that session first',
              );
            }
          }
          session = await tx.attendanceSession.create({
            data: {
              organizationId: req.organizationId,
              workerId: req.workerId,
              siteId: req.siteId,
              shiftId: site.settings?.defaultShiftId ?? null,
              workDate: targetDate,
              loginAt: patch.loginAt as Date,
              logoutAt: (patch.logoutAt as Date | undefined) ?? null,
              state: patch.logoutAt ? 'CLOSED' : 'OPEN',
            },
            include: { shift: true, site: true },
          });
        } else {
          sessionBefore = {
            loginAt: session.loginAt,
            logoutAt: session.logoutAt,
            siteId: session.siteId,
            shiftId: session.shiftId,
            workDate: session.workDate,
          };
        }

        // Apply, then recompute hours from resulting login/logout.
        let applied = await tx.attendanceSession.update({
          where: { id: session.id },
          data: patch,
          include: { shift: true, site: true },
        });

        // workDate is what attendance and reports filter on, so it has to follow
        // a corrected login time (or a corrected site's timezone) — otherwise the
        // session stays filed under the day it was originally scanned.
        const workDate = businessDate(applied.loginAt, applied.site.timezone);
        if (workDate.getTime() !== applied.workDate.getTime()) {
          applied = await tx.attendanceSession.update({
            where: { id: session.id },
            data: { workDate },
            include: { shift: true, site: true },
          });
        }

        if (applied.logoutAt) {
          const shiftCfg: ShiftConfig | undefined = applied.shift
            ? {
                startTimeMinutes: minutesOfDay(applied.shift.startTime),
                endTimeMinutes: minutesOfDay(applied.shift.endTime),
                isOvernight: applied.shift.isOvernight,
                lateGraceMinutes: applied.shift.lateGraceMinutes,
                earlyGraceMinutes: applied.shift.earlyGraceMinutes,
                otThresholdMinutes: applied.shift.otThresholdMinutes,
              }
            : undefined;
          const hours = computeWorkHours(
            applied.loginAt,
            applied.logoutAt,
            applied.site.timezone,
            shiftCfg,
          );
          await tx.attendanceSession.update({
            where: { id: session.id },
            data: {
              state: 'CLOSED',
              workedMinutes: hours.workedMinutes,
              overtimeMinutes: hours.overtimeMinutes,
              lateMinutes: hours.lateMinutes,
              earlyLeaveMinutes: hours.earlyLeaveMinutes,
              closedReason: 'CORRECTION',
            },
          });
        }

        sessionAfter = {
          loginAt: applied.loginAt,
          logoutAt: applied.logoutAt,
          siteId: applied.siteId,
          shiftId: applied.shiftId,
          workDate: applied.workDate,
        };
        appliedSessionId = applied.id;
      }

      const updated = await tx.correctionRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedBy: user.userId,
          reviewedAt: new Date(),
          reviewNotes: dto.reviewNotes,
          // Record which session the approval actually landed on, so the request
          // is traceable back to the row it changed.
          ...(req.sessionId ? {} : { sessionId: appliedSessionId }),
        },
      });

      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.userId,
        actorRole: user.role,
        action: 'CORRECTION_APPROVE',
        entityType: 'AttendanceSession',
        entityId: appliedSessionId ?? req.id,
        oldValue: sessionBefore,
        newValue: sessionAfter,
        reason: dto.reviewNotes,
      });

      return updated;
    });
  }
}
