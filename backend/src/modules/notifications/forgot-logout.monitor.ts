import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { D1Service } from '../../infra/d1/d1.service';
import {
  attendanceSessions,
  notifications,
  pushTokens,
  sites,
  sosEvents,
  users,
  workers,
} from '../../infra/d1/schema.generated';
import { MailService } from '../../common/mail/mail.service';
import { PushService } from '../../common/push/push.service';
import { businessDate } from '../../common/time/time.util';
import { NotificationsService } from './notifications.service';
import { intervalMonitorsEnabled } from '../../common/scheduling/interval-monitors';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const NOTIFICATION_RETENTION_DAYS = 30;
const SOS_RETENTION_DAYS = 180;
// Missed-logout alerts go to Admins + Safety Officers, NOT the Super Admin.
const MISSED_LOGOUT_ROLES: UserRole[] = ['SITE_ADMIN', 'SUPERVISOR'];

/**
 * Housekeeping monitor (runs in API + worker; all actions are claim-guarded
 * or idempotent, so replicas never double-act):
 *
 * 1. Forgot-logout: sessions OPEN longer than FORGOT_LOGOUT_AFTER_HOURS
 *    (default 12h) are NOT auto-closed — they stay OPEN and Admins + Safety
 *    Officers are alerted (email + in-app feed + push) to log the person out
 *    or raise a correction.
 * 2. Visitor passes: visitors whose visit date has passed are marked EXITED —
 *    their QR stops working (taps resolve ACTIVE people only).
 * 3. Retention: notifications older than 30 days and SOS events older than
 *    180 days are pruned.
 */
@Injectable()
export class ForgotLogoutMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ForgotLogoutMonitor.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly d1: D1Service,
    private readonly mail: MailService,
    private readonly push: PushService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // Where there is no process between requests, the platform scheduler calls
    // check() instead — see interval-monitors.ts.
    if (!intervalMonitorsEnabled()) return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    // First pass shortly after boot.
    setTimeout(() => void this.check(), 30_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async check() {
    try {
      await this.notifyForgotten();
      await this.expireVisitors();
      await this.pruneOldRows();
    } catch (e) {
      this.logger.error(`Housekeeping run failed: ${(e as Error).message}`);
    }
  }

  private async notifyForgotten() {
    const hours = Number(process.env.FORGOT_LOGOUT_AFTER_HOURS ?? 12);
    const cutoff = new Date(Date.now() - hours * 3600_000);

    // The relation includes become joins; the columns pulled are the same.
    const stale = await this.d1.db
      .select({
        id: attendanceSessions.id,
        organizationId: attendanceSessions.organizationId,
        loginAt: attendanceSessions.loginAt,
        workerName: workers.fullName,
        workerCode: workers.workerCode,
        category: workers.category,
        siteName: sites.name,
      })
      .from(attendanceSessions)
      .innerJoin(workers, eq(workers.id, attendanceSessions.workerId))
      .innerJoin(sites, eq(sites.id, attendanceSessions.siteId))
      .where(
        and(
          eq(attendanceSessions.state, 'OPEN'),
          lt(attendanceSessions.loginAt, cutoff),
          isNull(attendanceSessions.forgotLogoutNotifiedAt),
        ),
      )
      .limit(200);
    if (stale.length === 0) return;

    interface MissedSession {
      sessionId: string;
      workerName: string;
      workerCode: string;
      category: string;
      siteName: string;
      loginAt: string;
    }
    const byOrg = new Map<string, MissedSession[]>();
    for (const s of stale) {
      // Atomic claim — only the process that flips the flag acts on it.
      // Atomic claim, and it stays atomic here: the null check is in the
      // WHERE, so two runs racing cannot both take the same session.
      const claimed = await this.d1.db
        .update(attendanceSessions)
        .set({ forgotLogoutNotifiedAt: new Date() })
        .where(
          and(
            eq(attendanceSessions.id, s.id),
            isNull(attendanceSessions.forgotLogoutNotifiedAt),
          ),
        );
      if (((claimed as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
        continue;
      }

      // The session deliberately stays OPEN — no auto-logout. Admins/safety
      // officers are notified below and close it via logout or a correction.
      const list = byOrg.get(s.organizationId) ?? [];
      list.push({
        sessionId: s.id,
        workerName: s.workerName,
        workerCode: s.workerCode,
        category: s.category,
        siteName: s.siteName,
        loginAt: (s.loginAt as Date).toISOString(),
      });
      byOrg.set(s.organizationId, list);
    }

    for (const [orgId, sessions] of byOrg) {
      // One summary notification per batch ("5 workers didn't logout") — the
      // full who-list rides in data.sessions for the admin click-through.
      const counts = new Map<string, number>();
      for (const m of sessions) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const label = (cat: string) =>
        cat === 'WORKER' ? 'worker' : cat === 'STAFF' ? 'staff member' : 'visitor';
      const title =
        [...counts.entries()].map(([cat, n]) => plural(n, label(cat))).join(' & ') +
        ` didn't logout`;
      const preview = sessions
        .slice(0, 5)
        .map((m) => `${m.workerName} (${m.workerCode}) at ${m.siteName}`)
        .join(', ');
      const body =
        `${preview}${sessions.length > 5 ? ` and ${sessions.length - 5} more` : ''}. ` +
        `Their sessions are still open — log them out or raise a correction.`;
      await this.notifications.create({
        organizationId: orgId,
        type: 'FORGOT_LOGOUT',
        title,
        body,
        siteId: null,
        data: { sessions, autoClosed: false } as unknown as Prisma.InputJsonValue,
      });

      // Missed-logout alerts go to Admins + Safety Officers (not the Super Admin).
      const lines = sessions.map(
        (m) => `${m.workerName} (${m.workerCode}) at ${m.siteName} — login ${m.loginAt}`,
      );
      const emails = await this.notifications.alertEmails(orgId, MISSED_LOGOUT_ROLES);
      await this.mail.send(
        emails,
        `CLAMS: ${lines.length} person(s) didn't log out`,
        `The following sessions have been open for more than ${hours} hours ` +
          `(no logout recorded). They have NOT been closed automatically:\n\n` +
          lines.join('\n') +
          `\n\nPlease log them out or raise an attendance correction.`,
      );

      // Push to the same roles so the alert reaches phones/web too.
      const recipients = await this.d1.db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.organizationId, orgId),
            eq(users.isActive, true),
            isNull(users.deletedAt),
            inArray(users.role, MISSED_LOGOUT_ROLES),
          ),
        );
      const recipientIds = recipients.map((u) => u.id);
      const tokens = recipientIds.length
        ? await this.d1.db
            .select({ token: pushTokens.token })
            .from(pushTokens)
            .where(
              and(
                eq(pushTokens.organizationId, orgId),
                inArray(pushTokens.userId, recipientIds),
              ),
            )
        : [];
      const stale2 = await this.push.sendAlert(
        tokens.map((t) => t.token),
        { title, body, data: { kind: 'FORGOT_LOGOUT' } },
      );
      if (stale2.length) await this.notifications.pruneTokens(stale2);
    }
    this.logger.log(`Notified about ${stale.length} forgotten session(s) (left open)`);
  }

  /** Visitors are day passes: once the visit date has passed, mark EXITED. */
  private async expireVisitors() {
    const today = businessDate(new Date(), 'Asia/Kolkata');
    // join_date is a calendar day held as text, so the comparison is a text
    // one — 'YYYY-MM-DD' orders correctly, which is why the column is that
    // shape rather than an instant.
    const todayText = today.toISOString().slice(0, 10);
    const expired = await this.d1.db
      .select({ id: workers.id, joinDate: workers.joinDate, fullName: workers.fullName })
      .from(workers)
      .where(
        and(
          eq(workers.category, 'VISITOR'),
          eq(workers.status, 'ACTIVE'),
          isNull(workers.deletedAt),
          lt(workers.joinDate, todayText),
        ),
      )
      .limit(200);
    for (const v of expired) {
      await this.d1.db
        .update(workers)
        .set({ status: 'EXITED', exitDate: v.joinDate ?? todayText, updatedAt: new Date() })
        .where(eq(workers.id, v.id));
    }
    if (expired.length > 0) {
      this.logger.log(`Expired ${expired.length} visitor pass(es)`);
    }
  }

  private async pruneOldRows() {
    const notifCutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
    const sosCutoff = new Date(Date.now() - SOS_RETENTION_DAYS * 86_400_000);
    await this.d1.db.delete(notifications).where(lt(notifications.createdAt, notifCutoff));
    await this.d1.db.delete(sosEvents).where(lt(sosEvents.createdAt, sosCutoff));
  }
}
