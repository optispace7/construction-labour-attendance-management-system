import { Injectable } from '@nestjs/common';
import { SyncEventStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AttendanceService, TapContext } from './attendance.service';
import { AppException } from '../../common/errors/app.exception';
import { TapDto } from './dto/attendance.dto';

export interface EventResult {
  eventId: string;
  status: SyncEventStatus;
  detail?: string;
  tapId?: string;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
  ) {}

  /**
   * Ingest an offline batch. Each event is processed independently through the
   * same idempotent tap handler. One bad event never fails the whole batch —
   * it is recorded as CONFLICT/REJECTED and surfaced back to the device.
   */
  async ingest(organizationId: string, deviceId: string, events: TapDto[], ctx: TapContext) {
    const results: EventResult[] = [];

    for (const event of events) {
      try {
        const res = await this.attendance.handleTap(organizationId, event, ctx);
        if (res.result === 'IDEMPOTENT_REPLAY') {
          // Heal MANUAL-mode logins whose session was never confirmed (the
          // device was offline or died before the confirm round-trip). Never a
          // hand-typed punch: that one is waiting on a Safety Officer, and
          // confirm() refuses it — replaying it must not look like a failure.
          if ('tapType' in res && res.tapType === 'LOGIN' && !event.manual?.isBackup) {
            try {
              await this.attendance.confirm(organizationId, event.eventId, ctx);
            } catch {
              // unresolved tap or already closed — leave as duplicate
            }
          }
          results.push({ eventId: event.eventId, status: 'DUPLICATE' });
        } else {
          // Offline ingest has no interactive confirm step — the watchman
          // already verified the worker at scan time, so commit immediately.
          // A manual entry is the exception: it comes back
          // MANUAL_PENDING_APPROVAL and stays that way until reviewed.
          if (res.result === 'LOGIN_PENDING_CONFIRM') {
            await this.attendance.confirm(organizationId, event.eventId, ctx);
          }
          results.push({
            eventId: event.eventId,
            status: 'ACCEPTED',
            tapId: 'tapId' in res ? (res.tapId as string) : undefined,
          });
        }
      } catch (err) {
        if (err instanceof AppException) {
          // TAP_TOO_SOON rides with DUPLICATE_TAP: both mean "a real scan the
          // rules say not to act on". The device drops the event rather than
          // retrying it forever — and a replay from an old build that never
          // knew about the safety gap is stopped here just the same.
          if (err.code === 'DUPLICATE_TAP' || err.code === 'TAP_TOO_SOON') {
            results.push({
              eventId: event.eventId,
              status: 'DUPLICATE',
              detail: err.detail ?? err.title,
            });
          } else if (err.code === 'WORKER_NOT_FOUND' || err.code === 'CONFLICT') {
            results.push({ eventId: event.eventId, status: 'CONFLICT', detail: err.title });
          } else {
            // Terminal: the device must drop this event rather than retry it.
            // Prefer the specific sentence (e.g. whose card expired, and when)
            // over the generic title.
            results.push({
              eventId: event.eventId,
              status: 'REJECTED',
              detail: err.detail ?? err.title,
            });
          }
        } else {
          results.push({ eventId: event.eventId, status: 'REJECTED', detail: 'internal error' });
        }
      }
    }

    const summary = {
      accepted: results.filter((r) => r.status === 'ACCEPTED').length,
      duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      conflicts: results.filter((r) => r.status === 'CONFLICT').length,
      rejected: results.filter((r) => r.status === 'REJECTED').length,
    };

    const batch = await this.prisma.syncBatch.create({
      data: {
        deviceId,
        eventCount: events.length,
        accepted: summary.accepted,
        duplicates: summary.duplicates,
        conflicts: summary.conflicts,
        rejected: summary.rejected,
        events: {
          create: results.map((r) => ({
            eventId: r.eventId,
            status: r.status,
            detail: r.detail,
            tapId: r.tapId,
          })),
        },
      },
    });

    return { batchId: batch.id, summary, results };
  }
}
