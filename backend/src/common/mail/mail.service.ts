import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mailTransport, mailTransportName, MailMessage } from './mail-transport';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Notification type the admin panel watches for a broken mailer. */
export const EMAIL_FAILING = 'EMAIL_FAILING';

/**
 * Don't re-raise the alarm more often than this. A credential that Google has
 * revoked fails on every attempt, and one banner a day is the message; a
 * notification per attempt is just noise the admin learns to scroll past.
 */
const RENOTIFY_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait before the one retry. Long enough for Gmail to let go of a
 * throttle, short enough that the forgot-password OTP — the only mail anybody
 * waits on with the page open — still arrives while they are looking at it.
 */
const RETRY_DELAY_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


/**
 * Gmail SMTP mailer. Configure with:
 *   GMAIL_USER          — the Gmail address to send from
 *   GMAIL_APP_PASSWORD  — an app password (Google Account → Security → App passwords)
 * When unconfigured, sends become no-ops (logged once at startup).
 *
 * Failures are raised in the admin panel, not just the container log. An app
 * password is revoked by events nobody schedules — changing the account
 * password revokes every one of them — so the first sign is usually that a mail
 * somebody was relying on never arrived. That went unnoticed for hours once;
 * the panel now says so on the day it happens — and stops saying so once mail
 * is going out again, so the banner means "broken now", not "broke once".
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly transport = mailTransport;
  private lastAlarmAt = 0;
  /** The reason sending last failed, or null while the mailer is healthy. */
  private lastError: string | null = null;
  /** Held on the instance so a test can retry without waiting five seconds. */
  private readonly retryDelayMs = RETRY_DELAY_MS;

  constructor(private readonly prisma: PrismaService) {
    if (!this.transport.configured) {
      this.logger.warn(`Email is not configured (${mailTransportName}) — notifications disabled`);
    }
  }

  /**
   * Authenticate at startup rather than waiting for something to need sending.
   * A revoked password is otherwise discovered by whoever did not get the mail.
   */
  async onModuleInit() {
    if (!this.transport.configured) return;
    try {
      await this.transport.verify();
      this.logger.log(`${mailTransportName} accepted`);
      // A working credential settles any alarm still standing from before this
      // container started — that is how the revoked-password banner outlived
      // the revoked password by days.
      await this.clearAlarm(true);
    } catch (e) {
      await this.raiseAlarm((e as Error).message);
    }
  }

  get enabled(): boolean {
    return this.transport.configured;
  }

  /** Whether the last attempt failed, and why — null when healthy. */
  get failure(): string | null {
    return this.lastError;
  }

  /**
   * Fire-and-forget; failures are logged and raised in the admin panel, never
   * thrown. Returns whether the mail actually went out, so a caller that must
   * not lose the message can retry it later rather than assume it was sent.
   */
  async send(to: string[], subject: string, text: string): Promise<boolean> {
    if (!this.transport.configured || to.length === 0) return false;
    try {
      await this.deliver({ bcc: to.join(','), subject, text });
      await this.clearAlarm();
      return true;
    } catch (e) {
      this.logger.error(`sendMail failed: ${(e as Error).message}`);
      await this.raiseAlarm((e as Error).message);
      return false;
    }
  }

  /**
   * One attempt, and a second one if the server only deferred us. Twice is the
   * whole policy: a deferral that outlasts a five-second pause is an outage
   * worth a banner, not something to keep quietly grinding at.
   */
  private async deliver(message: MailMessage): Promise<void> {
    try {
      await this.transport.send(message);
    } catch (e) {
      if (!this.transport.isDeferral(e)) throw e;
      const reason = (e as Error).message.split('\n')[0].trim();
      this.logger.warn(`Deferred by the mail server, retrying once: ${reason}`);
      await sleep(this.retryDelayMs);
      await this.transport.send(message);
    }
  }

  /**
   * Take the banner down.
   *
   * The alarm is a stored notification, so a mailer that starts working again
   * leaves a red banner standing until somebody clicks Dismiss. A twenty-eight
   * minute deferral read as a live outage the following morning. Pass `force`
   * when the mailer is known good but this process never saw it fail.
   */
  private async clearAlarm(force = false) {
    const wasFailing = this.lastError !== null;
    this.lastError = null;
    this.lastAlarmAt = 0;
    if (!wasFailing && !force) return;
    if (wasFailing) this.logger.log('Email delivery recovered');

    try {
      const { count } = await this.prisma.notification.updateMany({
        where: { type: EMAIL_FAILING, readAt: null },
        // No readBy: nobody read it, the mailer simply came back.
        data: { readAt: new Date() },
      });
      if (count > 0) this.logger.log(`Cleared ${count} standing email-delivery alarm(s)`);
    } catch (e) {
      // Same rule as raising it — the alarm must never break the caller.
      this.logger.error(`Could not clear the email-delivery alarm: ${(e as Error).message}`);
    }
  }

  /**
   * Put the failure in front of an admin.
   *
   * Written for every organization, the way the storage monitor does it: a
   * broken SMTP credential is not one company's problem, it is the mailer's,
   * and each org's admins only see their own feed.
   */
  private async raiseAlarm(message: string) {
    this.lastError = message;
    const now = Date.now();
    if (now - this.lastAlarmAt < RENOTIFY_AFTER_MS) return;
    this.lastAlarmAt = now;

    // The first line is the useful one — Gmail's refusals run to several lines
    // of URLs and message ids that mean nothing on a dashboard.
    const reason = message.split('\n')[0].trim();
    const credentialProblem = /invalid login|badcredentials|5\.7\.\d|username and password/i.test(
      message,
    );

    try {
      const orgs = await this.prisma.organization.findMany({ select: { id: true } });
      for (const org of orgs) {
        await this.prisma.notification.create({
          data: {
            organizationId: org.id,
            type: EMAIL_FAILING,
            title: 'Emails are not being sent',
            body:
              `${reason}\n\n` +
              (credentialProblem
                ? 'The Gmail app password has stopped working — it is revoked whenever ' +
                  'that account’s password is changed or 2-step verification is turned ' +
                  'off. Issue a new one and update GMAIL_APP_PASSWORD.'
                : 'Email delivery is failing. Reminders and alerts are not reaching anyone ' +
                  'until it is fixed.'),
            data: { reason, credentialProblem },
          },
        });
      }
      this.logger.warn(`Raised an email-delivery alarm on ${orgs.length} organization(s)`);
    } catch (e) {
      // Never let the alarm itself break the caller — it is already handling a
      // failure, and a mail that cannot be sent must not also fail the request.
      this.logger.error(`Could not raise the email-delivery alarm: ${(e as Error).message}`);
    }
  }
}
