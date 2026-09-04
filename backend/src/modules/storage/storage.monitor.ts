import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService, STORAGE_WARN_PCT, STORAGE_CRITICAL_PCT } from './storage.service';
import { intervalMonitorsEnabled } from '../../common/scheduling/interval-monitors';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
// Don't re-alert the same level more than once per this window (anti-spam).
const RENOTIFY_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Watches total database storage against DB_STORAGE_LIMIT_BYTES and posts an
 * admin notification (+ email) when usage crosses 80% (WARNING) or 90%
 * (CRITICAL). Host-agnostic: usage comes from pg_database_size, not any cloud
 * provider API. No-ops when the cap is unconfigured.
 */
@Injectable()
export class StorageMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageMonitor.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  onModuleInit() {
    // Where there is no process between requests, the platform scheduler calls
    // check() instead — see interval-monitors.ts.
    if (!intervalMonitorsEnabled()) return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.check(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async check() {
    try {
      const limit = this.storage.limitBytes();
      if (!limit) return; // cap not configured → nothing to compare against
      const used = await this.storage.usedBytes();
      const pct = used / limit;
      const level =
        pct >= STORAGE_CRITICAL_PCT ? 'CRITICAL' : pct >= STORAGE_WARN_PCT ? 'WARNING' : null;
      if (!level) return;

      const orgs = await this.prisma.organization.findMany({ select: { id: true } });
      for (const org of orgs) {
        await this.notifyOrg(org.id, level, used, limit, pct);
      }
    } catch (e) {
      this.logger.error(`Storage check failed: ${(e as Error).message}`);
    }
  }

  private async notifyOrg(
    organizationId: string,
    level: 'WARNING' | 'CRITICAL',
    used: number,
    limit: number,
    pct: number,
  ) {
    const type = level === 'CRITICAL' ? 'STORAGE_CRITICAL' : 'STORAGE_WARNING';
    const recent = await this.prisma.notification.findFirst({
      where: {
        organizationId,
        type,
        createdAt: { gt: new Date(Date.now() - RENOTIFY_AFTER_MS) },
      },
    });
    if (recent) return; // already alerted this level recently

    const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(2);
    const pctStr = (pct * 100).toFixed(1);
    const oldest = (await this.storage.siteUsage(organizationId))[0];
    const title =
      level === 'CRITICAL'
        ? `Storage critical — ${pctStr}% used`
        : `Storage running low — ${pctStr}% used`;
    const body =
      `Using ${gb(used)} GB of ${gb(limit)} GB (${pctStr}%). ` +
      (oldest
        ? `Free space by clearing the oldest site "${oldest.name}" ` +
          `(≈${gb(oldest.freeableBytesEstimate)} GB) after downloading its backup.`
        : `Open Storage settings to free space.`);

    await this.notifications.create({
      organizationId,
      type,
      title,
      body,
      data: {
        usedBytes: used,
        limitBytes: limit,
        usedPercent: pct,
        oldestSiteId: oldest?.id ?? null,
      },
    });

    const emails = await this.notifications.alertEmails(organizationId, ['SUPER_ADMIN']);
    await this.mail.send(emails, `CLAMS: ${title}`, body);
    this.logger.warn(`Storage ${level} for org ${organizationId}: ${pctStr}%`);
  }
}
