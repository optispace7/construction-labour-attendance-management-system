import { Injectable, Logger } from '@nestjs/common';
import {
  AttendanceTap,
  PersonCategory,
  Prisma,
  SiteSettings,
  TapSource,
  Worker,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { Errors } from '../../common/errors/app.exception';
import { businessDate, minutesOfDay } from '../../common/time/time.util';
import { isCardExpired } from './engine/card-validity';
import { computeWorkHours, ShiftConfig } from './engine/work-hours.engine';
import { decideTap, distanceMeters, shouldVerifyPhoto } from './engine/tap-decision';
import { describeMovement } from './engine/movement-words';
import { TapDto } from './dto/attendance.dto';
import { renderDaySummaryPdf } from '../reports/report.renderer';

export interface TapContext {
  deviceId: string;
  ip?: string;
  /** 0-100 randomness for photo policy; injectable for tests. */
  photoRoll?: number;
}

type ResolvedWorker = Worker & {
  vendor: { name: string } | null;
  designation: { name: string } | null;
};

/** Longest manpower window we will query in one go. */
export const MANPOWER_MAX_DAYS = 92;

/**
 * The heading a person's attendance is grouped under on the vendor breakdowns.
 *
 * Most people on a site belong to a labour contractor. Company staff do not —
 * they are on the payroll directly — and a visitor never does. Filing either
 * under "No vendor" makes correct data look like a gap in the records, which is
 * what had people asking why the dashboard showed an unnamed contractor.
 *
 * A WORKER with no vendor genuinely IS missing one, so that case keeps the
 * original label rather than being quietly relabelled into something tidier.
 */
export function vendorGroupLabel(worker: {
  vendor: { name: string } | null;
  category: PersonCategory | string;
}): string {
  const name = worker.vendor?.name?.trim();
  if (name) return name;
  if (worker.category === 'STAFF') return 'Staff';
  if (worker.category === 'VISITOR') return 'Visitors';
  return 'No vendor';
}

/**
 * Resolves the manpower panel's window from user input. Defaults to the last
 * seven days ending today; an inverted range is swapped rather than rejected,
 * and the span is capped so a hand-typed year cannot pull the whole table.
 */
export function resolveManpowerRange(
  from: string | undefined,
  to: string | undefined,
  today: Date,
): { start: Date; end: Date } {
  const parse = (s?: string) => {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
    const d = new Date(`${s}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  let end = parse(to) ?? today;
  let start = parse(from) ?? new Date(end.getTime() - 6 * 86_400_000);
  if (start.getTime() > end.getTime()) [start, end] = [end, start];

  const span = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (span > MANPOWER_MAX_DAYS) {
    start = new Date(end.getTime() - (MANPOWER_MAX_DAYS - 1) * 86_400_000);
  }
  return { start, end };
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Records a scan in the audit trail. Called wherever a tap actually becomes a
   * login or logout, so the log mirrors attendance rather than raw device
   * chatter (an unresolved badge or a duplicate tap is not an attendance event).
   *
   * Deliberately non-fatal: a tap is the one thing that must never fail because
   * a secondary write did. The offline outbox replays taps, and a 500 here
   * would strand a worker at the gate.
   */
  private async auditScan(
    action: 'ATTENDANCE_LOGIN' | 'ATTENDANCE_LOGOUT',
    args: {
      organizationId: string;
      workerId: string;
      ctx: TapContext;
      source: TapSource;
      siteId: string;
      sessionId: string;
      at: Date;
      extra?: Record<string, unknown>;
    },
  ) {
    try {
      await this.audit.record({
        organizationId: args.organizationId,
        action,
        entityType: 'Worker',
        entityId: args.workerId,
        deviceId: args.ctx.deviceId,
        ipAddress: args.ctx.ip,
        newValue: {
          sessionId: args.sessionId,
          siteId: args.siteId,
          source: args.source,
          at: args.at.toISOString(),
          ...args.extra,
        },
      });
    } catch (e) {
      this.logger.error(`Audit write failed for ${action} worker=${args.workerId}: ${String(e)}`);
    }
  }

  private workerCard(w: ResolvedWorker) {
    return {
      id: w.id,
      fullName: w.fullName,
      workerCode: w.workerCode,
      photoUrl: w.photoUrl,
      category: w.category,
      vendorName: w.vendor?.name ?? null,
      designationName: w.designation?.name ?? null,
      bloodGroup: w.bloodGroup,
      emergencyContactName: w.emergencyContactName,
      emergencyContactNumber: w.emergencyContactNumber,
    };
  }

  private async resolveWorker(
    organizationId: string,
    source: TapSource,
    identifier: string,
  ): Promise<ResolvedWorker | null> {
    // Only ACTIVE people can punch: deleted workers, exited/expired visitor
    // passes and suspended workers are rejected (offline replays included).
    const base = { organizationId, deletedAt: null, status: 'ACTIVE' as const };
    const include = {
      vendor: { select: { name: true } },
      designation: { select: { name: true } },
    } as const;
    if (source === TapSource.NFC_UID) {
      return this.prisma.worker.findFirst({ where: { ...base, nfcUid: identifier }, include });
    }
    if (source === TapSource.QR) {
      // QR badges encode the EMP-ID (worker code); fall back to the opaque
      // qrIdentifier for legacy/secure codes.
      return this.prisma.worker.findFirst({
        where: { ...base, OR: [{ workerCode: identifier }, { qrIdentifier: identifier }] },
        include,
      });
    }
    // NFC_NDEF and MANUAL resolve by worker code.
    return this.prisma.worker.findFirst({ where: { ...base, workerCode: identifier }, include });
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
   * Core tap handler. Idempotent on eventId. Decides LOGIN/LOGOUT/DUPLICATE,
   * enforces geo when configured, applies verification + photo policy.
   * This is the single entry point used by both the live tap endpoint and the
   * offline sync ingest (one event at a time).
   */
  async handleTap(organizationId: string, dto: TapDto, ctx: TapContext) {
    // 1. Idempotency: a tap with this eventId already processed → replay.
    const existing = await this.prisma.attendanceTap.findUnique({
      where: { organizationId_eventId: { organizationId, eventId: dto.eventId } },
    });
    if (existing) {
      return this.replayResult(existing);
    }

    const site = await this.prisma.site.findFirst({
      where: { id: dto.siteId, organizationId },
      include: { settings: true },
    });
    if (!site) throw Errors.notFound('Site');
    const settings = site.settings ?? this.defaultSettings(dto.siteId);

    const worker = await this.resolveWorker(organizationId, dto.source, dto.identifier);

    // Unresolved identifier: persist the raw tap for later reconciliation.
    if (!worker) {
      await this.prisma.attendanceTap.create({
        data: {
          eventId: dto.eventId,
          organizationId,
          siteId: dto.siteId,
          deviceId: dto.deviceId,
          rawIdentifier: dto.identifier,
          tapSource: dto.source,
          clientEventTime: new Date(dto.clientEventTime),
          monotonicMs: dto.monotonicMs != null ? BigInt(dto.monotonicMs) : null,
          latitude: dto.geo?.lat,
          longitude: dto.geo?.lng,
          geoAccuracyM: dto.geo?.accuracyM,
          isManualBackup: dto.manual?.isBackup ?? false,
          manualReason: dto.manual?.reason,
        },
      });
      throw Errors.workerNotFound(`Unresolved identifier: ${dto.identifier}`);
    }

    // 2. Geo enforcement.
    if (settings.geoEnforcement && site.latitude != null && site.longitude != null) {
      if (dto.geo == null) throw Errors.businessRule('Location required for this site');
      const dist = distanceMeters(site.latitude, site.longitude, dto.geo.lat, dto.geo.lng);
      if (dist > settings.geoRadiusMeters) {
        throw Errors.geoOutOfRange(Math.round(dist), settings.geoRadiusMeters);
      }
    }

    const tapTime = new Date(dto.clientEventTime);

    // 3. Serialise per-worker decisions with a short Redis lock.
    const lockKey = `worker:${worker.id}:session`;
    const lockToken = await this.redis.acquireLock(lockKey, 5000);
    if (!lockToken) throw Errors.conflict('Another tap is being processed for this worker');

    try {
      const openSession = await this.prisma.attendanceSession.findFirst({
        where: { workerId: worker.id, state: 'OPEN' },
      });
      const lastTap = await this.prisma.attendanceTap.findFirst({
        where: { workerId: worker.id },
        orderBy: { clientEventTime: 'desc' },
      });

      // A hand-typed punch already waiting on the Safety Officer blocks another
      // one for the same person. Checked before anything is written so the
      // watchman is told at the gate, not after a tap is on record.
      if (dto.manual?.isBackup) {
        const waiting = await this.prisma.manualAttendanceRequest.findFirst({
          where: { workerId: worker.id, status: 'PENDING' },
          select: { tapType: true, createdAt: true },
        });
        if (waiting) {
          throw Errors.manualReviewPending(worker.fullName, waiting.tapType, waiting.createdAt);
        }
      }

      const decision = decideTap(
        tapTime,
        settings.duplicateTapCooldownSeconds,
        openSession
          ? { id: openSession.id, loginAt: openSession.loginAt, siteId: openSession.siteId }
          : null,
        lastTap ? { clientEventTime: lastTap.clientEventTime, tapType: lastTap.tapType } : null,
        this.safetyGapSeconds(settings, worker, dto),
        !!dto.override,
      );

      if (decision.action === 'DUPLICATE') {
        throw Errors.duplicateTap(decision.cooldownRemainingSeconds);
      }

      if (decision.action === 'TOO_SOON') {
        throw Errors.tapTooSoon({
          fullName: worker.fullName,
          blocked: decision.blocked,
          elapsedMinutes: decision.elapsedMinutes,
          remainingSeconds: decision.remainingSeconds,
        });
      }

      // The watchman said "record it anyway". The tap is going through, so the
      // override belongs in the audit trail before the session moves — with or
      // without a note, since the prompt for one was dropped.
      if (dto.override) {
        await this.auditOverride(organizationId, worker.id, dto, ctx, decision.action);
      }

      if (decision.action === 'LOGIN') {
        // An expired ID card may not start a shift. Checked here, not before
        // the decision, so that someone already on site can still tap out and
        // close their session — trapping people inside the gate would be worse
        // than letting a lapsed card leave.
        if (isCardExpired(worker.validityTill, tapTime, site.timezone)) {
          throw Errors.cardExpired(
            worker.fullName,
            worker.validityTill!.toISOString().slice(0, 10),
          );
        }
      }

      // Typed in by hand, with no badge behind it: file it for review rather
      // than move attendance. Placed after every refusal above so a manual entry
      // is held to the same rules a scan is — an expired card is still refused,
      // and a duplicate is still a duplicate.
      if (dto.manual?.isBackup) {
        return await this.fileManualRequest(organizationId, site, worker, dto, ctx, tapTime, {
          tapType: decision.action,
          sessionId: decision.action === 'LOGOUT' ? decision.sessionId : null,
        });
      }

      if (decision.action === 'LOGIN') {
        return await this.doLogin(organizationId, site, settings, worker, dto, ctx, tapTime);
      }
      return await this.doLogout(
        organizationId,
        site,
        worker,
        dto,
        ctx,
        tapTime,
        decision.sessionId,
      );
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * The safety gap that applies to this particular tap, in seconds.
   *
   * Zero — i.e. off — in two cases. Visitors are day passes recorded for the
   * register: a ten-minute visit is a normal visit, and holding one inside the
   * gate would be worse than a slightly wrong time on an unpaid record. And a
   * watchman who has confirmed the refusal has already been told what the gap
   * thinks; the override is his to make, with or without a note attached.
   */
  private safetyGapSeconds(settings: SiteSettings, worker: ResolvedWorker, dto: TapDto): number {
    if (worker.category === 'VISITOR') return 0;
    if (dto.override) return 0;
    return Math.max(0, settings.safetyGapMinutes) * 60;
  }

  /** Records who waved a scan past the safety gap, and the reason they gave. */
  private async auditOverride(
    organizationId: string,
    workerId: string,
    dto: TapDto,
    ctx: TapContext,
    recorded: 'LOGIN' | 'LOGOUT',
  ) {
    try {
      await this.audit.record({
        organizationId,
        action: 'ATTENDANCE_SAFETY_GAP_OVERRIDE',
        entityType: 'Worker',
        entityId: workerId,
        deviceId: ctx.deviceId,
        ipAddress: ctx.ip,
        reason: dto.override?.reason ?? 'Confirmed at the gate (no note given)',
        newValue: { recorded, source: dto.source, siteId: dto.siteId, eventId: dto.eventId },
      });
    } catch (e) {
      // Same rule as every other audit write here: a tap must not fail at the
      // gate because a secondary write did.
      this.logger.error(`Audit write failed for override worker=${workerId}: ${String(e)}`);
    }
  }

  /**
   * Record a hand-typed punch as a request, not as attendance.
   *
   * Everything a scan writes is written here too — the tap, the geo fix, the
   * reason — except the one thing that counts: the session. A badge is proof
   * that a card was physically present; a typed worker code is proof of nothing,
   * so the person does not go on or off the site's books until someone with
   * review rights says they were really there.
   *
   * The consequence is deliberate and worth stating: between the entry and the
   * approval, this worker is NOT in "on site now" and NOT in the SOS/fire
   * headcount. The pending count is surfaced in both apps so nobody has to
   * discover that from a headcount that does not add up.
   */
  private async fileManualRequest(
    organizationId: string,
    site: { id: string },
    worker: ResolvedWorker,
    dto: TapDto,
    ctx: TapContext,
    tapTime: Date,
    intent: { tapType: 'LOGIN' | 'LOGOUT'; sessionId: string | null },
  ) {
    const tap = await this.prisma.attendanceTap.create({
      data: {
        eventId: dto.eventId,
        organizationId,
        siteId: site.id,
        deviceId: dto.deviceId,
        workerId: worker.id,
        rawIdentifier: dto.identifier,
        tapSource: dto.source,
        tapType: intent.tapType,
        clientEventTime: tapTime,
        monotonicMs: dto.monotonicMs != null ? BigInt(dto.monotonicMs) : null,
        latitude: dto.geo?.lat,
        longitude: dto.geo?.lng,
        geoAccuracyM: dto.geo?.accuracyM,
        photoCapturedUrl: dto.photoUrl,
        isManualBackup: true,
        manualReason: dto.manual?.reason,
      },
    });

    const request = await this.prisma.manualAttendanceRequest.create({
      data: {
        organizationId,
        siteId: site.id,
        workerId: worker.id,
        tapId: tap.id,
        tapType: intent.tapType,
        // A logout pins the session it means to close; a login has none yet, so
        // the column is filled in on approval with the session it created.
        sessionId: intent.sessionId,
        recordedAt: tapTime,
        reason: dto.manual?.reason,
        deviceId: dto.deviceId,
      },
    });

    await this.maybeAuditManual(organizationId, ctx, worker.id, dto);

    // Neither of these may sink a punch at the gate — same rule as every other
    // secondary write in this service.
    try {
      await this.notifications.create({
        organizationId,
        siteId: site.id,
        type: 'MANUAL_ATTENDANCE_PENDING',
        title: `Manual ${intent.tapType === 'LOGIN' ? 'login' : 'logout'} needs approval`,
        body:
          `${worker.workerCode} ${worker.fullName} was entered by hand at the gate` +
          `${dto.manual?.reason ? ` (${dto.manual.reason})` : ''}. ` +
          'Accept or decline it so their attendance is recorded.',
        data: {
          requestId: request.id,
          workerId: worker.id,
          tapType: intent.tapType,
          siteId: site.id,
        },
      });
    } catch (e) {
      this.logger.error(`Notification failed for manual request ${request.id}: ${String(e)}`);
    }

    return {
      result: 'MANUAL_PENDING_APPROVAL' as const,
      requestId: request.id,
      eventId: dto.eventId,
      tapType: intent.tapType,
      worker: this.workerCard(worker),
      recordedAt: tapTime,
    };
  }

  private defaultSettings(siteId: string): SiteSettings {
    return {
      siteId,
      verificationMode: 'MANUAL',
      autoLoginCountdownSeconds: 10,
      duplicateTapCooldownSeconds: 30,
      safetyGapMinutes: 10,
      geoEnforcement: false,
      geoRadiusMeters: 200,
      photoVerificationMode: 'RANDOM',
      photoVerificationRandomPct: 20,
      defaultShiftId: null,
      updatedAt: new Date(),
    };
  }

  private async doLogin(
    organizationId: string,
    site: { id: string; timezone: string; settings: SiteSettings | null },
    settings: SiteSettings,
    worker: ResolvedWorker,
    dto: TapDto,
    ctx: TapContext,
    tapTime: Date,
  ) {
    // Auto-close any stale open session from a previous business day (#5).
    const stale = await this.prisma.attendanceSession.findFirst({
      where: { workerId: worker.id, state: 'OPEN' },
    });
    if (stale) {
      await this.prisma.attendanceSession.update({
        where: { id: stale.id },
        data: {
          state: 'AUTO_CLOSED',
          closedReason: 'auto-closed on next login',
          logoutAt: tapTime,
        },
      });
    }

    const roll = ctx.photoRoll ?? Math.floor(Math.random() * 100);
    const requiresPhoto = shouldVerifyPhoto(
      settings.photoVerificationMode,
      settings.photoVerificationRandomPct,
      roll,
    );
    const workDate = businessDate(tapTime, site.timezone);

    const tap = await this.prisma.attendanceTap.create({
      data: {
        eventId: dto.eventId,
        organizationId,
        siteId: site.id,
        deviceId: dto.deviceId,
        workerId: worker.id,
        rawIdentifier: dto.identifier,
        tapSource: dto.source,
        tapType: 'LOGIN',
        clientEventTime: tapTime,
        monotonicMs: dto.monotonicMs != null ? BigInt(dto.monotonicMs) : null,
        latitude: dto.geo?.lat,
        longitude: dto.geo?.lng,
        geoAccuracyM: dto.geo?.accuracyM,
        verifiedMode: settings.verificationMode,
        photoCapturedUrl: dto.photoUrl,
        isManualBackup: dto.manual?.isBackup ?? false,
        manualReason: dto.manual?.reason,
      },
    });

    // MANUAL mode: persist the tap (durable) but defer session creation to confirm.
    if (settings.verificationMode === 'MANUAL') {
      await this.maybeAuditManual(organizationId, ctx, worker.id, dto);
      return {
        result: 'LOGIN_PENDING_CONFIRM',
        eventId: dto.eventId,
        worker: this.workerCard(worker),
        verificationMode: settings.verificationMode,
        requiresConfirm: true,
        requiresPhoto,
      };
    }

    // AUTO mode: commit the session immediately.
    const session = await this.prisma.attendanceSession.create({
      data: {
        organizationId,
        workerId: worker.id,
        siteId: site.id,
        shiftId: settings.defaultShiftId,
        workDate,
        loginTapId: tap.id,
        loginAt: tapTime,
        state: 'OPEN',
      },
    });
    await this.ensureSiteAssignment(worker.id, site.id);
    await this.maybeAuditManual(organizationId, ctx, worker.id, dto);
    await this.auditScan('ATTENDANCE_LOGIN', {
      organizationId,
      workerId: worker.id,
      ctx,
      source: dto.source,
      siteId: site.id,
      sessionId: session.id,
      at: tapTime,
      extra: { workDate: workDate.toISOString().slice(0, 10), verificationMode: 'AUTO' },
    });
    await this.supersedePendingManual(organizationId, worker, ctx, {
      tapType: 'LOGIN',
      at: tapTime,
      sessionId: session.id,
      timezone: site.timezone,
      source: dto.source,
    });

    return {
      result: 'LOGIN_RECORDED',
      sessionId: session.id,
      worker: this.workerCard(worker),
      verificationMode: settings.verificationMode,
      requiresPhoto,
      loginAt: session.loginAt,
    };
  }

  /**
   * Somebody scanned in at a site works at that site — put them on its list.
   *
   * Which site a person belongs to is meant to be set when they are registered,
   * but the field is optional on the form, and somebody registered without one
   * belongs to no site at all. They can still be scanned, because the gate
   * resolves a badge against the whole organization — so they turn up in
   * attendance while being missing from the Safety Officer's list, which is
   * where the officer looks for them, and from the offline cache that list
   * warms. That last one is the dangerous half: they scan fine while the tablet
   * has signal and cannot be scanned at all once it drops.
   *
   * A scan is the one call that must never fail, so this is best-effort: a
   * worker who cannot be enrolled is still logged in.
   */
  private async ensureSiteAssignment(workerId: string, siteId: string) {
    try {
      const open = await this.prisma.workerSiteAssignment.findMany({
        where: { workerId, endDate: null },
        select: { siteId: true },
      });
      if (open.some((a) => a.siteId === siteId)) return;
      await this.prisma.workerSiteAssignment.create({
        data: {
          workerId,
          siteId,
          startDate: new Date(),
          // Their first site is the primary one; a second is an addition, not a
          // correction of the first.
          isPrimary: open.length === 0,
        },
      });
      this.logger.log(`Enrolled worker ${workerId} at site ${siteId} on scan`);
    } catch (e) {
      this.logger.warn(
        `Could not enrol worker ${workerId} at site ${siteId}: ${(e as Error).message}`,
      );
    }
  }

  private async doLogout(
    organizationId: string,
    site: { id: string; timezone: string },
    worker: ResolvedWorker,
    dto: TapDto,
    ctx: TapContext,
    tapTime: Date,
    sessionId: string,
  ) {
    const session = await this.prisma.attendanceSession.findUnique({
      where: { id: sessionId },
      include: { shift: true },
    });
    if (!session) throw Errors.conflict('Open session disappeared');

    const tap = await this.prisma.attendanceTap.create({
      data: {
        eventId: dto.eventId,
        organizationId,
        siteId: dto.siteId,
        deviceId: dto.deviceId,
        workerId: worker.id,
        rawIdentifier: dto.identifier,
        tapSource: dto.source,
        tapType: 'LOGOUT',
        clientEventTime: tapTime,
        monotonicMs: dto.monotonicMs != null ? BigInt(dto.monotonicMs) : null,
        latitude: dto.geo?.lat,
        longitude: dto.geo?.lng,
        geoAccuracyM: dto.geo?.accuracyM,
        isManualBackup: dto.manual?.isBackup ?? false,
        manualReason: dto.manual?.reason,
      },
    });

    const shiftConfig = session.shift ? this.toShiftConfig(session.shift) : undefined;
    const hours = computeWorkHours(session.loginAt, tapTime, site.timezone, shiftConfig);
    // Visitors are unpaid — login/logout is recorded purely for the register,
    // so overtime never applies to them.
    if (worker.category === 'VISITOR') hours.overtimeMinutes = 0;
    const isCrossSite = dto.siteId !== session.siteId;

    const updated = await this.prisma.attendanceSession.update({
      where: { id: session.id },
      data: {
        logoutTapId: tap.id,
        logoutAt: tapTime,
        state: 'CLOSED',
        workedMinutes: hours.workedMinutes,
        overtimeMinutes: hours.overtimeMinutes,
        lateMinutes: hours.lateMinutes,
        earlyLeaveMinutes: hours.earlyLeaveMinutes,
        logoutSiteId: isCrossSite ? dto.siteId : null,
        isCrossSite,
      },
    });

    await this.maybeAuditManual(organizationId, ctx, worker.id, dto);
    await this.auditScan('ATTENDANCE_LOGOUT', {
      organizationId,
      workerId: worker.id,
      ctx,
      source: dto.source,
      siteId: dto.siteId,
      sessionId: updated.id,
      at: tapTime,
      extra: {
        workDate: session.workDate?.toISOString().slice(0, 10) ?? null,
        workedMinutes: updated.workedMinutes,
        isCrossSite,
      },
    });

    await this.supersedePendingManual(organizationId, worker, ctx, {
      tapType: 'LOGOUT',
      at: tapTime,
      sessionId: updated.id,
      timezone: site.timezone,
      source: dto.source,
    });

    return {
      result: 'LOGOUT_RECORDED',
      sessionId: updated.id,
      workedMinutes: updated.workedMinutes,
      overtimeMinutes: updated.overtimeMinutes,
      isCrossSite,
      logoutAt: updated.logoutAt,
    };
  }

  /**
   * A badge scan has just moved this worker's attendance, so any hand-typed
   * punch still waiting on a Safety Officer is now impossible to apply.
   *
   * This is the case that kept getting stuck: the watchman types someone out,
   * the man finds his card and scans out properly seconds later, and the typed
   * entry is left pointing at a session that is already closed. Accepting it
   * could then only ever fail, and until somebody declined it by hand the man
   * stayed on the "waiting" list, the pending badge kept counting him, and the
   * watchman was blocked from typing another punch for him.
   *
   * By the time a scan reaches here the pending request cannot be applied
   * whatever it was: a LOGOUT's session is now closed, and a LOGIN would need a
   * second open session, which one worker may never have. So it is closed with
   * no reviewer against it — nobody decided this, the scan did — and the note
   * says which scan overtook it. Nothing is deleted: the typed tap stays on
   * file, and an audit row records that the system, not a person, resolved it.
   *
   * Non-fatal, like the audit writes: the scan itself has already been recorded
   * by the time this runs, and tidying the review queue must never be the thing
   * that fails a tap at the gate.
   */
  private async supersedePendingManual(
    organizationId: string,
    worker: { id: string; fullName: string },
    ctx: TapContext,
    scan: {
      tapType: 'LOGIN' | 'LOGOUT';
      at: Date;
      sessionId: string;
      timezone: string;
      source: TapSource;
    },
  ) {
    try {
      const pending = await this.prisma.manualAttendanceRequest.findFirst({
        where: { organizationId, workerId: worker.id, status: 'PENDING' },
        select: { id: true, tapType: true, recordedAt: true },
      });
      if (!pending) return;

      const scannedAt = DateTime.fromJSDate(scan.at, { zone: scan.timezone }).toFormat(
        'd LLL yyyy, h:mm a',
      );
      // Same words the review screen would have refused an Accept with, so the
      // note and the error tell one story.
      const how = describeMovement({ tapSource: scan.source, isManualBackup: false });
      const note =
        `Superseded automatically — ${how} logged ${worker.fullName} ` +
        `${scan.tapType === 'LOGIN' ? 'in' : 'out'} at ${scannedAt}, so this typed entry was no ` +
        'longer needed. Attendance follows the scan.';

      await this.prisma.manualAttendanceRequest.update({
        where: { id: pending.id },
        // REJECTED, not APPROVED: the typed punch never became attendance. The
        // null reviewer is what tells the queue a person did not decide this.
        data: {
          status: 'REJECTED',
          reviewedAt: new Date(),
          reviewNotes: note,
        },
      });

      await this.audit.record({
        organizationId,
        action: 'MANUAL_ATTENDANCE_SUPERSEDED',
        entityType: 'ManualAttendanceRequest',
        entityId: pending.id,
        deviceId: ctx.deviceId,
        ipAddress: ctx.ip,
        oldValue: {
          status: 'PENDING',
          tapType: pending.tapType,
          recordedAt: pending.recordedAt,
        },
        newValue: {
          status: 'REJECTED',
          supersededBy: {
            tapType: scan.tapType,
            at: scan.at,
            sessionId: scan.sessionId,
            source: scan.source,
          },
        },
        reason: note,
      });
    } catch (e) {
      this.logger.error(
        `Could not supersede the pending manual entry for worker=${worker.id}: ${String(e)}`,
      );
    }
  }

  /**
   * Live login state for one worker, so a device can scan somebody OUT even
   * though a *different* device recorded the login.
   *
   * The scanner decides LOGIN/LOGOUT from its own offline meta, which only ever
   * knows about taps that device made. Whenever it has a network it asks here
   * instead, and the server — the only place that sees every device — answers.
   * `lastTapAt` comes back too so the duplicate-tap cooldown also spans devices.
   */
  async workerTapState(organizationId: string, workerId: string) {
    if (!workerId) throw Errors.validation({ message: 'workerId is required' });
    const [session, lastTap, pendingManual] = await Promise.all([
      this.prisma.attendanceSession.findFirst({
        where: { organizationId, workerId, state: 'OPEN' },
        select: { id: true, loginAt: true, siteId: true },
      }),
      this.prisma.attendanceTap.findFirst({
        where: { organizationId, workerId },
        orderBy: { clientEventTime: 'desc' },
        select: { clientEventTime: true, tapType: true },
      }),
      this.prisma.manualAttendanceRequest.findFirst({
        where: { organizationId, workerId, status: 'PENDING' },
        select: { id: true, tapType: true, recordedAt: true },
      }),
    ]);
    return {
      workerId,
      openSessionId: session?.id ?? null,
      loginAt: session?.loginAt ?? null,
      siteId: session?.siteId ?? null,
      lastTapAt: lastTap?.clientEventTime ?? null,
      // The device needs the direction as well as the time: the safety gap runs
      // from the last state *change*, so a LOGOUT starts the clock and an
      // ignored duplicate does not.
      lastTapType: lastTap?.tapType ?? null,
      // A hand-typed punch still awaiting review. The scanner shows this on the
      // worker's card so a watchman does not enter a second one, and so the man
      // standing at the gate is told *why* he is not on the list.
      pendingManual: pendingManual
        ? {
            id: pendingManual.id,
            tapType: pendingManual.tapType,
            recordedAt: pendingManual.recordedAt,
          }
        : null,
    };
  }

  /**
   * The scanner policy for one site, readable by a watchman's device.
   *
   * The full settings record sits behind SETTINGS_MANAGE, which a watchman does
   * not have — so before this existed the app fell back to a hardcoded 30-second
   * cooldown and quietly ignored whatever the admin panel said.
   */
  async siteConfig(user: AuthUser, siteId: string) {
    if (!siteId) throw Errors.validation({ message: 'siteId is required' });
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organizationId: user.organizationId },
      include: { settings: true },
    });
    if (!site) throw Errors.notFound('Site');
    if (
      user.role !== 'SUPER_ADMIN' &&
      user.siteScopes.length > 0 &&
      !user.siteScopes.includes(siteId)
    ) {
      throw Errors.forbidden('Site not in your scope');
    }
    const settings = site.settings ?? this.defaultSettings(siteId);
    return {
      siteId,
      verificationMode: settings.verificationMode,
      duplicateTapCooldownSeconds: settings.duplicateTapCooldownSeconds,
      safetyGapMinutes: settings.safetyGapMinutes,
      autoLoginCountdownSeconds: settings.autoLoginCountdownSeconds,
    };
  }

  /**
   * Every worker currently logged in across the org — the device pulls this
   * alongside its worker cache so it starts the day knowing who is already
   * inside, and can still scan them out after it drops offline.
   *
   * Not filtered by site: a logout is allowed to happen at a different gate
   * from the login (see `isCrossSite`), so narrowing this would reintroduce the
   * same blind spot at the site boundary.
   */
  async openSessions(organizationId: string) {
    const rows = await this.prisma.attendanceSession.findMany({
      where: { organizationId, state: 'OPEN' },
      select: { id: true, workerId: true, loginAt: true, siteId: true },
      take: 5000,
    });
    return { data: rows.map((r) => ({ ...r, sessionId: r.id })) };
  }

  private async maybeAuditManual(
    organizationId: string,
    ctx: TapContext,
    workerId: string,
    dto: TapDto,
  ) {
    if (dto.manual?.isBackup) {
      await this.audit.record({
        organizationId,
        action: 'ATTENDANCE_MANUAL_BACKUP',
        entityType: 'Worker',
        entityId: workerId,
        deviceId: ctx.deviceId,
        ipAddress: ctx.ip,
        reason: dto.manual.reason,
        newValue: { source: dto.source, siteId: dto.siteId },
      });
    }
  }

  /** Finalize a MANUAL-mode login after the watchman confirms the face match. */
  async confirm(organizationId: string, eventId: string, ctx: TapContext) {
    const tap = await this.prisma.attendanceTap.findUnique({
      where: { organizationId_eventId: { organizationId, eventId } },
    });
    if (!tap || tap.tapType !== 'LOGIN' || !tap.workerId) {
      throw Errors.notFound('Login tap');
    }
    // Confirming is the watchman saying "the face matches the badge" — it is not
    // an approval. A hand-typed punch has no badge to match, and letting this
    // endpoint commit one would hand the watchman the Safety Officer's decision.
    if (tap.isManualBackup) {
      throw Errors.businessRule(
        'This punch was entered by hand and is waiting for a Safety Officer to accept it.',
      );
    }
    const existing = await this.prisma.attendanceSession.findFirst({
      where: { loginTapId: tap.id },
    });
    if (existing) {
      return { result: 'LOGIN_RECORDED', sessionId: existing.id, loginAt: existing.loginAt };
    }

    const site = await this.prisma.site.findUnique({
      where: { id: tap.siteId },
      include: { settings: true },
    });
    const workDate = businessDate(tap.clientEventTime, site?.timezone ?? 'Asia/Kolkata');

    const session = await this.prisma.attendanceSession.create({
      data: {
        organizationId,
        workerId: tap.workerId,
        siteId: tap.siteId,
        shiftId: site?.settings?.defaultShiftId ?? null,
        workDate,
        loginTapId: tap.id,
        loginAt: tap.clientEventTime,
        state: 'OPEN',
      },
    });
    await this.ensureSiteAssignment(tap.workerId, tap.siteId);
    await this.auditScan('ATTENDANCE_LOGIN', {
      organizationId,
      workerId: tap.workerId,
      ctx,
      source: tap.tapSource,
      siteId: tap.siteId,
      sessionId: session.id,
      at: tap.clientEventTime,
      extra: { workDate: workDate.toISOString().slice(0, 10), verificationMode: 'MANUAL' },
    });
    const worker = await this.prisma.worker.findUnique({
      where: { id: tap.workerId },
      select: { id: true, fullName: true },
    });
    if (worker) {
      await this.supersedePendingManual(organizationId, worker, ctx, {
        tapType: 'LOGIN',
        at: tap.clientEventTime,
        sessionId: session.id,
        timezone: site?.timezone ?? 'Asia/Kolkata',
        source: tap.tapSource,
      });
    }
    return { result: 'LOGIN_RECORDED', sessionId: session.id, loginAt: session.loginAt };
  }

  private replayResult(tap: AttendanceTap) {
    return {
      result: 'IDEMPOTENT_REPLAY',
      eventId: tap.eventId,
      tapType: tap.tapType,
      tapId: tap.id,
    };
  }

  /** Open sessions; siteId omitted (or 'all') = every site in the caller's scope. */
  async activeSessions(user: AuthUser, siteId?: string, category?: string) {
    const siteFilter =
      siteId && siteId !== 'all'
        ? { siteId }
        : user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
          ? { siteId: { in: user.siteScopes } }
          : {};
    const categoryFilter =
      category && category !== 'all' ? { worker: { category: category as PersonCategory } } : {};
    return this.prisma.attendanceSession.findMany({
      where: {
        organizationId: user.organizationId,
        state: 'OPEN',
        ...siteFilter,
        ...categoryFilter,
      },
      include: {
        worker: {
          select: {
            id: true,
            fullName: true,
            photoUrl: true,
            workerCode: true,
            category: true,
            designation: { select: { name: true } },
            vendor: { select: { name: true } },
          },
        },
        site: { select: { id: true, name: true } },
      },
      orderBy: { loginAt: 'asc' },
    });
  }

  /**
   * Everyone who has LEFT the site today — the closed sessions, newest logout
   * first. The counterpart of [activeSessions]: that answers "who is still
   * here", this answers "who has gone home". AUTO_CLOSED sessions are excluded:
   * nobody scanned out of those, so they belong in the missed-logout list.
   */
  async loggedOutToday(user: AuthUser, siteId?: string, category?: string, dateStr?: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { timezone: true },
    });
    const date = dateStr
      ? new Date(dateStr)
      : businessDate(new Date(), org?.timezone ?? 'Asia/Kolkata');

    const siteFilter =
      siteId && siteId !== 'all'
        ? { siteId }
        : user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
          ? { siteId: { in: user.siteScopes } }
          : {};
    const categoryFilter =
      category && category !== 'all' ? { worker: { category: category as PersonCategory } } : {};

    const openSessions = await this.prisma.attendanceSession.findMany({
      where: {
        organizationId: user.organizationId,
        state: 'OPEN',
        ...siteFilter,
        ...categoryFilter,
      },
      select: { workerId: true },
    });
    const openWorkerIds = new Set(openSessions.map((s) => s.workerId));

    const closedSessions = await this.prisma.attendanceSession.findMany({
      where: {
        organizationId: user.organizationId,
        workDate: date,
        state: 'CLOSED',
        logoutAt: { not: null },
        ...siteFilter,
        ...categoryFilter,
      },
      select: {
        id: true,
        loginAt: true,
        logoutAt: true,
        workedMinutes: true,
        worker: {
          select: {
            id: true,
            fullName: true,
            photoUrl: true,
            workerCode: true,
            category: true,
            designation: { select: { name: true } },
            vendor: { select: { name: true } },
          },
        },
        site: { select: { id: true, name: true } },
      },
      orderBy: { logoutAt: 'desc' },
    });

    // The headline counts unique people for today. Keep this table/count on
    // the same basis: latest logout per person, excluding people currently
    // open in the same selected scope (they came back after logging out).
    const seenWorkerIds = new Set<string>();
    return closedSessions.filter((session) => {
      if (openWorkerIds.has(session.worker.id) || seenWorkerIds.has(session.worker.id)) {
        return false;
      }
      seenWorkerIds.add(session.worker.id);
      return true;
    });
  }

  /**
   * Day summary for the attendance dashboard: how many people logged in today,
   * broken down by designation, by vendor and by category. siteId omitted/'all'
   * = all sites in the caller's scope; category omitted/'all' = everyone.
   */
  async daySummary(user: AuthUser, siteId?: string, dateStr?: string, category?: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { timezone: true },
    });
    const date = dateStr
      ? new Date(dateStr)
      : businessDate(new Date(), org?.timezone ?? 'Asia/Kolkata');

    const siteFilter =
      siteId && siteId !== 'all'
        ? { siteId }
        : user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
          ? { siteId: { in: user.siteScopes } }
          : {};
    const categoryFilter =
      category && category !== 'all' ? { worker: { category: category as PersonCategory } } : {};

    const sessions = await this.prisma.attendanceSession.findMany({
      where: {
        organizationId: user.organizationId,
        workDate: date,
        state: { not: 'VOID' },
        ...siteFilter,
        ...categoryFilter,
      },
      select: {
        workerId: true,
        state: true,
        worker: {
          select: {
            category: true,
            designation: { select: { name: true } },
            vendor: { select: { name: true } },
          },
        },
      },
    });

    // A person may have several sessions in a day — count each once.
    const seen = new Map<
      string,
      { category: string; designation: string; vendor: string; open: boolean }
    >();
    for (const s of sessions) {
      const prev = seen.get(s.workerId);
      const open = s.state === 'OPEN' || prev?.open === true;
      seen.set(s.workerId, {
        category: s.worker.category,
        designation: s.worker.designation?.name ?? 'Unassigned',
        vendor: vendorGroupLabel(s.worker),
        open,
      });
    }

    const byDesignation = new Map<string, { count: number; active: number }>();
    const byVendor = new Map<string, { count: number; active: number }>();
    const byCategory = new Map<string, { count: number; active: number }>();
    for (const v of seen.values()) {
      const d = byDesignation.get(v.designation) ?? { count: 0, active: 0 };
      d.count += 1;
      if (v.open) d.active += 1;
      byDesignation.set(v.designation, d);

      const vn = byVendor.get(v.vendor) ?? { count: 0, active: 0 };
      vn.count += 1;
      if (v.open) vn.active += 1;
      byVendor.set(v.vendor, vn);

      const c = byCategory.get(v.category) ?? { count: 0, active: 0 };
      c.count += 1;
      if (v.open) c.active += 1;
      byCategory.set(v.category, c);
    }

    return {
      date: date.toISOString().slice(0, 10),
      total: seen.size,
      activeNow: [...seen.values()].filter((v) => v.open).length,
      byDesignation: [...byDesignation.entries()]
        .map(([designation, v]) => ({ designation, ...v }))
        .sort((a, b) => b.count - a.count),
      byVendor: [...byVendor.entries()]
        .map(([vendor, v]) => ({ vendor, ...v }))
        .sort((a, b) => b.count - a.count),
      byCategory: [...byCategory.entries()].map(([category, v]) => ({ category, ...v })),
    };
  }

  /**
   * The day summary as a branded PDF, for the Safety Officer to download from
   * the mobile app and hand over at the gate.
   *
   * Renders from exactly the same `daySummary` figures the screen shows, so the
   * sheet someone signs off can never disagree with the panel it was read from.
   */
  async daySummaryPdf(user: AuthUser, siteId?: string, dateStr?: string, category?: string) {
    const summary = await this.daySummary(user, siteId, dateStr, category);
    const [org, site] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: user.organizationId },
        select: { name: true },
      }),
      siteId && siteId !== 'all'
        ? this.prisma.site.findFirst({
            where: { id: siteId, organizationId: user.organizationId },
            select: { name: true },
          })
        : Promise.resolve(null),
    ]);

    const buffer = await renderDaySummaryPdf(
      {
        date: summary.date,
        total: summary.total,
        activeNow: summary.activeNow,
        byDesignation: summary.byDesignation.map((d) => ({
          name: d.designation,
          count: d.count,
          active: d.active,
        })),
        byVendor: summary.byVendor.map((v) => ({
          name: v.vendor,
          count: v.count,
          active: v.active,
        })),
      },
      org?.name ?? '',
      site?.name ?? (siteId && siteId !== 'all' ? undefined : 'All sites'),
    );

    return { buffer, filename: `attendance-summary-${summary.date}.pdf` };
  }

  /**
   * The registered workforce — everyone on the books, which is the denominator
   * the dashboard needs before it can say "attendance rate" and mean anything.
   *
   * Counts people, not sessions: ACTIVE and not soft-deleted. A scoped user sees
   * only those currently assigned to one of their sites, so their rate is
   * measured against their own workforce rather than the whole company's.
   */
  private async registeredWorkforce(user: AuthUser) {
    const scoped = user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0;
    const rows = await this.prisma.worker.groupBy({
      by: ['category'],
      where: {
        organizationId: user.organizationId,
        deletedAt: null,
        status: 'ACTIVE',
        ...(scoped
          ? { assignments: { some: { siteId: { in: user.siteScopes }, endDate: null } } }
          : {}),
      },
      _count: { _all: true },
    });

    const byCategory: Record<string, number> = { WORKER: 0, STAFF: 0, VISITOR: 0 };
    for (const r of rows) byCategory[r.category] = r._count._all;
    return {
      total: rows.reduce((sum, r) => sum + r._count._all, 0),
      byCategory,
    };
  }

  /**
   * Who moved through the gate today, and the same figures for yesterday so a
   * KPI card can show a real change rather than an invented one.
   *
   * Counts distinct *people*, not sessions — a worker who steps out and back in
   * has two sessions but turned up once, and "120 people on site" is the number
   * anyone would defend in a meeting.
   *
   * `checkedOut` is derived (turned up minus still here) rather than counted off
   * logout taps, so the three figures always reconcile on screen.
   */
  private async gateMovement(user: AuthUser, tz: string) {
    const scopeFilter =
      user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
        ? { siteId: { in: user.siteScopes } }
        : {};
    const today = businessDate(new Date(), tz);
    const yesterday = businessDate(new Date(Date.now() - 24 * 3600 * 1000), tz);

    const sessions = await this.prisma.attendanceSession.findMany({
      where: {
        organizationId: user.organizationId,
        workDate: { in: [today, yesterday] },
        state: { not: 'VOID' },
        ...scopeFilter,
      },
      select: {
        workerId: true,
        workDate: true,
        state: true,
        lateMinutes: true,
        worker: { select: { category: true } },
      },
      take: 20000,
    });

    const tally = (day: Date) => {
      const turnedUp = new Set<string>();
      const stillHere = new Set<string>();
      const late = new Set<string>();
      const workers = new Set<string>();
      for (const s of sessions) {
        if (s.workDate.getTime() !== day.getTime()) continue;
        turnedUp.add(s.workerId);
        if (s.worker.category === 'WORKER') workers.add(s.workerId);
        if (s.state === 'OPEN') stillHere.add(s.workerId);
        if ((s.lateMinutes ?? 0) > 0) late.add(s.workerId);
      }
      return {
        checkedIn: turnedUp.size,
        onSite: stillHere.size,
        checkedOut: turnedUp.size - stillHere.size,
        lateArrivals: late.size,
        workersCheckedIn: workers.size,
      };
    };

    return {
      date: today.toISOString().slice(0, 10),
      today: tally(today),
      yesterday: tally(yesterday),
    };
  }

  /**
   * KPIs for the admin dashboard home: who is on site right now (by category,
   * with names for the hover detail), who missed logout yesterday — i.e.
   * sessions the system had to AUTO_CLOSE because no logout tap ever came — the
   * registered workforce behind those numbers, and today's gate movement next to
   * yesterday's so the cards can show a real change.
   */
  async dashboardStats(user: AuthUser) {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { timezone: true },
    });
    const tz = org?.timezone ?? 'Asia/Kolkata';
    const scopeFilter =
      user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
        ? { siteId: { in: user.siteScopes } }
        : {};

    const select = {
      loginAt: true,
      workDate: true,
      worker: { select: { fullName: true, workerCode: true, category: true } },
      site: { select: { name: true } },
    } as const;

    const open = await this.prisma.attendanceSession.findMany({
      where: { organizationId: user.organizationId, state: 'OPEN', ...scopeFilter },
      select,
      orderBy: { loginAt: 'asc' },
    });

    const yesterday = businessDate(new Date(Date.now() - 24 * 3600 * 1000), tz);
    // Missed logouts = sessions auto-closed on next login (yesterday) plus
    // sessions still OPEN that the forgot-logout monitor has flagged (they are
    // no longer auto-closed — an admin/safety officer must act on them).
    const missed = await this.prisma.attendanceSession.findMany({
      where: {
        organizationId: user.organizationId,
        OR: [
          { state: 'AUTO_CLOSED', workDate: yesterday },
          { state: 'OPEN', forgotLogoutNotifiedAt: { not: null } },
        ],
        ...scopeFilter,
      },
      select,
      orderBy: { loginAt: 'asc' },
    });

    const today = businessDate(new Date(), tz);
    /**
     * A session still open from an earlier business day.
     *
     * These are almost always somebody who went home without scanning out, and
     * they are why "on site" reads differently around the panel: a screen that
     * counts every open session includes them, one that counts today's sessions
     * does not. Marking each person lets both dashboards show the split instead
     * of leaving people to work out the difference themselves.
     */
    const isCarriedOver = (s: (typeof open)[number]) => s.workDate.getTime() < today.getTime();

    type Row = (typeof open)[number];
    const bucket = (rows: Row[]) => {
      const byCategory: Record<
        string,
        {
          count: number;
          people: {
            fullName: string;
            workerCode: string;
            siteName: string | null;
            loginAt: Date;
            workDate: string;
            carriedOver: boolean;
          }[];
        }
      > = {};
      for (const s of rows) {
        const cat = s.worker.category;
        const b = (byCategory[cat] ??= { count: 0, people: [] });
        b.count += 1;
        if (b.people.length < 200) {
          b.people.push({
            fullName: s.worker.fullName,
            workerCode: s.worker.workerCode,
            siteName: s.site?.name ?? null,
            loginAt: s.loginAt,
            workDate: s.workDate.toISOString().slice(0, 10),
            carriedOver: isCarriedOver(s),
          });
        }
      }
      return byCategory;
    };

    const carriedOver = open.filter(isCarriedOver);

    const [workforce, movement] = await Promise.all([
      this.registeredWorkforce(user),
      this.gateMovement(user, tz),
    ]);

    return {
      onSiteNow: {
        total: open.length,
        byCategory: bucket(open),
        // total = today + carriedOver, always. Both dashboards show the split
        // rather than one number that quietly means two different things.
        today: open.length - carriedOver.length,
        carriedOver: carriedOver.length,
      },
      missedLogout: {
        date: yesterday.toISOString().slice(0, 10),
        total: missed.length,
        byCategory: bucket(missed),
      },
      workforce,
      movement,
    };
  }

  /**
   * Chart series for the dashboard: 7-day attendance/missed-logout trend,
   * per-site people on site now, on-site category split, pending corrections
   * by site and today's vendor-wise attendance.
   */
  async dashboardCharts(user: AuthUser, range: { from?: string; to?: string } = {}) {
    const org = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { timezone: true },
    });
    const tz = org?.timezone ?? 'Asia/Kolkata';
    const scopeFilter =
      user.role !== 'SUPER_ADMIN' && user.siteScopes.length > 0
        ? { siteId: { in: user.siteScopes } }
        : {};
    const orgScope = { organizationId: user.organizationId, ...scopeFilter };

    const today = businessDate(new Date(), tz);
    // The vendor trend spans 30 days; every other series is "now" or "today".
    const from = new Date(today.getTime() - 29 * 86_400_000);
    // The manpower panel follows its own picked window, which can sit outside
    // the 30-day vendor window entirely, so it gets a query of its own.
    const { start: rangeStart, end: rangeEnd } = resolveManpowerRange(range.from, range.to, today);

    const [windowSessions, openNow, pendingCorrections, todaySessions, rangeSessions] =
      await Promise.all([
        // Manpower charts count labour only — staff and visitors are on site but
        // are not manpower, so they are filtered out at the query.
        this.prisma.attendanceSession.findMany({
          where: { ...orgScope, workDate: { gte: from }, worker: { category: 'WORKER' } },
          select: {
            workDate: true,
            workedMinutes: true,
            worker: {
              select: {
                category: true,
                vendor: { select: { name: true } },
                designation: { select: { name: true } },
              },
            },
          },
          take: 20000,
        }),
        this.prisma.attendanceSession.findMany({
          where: { ...orgScope, state: 'OPEN' },
          select: {
            site: { select: { name: true } },
            worker: { select: { category: true } },
          },
        }),
        this.prisma.correctionRequest.findMany({
          where: { ...orgScope, status: 'PENDING' },
          select: { siteId: true },
        }),
        // Today's labour, kept as its own query rather than sliced off the 30-day
        // window so a large org hitting that query's row cap cannot skew today.
        this.prisma.attendanceSession.findMany({
          where: { ...orgScope, workDate: today, worker: { category: 'WORKER' } },
          select: {
            workedMinutes: true,
            worker: {
              select: {
                category: true,
                vendor: { select: { name: true } },
                designation: { select: { name: true } },
              },
            },
          },
          take: 5000,
        }),
        // The manpower panel's window: trend, by-trade and by-vendor are all
        // tallied across these days rather than a single day.
        this.prisma.attendanceSession.findMany({
          where: {
            ...orgScope,
            workDate: { gte: rangeStart, lte: rangeEnd },
            worker: { category: 'WORKER' },
          },
          select: {
            workDate: true,
            workedMinutes: true,
            worker: {
              select: {
                category: true,
                vendor: { select: { name: true } },
                designation: { select: { name: true } },
              },
            },
          },
          take: 20000,
        }),
      ]);

    const dayKey = (d: Date) => d.toISOString().slice(0, 10);

    // Vendor-wise man-days per day across the window — one line per vendor.
    // Days with no attendance still appear, so gaps read as gaps.
    const days: string[] = [];
    for (let i = 29; i >= 0; i--) days.push(dayKey(new Date(today.getTime() - i * 86_400_000)));
    // Each vendor keeps a day -> designation -> count cube, so the chart can
    // draw a line from the day totals and the tooltip can break a day down by
    // trade without a second round trip.
    const dayIndex = new Map(days.map((d, i) => [d, i]));
    type Cube = Map<string, Map<string, number>>; // day -> designation -> count
    const bump = (cube: Cube, day: string, designation: string) => {
      let byDesignation = cube.get(day);
      if (!byDesignation) {
        byDesignation = new Map();
        cube.set(day, byDesignation);
      }
      byDesignation.set(designation, (byDesignation.get(designation) ?? 0) + 1);
    };
    const perVendor = new Map<string, Cube>();
    const allVendors: Cube = new Map();
    for (const s of windowSessions) {
      const name = vendorGroupLabel(s.worker);
      const designation = s.worker.designation?.name?.trim() || 'No designation';
      const day = dayKey(s.workDate);
      if (!dayIndex.has(day)) continue;
      let cube = perVendor.get(name);
      if (!cube) {
        cube = new Map();
        perVendor.set(name, cube);
      }
      bump(cube, day, designation);
      bump(allVendors, day, designation);
    }

    // Counts per day, and the matching designation split per day. Splits are
    // sorted heaviest-first and emitted as plain objects for the JSON payload.
    const spread = (cube: Cube) => {
      const counts: number[] = [];
      const splits: Record<string, number>[] = [];
      for (const d of days) {
        const byDesignation = cube.get(d);
        counts.push(byDesignation ? [...byDesignation.values()].reduce((a, b) => a + b, 0) : 0);
        splits.push(
          Object.fromEntries([...(byDesignation ?? new Map())].sort((a, b) => b[1] - a[1])),
        );
      }
      return { counts, splits };
    };

    const ranked = [...perVendor.entries()]
      .map(([vendor, cube]) => {
        const { counts, splits } = spread(cube);
        return {
          vendor,
          total: counts.reduce((a, b) => a + b, 0),
          data: counts,
          splits,
        };
      })
      // Busiest vendors first; the chart palette only carries eight hues.
      .sort((a, b) => b.total - a.total);
    const shown = ranked.slice(0, 8);

    const grand = spread(allVendors);
    // Anything past the top 8 has no line, so the tooltip totals would not add
    // up. Roll the remainder into one row that reconciles the arithmetic.
    const otherTotals = days.map((_, i) =>
      Math.max(0, grand.counts[i] - shown.reduce((sum, s) => sum + s.data[i], 0)),
    );

    const vendorTrend = {
      days,
      series: shown,
      totals: grand.counts,
      totalSplits: grand.splits,
      otherTotals,
      hiddenVendorCount: ranked.length - shown.length,
    };

    const tally = <T>(rows: T[], key: (r: T) => string) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };

    // Manpower panel: trend, trades and vendors all across the picked window.
    // Distinct from the 30-day vendor chart above, which is per vendor rather
    // than total. The headline tiles below stay "today" — they are the live
    // overview and must not move when someone browses back a week.
    const rangeDays: string[] = [];
    for (let d = rangeStart.getTime(); d <= rangeEnd.getTime(); d += 86_400_000) {
      rangeDays.push(dayKey(new Date(d)));
    }
    const rangeIndex = new Map(rangeDays.map((d, i) => [d, i]));
    const manpowerTrend = new Array<number>(rangeDays.length).fill(0);
    for (const s of rangeSessions) {
      const i = rangeIndex.get(dayKey(s.workDate));
      if (i !== undefined) manpowerTrend[i] += 1;
    }

    const manHoursToday = todaySessions.reduce((sum, s) => sum + (s.workedMinutes ?? 0), 0) / 60;
    const activeTradesToday = new Set(
      todaySessions.map((s) => s.worker.designation?.name?.trim() || 'No designation'),
    ).size;

    const manpower = {
      days: rangeDays,
      trend: manpowerTrend,
      from: dayKey(rangeStart),
      to: dayKey(rangeEnd),
      // Man-days across the window: one worker on five days counts five.
      totalManDays: rangeSessions.length,
      totalToday: todaySessions.length,
      // One decimal is enough — this is a headline tile, not a payroll figure.
      manHoursToday: Math.round(manHoursToday * 10) / 10,
      activeTrades: activeTradesToday,
      byTrade: tally(
        rangeSessions,
        (s) => s.worker.designation?.name?.trim() || 'No designation',
      ).map(([trade, count]) => ({ trade, count })),
      byVendor: tally(rangeSessions, (s) => vendorGroupLabel(s.worker)).map(([vendor, count]) => ({
        vendor,
        count,
      })),
    };

    return {
      vendorTrend,
      manpower,
      siteWise: tally(openNow, (s) => s.site?.name ?? 'Unknown site').map(([name, count]) => ({
        site: name,
        onSite: count,
      })),
      distribution: tally(openNow, (s) => s.worker.category).map(([category, count]) => ({
        category,
        onSite: count,
      })),
      correctionsBySite: await (async () => {
        const siteNames = new Map(
          (
            await this.prisma.site.findMany({
              where: { organizationId: user.organizationId },
              select: { id: true, name: true },
            })
          ).map((s) => [s.id, s.name]),
        );
        return tally(pendingCorrections, (c) => siteNames.get(c.siteId) ?? 'Unknown site').map(
          ([name, count]) => ({ site: name, pending: count }),
        );
      })(),
      vendorToday: tally(todaySessions, (s) => vendorGroupLabel(s.worker))
        .slice(0, 8)
        .map(([name, count]) => ({ vendor: name, count })),
    };
  }

  /** Supervisor monthly summary for a worker (docs/03 §5). */
  async workerSummary(organizationId: string, workerId: string, month: string) {
    const [year, mon] = month.split('-').map((n) => parseInt(n, 10));
    if (!year || !mon) throw Errors.validation({ message: 'month must be YYYY-MM' });
    const from = new Date(Date.UTC(year, mon - 1, 1));
    const to = new Date(Date.UTC(year, mon, 1));

    const worker = await this.prisma.worker.findFirst({
      where: { id: workerId, organizationId },
      select: { id: true, fullName: true, photoUrl: true },
    });
    if (!worker) throw Errors.workerNotFound();

    const sessions = await this.prisma.attendanceSession.findMany({
      where: { workerId, organizationId, workDate: { gte: from, lt: to } },
      orderBy: { workDate: 'asc' },
    });

    const totalMinutes = sessions.reduce((s, x) => s + (x.workedMinutes ?? 0), 0);
    const overtime = sessions.reduce((s, x) => s + (x.overtimeMinutes ?? 0), 0);
    const lateArrivals = sessions.filter((x) => (x.lateMinutes ?? 0) > 0).length;
    const workedDays = new Set(sessions.map((x) => x.workDate.toISOString().slice(0, 10))).size;
    const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();

    return {
      worker,
      month,
      totalMonthlyMinutes: totalMinutes,
      overtimeMinutes: overtime,
      absentDays: Math.max(0, daysInMonth - workedDays),
      lateArrivals,
      daily: sessions.map((x) => ({
        date: x.workDate.toISOString().slice(0, 10),
        loginAt: x.loginAt,
        logoutAt: x.logoutAt,
        workedMinutes: x.workedMinutes,
        overtimeMinutes: x.overtimeMinutes,
        late: (x.lateMinutes ?? 0) > 0,
        earlyLeave: (x.earlyLeaveMinutes ?? 0) > 0,
        state: x.state,
      })),
    };
  }
}

// Re-export Prisma type to satisfy unused import lint when tree-shaken.
export type { Prisma };
