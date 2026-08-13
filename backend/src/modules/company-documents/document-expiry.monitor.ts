import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { daysUntil, formatDay } from './company-documents.service';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
// Super Admins only. Renewing a licence is not a site's job, and the company's
// own contact address is not on this list either — it is printed on ID cards
// and may be a reception inbox, not the person who chases the renewal.
const DOCUMENT_ROLES: UserRole[] = ['SUPER_ADMIN'];

interface DueDocument {
  id: string;
  name: string;
  validUntil: Date;
  daysLeft: number;
}

/**
 * Emails the Super Admins before one of the company's documents stops being valid.
 *
 * A document is due when today (in the company's own timezone) is within its
 * `remindDaysBefore` window, and due again on the day it lapses. Each mail is
 * claimed by writing the validity date it covers into the row, so the API and
 * the worker replica — which both host this monitor — can never send the same
 * reminder twice, and re-dating a renewed document arms it again by itself.
 */
@Injectable()
export class DocumentExpiryMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentExpiryMonitor.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.check(), 90_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async check() {
    try {
      const orgs = await this.prisma.organization.findMany({
        select: { id: true, timezone: true },
      });
      for (const org of orgs) {
        await this.checkOrg(org);
      }
    } catch (e) {
      this.logger.error(`Document expiry check failed: ${(e as Error).message}`);
    }
  }

  private async checkOrg(org: { id: string; timezone: string }) {
    const docs = await this.prisma.companyDocument.findMany({
      where: { organizationId: org.id, validUntil: { not: null } },
      // The already-sent columns are deliberately not read here: whether a mail
      // is still owed is decided by the conditional update in claim(), which is
      // what makes two replicas racing on the same row safe.
      select: { id: true, name: true, validUntil: true, remindDaysBefore: true },
    });

    const expiring: DueDocument[] = [];
    const expired: DueDocument[] = [];

    for (const doc of docs) {
      if (!doc.validUntil) continue;
      const daysLeft = daysUntil(doc.validUntil, org.timezone);
      const due = { id: doc.id, name: doc.name, validUntil: doc.validUntil, daysLeft };

      if (daysLeft < 0) {
        if (await this.claim(doc.id, 'expirySentFor', doc.validUntil)) expired.push(due);
      } else if (daysLeft <= doc.remindDaysBefore) {
        if (await this.claim(doc.id, 'reminderSentFor', doc.validUntil)) expiring.push(due);
      }
    }

    if (expiring.length === 0 && expired.length === 0) return;

    const recipients = await this.notifications.alertEmails(org.id, DOCUMENT_ROLES);
    if (expiring.length) await this.announce(org.id, recipients, expiring, false);
    if (expired.length) await this.announce(org.id, recipients, expired, true);
  }

  /**
   * Writes the validity date this mail covers into `column`, but only if it is
   * not already there. The row is ours to act on when the update touched it.
   */
  private async claim(
    id: string,
    column: 'reminderSentFor' | 'expirySentFor',
    validUntil: Date,
  ): Promise<boolean> {
    const claimed = await this.prisma.companyDocument.updateMany({
      where: {
        id,
        OR: [{ [column]: null }, { [column]: { not: validUntil } }],
      } as Prisma.CompanyDocumentWhereInput,
      data: { [column]: validUntil },
    });
    return claimed.count > 0;
  }

  /** One notification per document (each is its own to-do), one mail per batch. */
  private async announce(
    organizationId: string,
    recipients: string[],
    docs: DueDocument[],
    hasExpired: boolean,
  ) {
    for (const doc of docs) {
      await this.notifications.create({
        organizationId,
        type: hasExpired ? 'DOCUMENT_EXPIRED' : 'DOCUMENT_EXPIRING',
        title: hasExpired
          ? `"${doc.name}" has expired`
          : `"${doc.name}" expires ${inDays(doc.daysLeft)}`,
        body: `Validity ends ${formatDay(doc.validUntil)}. Upload the renewed document on the Company page.`,
        data: {
          documentId: doc.id,
          name: doc.name,
          validUntil: formatDay(doc.validUntil),
          daysLeft: doc.daysLeft,
        },
      });
    }

    const lines = docs.map(
      (d) =>
        `• ${d.name} — valid until ${formatDay(d.validUntil)} ` +
        (d.daysLeft < 0
          ? `(expired ${Math.abs(d.daysLeft)} day(s) ago)`
          : `(${inDays(d.daysLeft)})`),
    );
    const subject = hasExpired
      ? `CLAMS: ${count(docs.length)} expired`
      : `CLAMS: ${count(docs.length)} expiring soon`;
    const sent = await this.mail.send(
      recipients,
      subject,
      `${hasExpired ? 'These company documents are no longer valid' : 'These company documents are about to expire'}:\n\n` +
        lines.join('\n') +
        `\n\nUpload the renewed copy on the Company page in the CLAMS admin panel.`,
    );

    // A reminder that never left the building has not been sent, whatever the
    // row says. Hand the claim back so the next sweep tries again — otherwise a
    // broken SMTP password silently costs the renewal notice for good, and the
    // first anyone knows is a licence that has already lapsed.
    //
    // Only when the mailer is configured and refused: with no mailer at all the
    // in-app notification is the whole channel, and re-arming would post it
    // afresh every six hours for ever.
    if (!sent && this.mail.enabled) {
      await this.unclaim(docs, hasExpired);
      this.logger.warn(
        `Email refused for ${docs.length} document(s) in org ${organizationId} — ` +
          're-armed for the next sweep',
      );
      return;
    }

    this.logger.log(
      `${hasExpired ? 'Expiry' : 'Reminder'} sent for ${docs.length} document(s) ` +
        `in org ${organizationId} to ${recipients.length} recipient(s)`,
    );
  }

  /** Give back the claim taken in {@link claim}, so the mail is tried again. */
  private async unclaim(docs: DueDocument[], hasExpired: boolean) {
    const column = hasExpired ? 'expirySentFor' : 'reminderSentFor';
    for (const doc of docs) {
      try {
        await this.prisma.companyDocument.updateMany({
          // Only if it still holds the value we wrote: a renewal in the
          // meantime has already re-armed it, and must not be undone.
          where: { id: doc.id, [column]: doc.validUntil } as Prisma.CompanyDocumentWhereInput,
          data: { [column]: null },
        });
      } catch (e) {
        this.logger.error(`Could not re-arm ${doc.name}: ${(e as Error).message}`);
      }
    }
  }
}

/** 0 → "today", 1 → "tomorrow", 7 → "in 7 days". */
function inDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function count(n: number): string {
  return `${n} company document${n === 1 ? '' : 's'}`;
}
