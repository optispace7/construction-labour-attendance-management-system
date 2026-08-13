import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
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
 * Gmail SMTP mailer. Configure with:
 *   GMAIL_USER          — the Gmail address to send from
 *   GMAIL_APP_PASSWORD  — an app password (Google Account → Security → App passwords)
 * When unconfigured, sends become no-ops (logged once at startup).
 *
 * Failures are raised in the admin panel, not just the container log. An app
 * password is revoked by events nobody schedules — changing the account
 * password revokes every one of them — so the first sign is usually that a mail
 * somebody was relying on never arrived. That went unnoticed for hours once;
 * the panel now says so on the day it happens.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private lastAlarmAt = 0;
  /** The reason sending last failed, or null while the mailer is healthy. */
  private lastError: string | null = null;

  constructor(private readonly prisma: PrismaService) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (user && pass) {
      this.transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    } else {
      this.transporter = null;
      this.logger.warn('GMAIL_USER / GMAIL_APP_PASSWORD not set — email notifications disabled');
    }
  }

  /**
   * Authenticate at startup rather than waiting for something to need sending.
   * A revoked password is otherwise discovered by whoever did not get the mail.
   */
  async onModuleInit() {
    if (!this.transporter) return;
    try {
      await this.transporter.verify();
      this.logger.log('SMTP credentials accepted');
    } catch (e) {
      await this.raiseAlarm((e as Error).message);
    }
  }

  get enabled(): boolean {
    return this.transporter !== null;
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
    if (!this.transporter || to.length === 0) return false;
    try {
      await this.transporter.sendMail({
        from: process.env.GMAIL_USER,
        bcc: to.join(','),
        subject,
        text,
      });
      if (this.lastError) {
        this.lastError = null;
        this.lastAlarmAt = 0;
        this.logger.log('Email delivery recovered');
      }
      return true;
    } catch (e) {
      this.logger.error(`sendMail failed: ${(e as Error).message}`);
      await this.raiseAlarm((e as Error).message);
      return false;
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
