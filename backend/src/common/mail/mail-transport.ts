import * as nodemailer from 'nodemailer';

/**
 * How mail actually leaves the process.
 *
 * `MailService` owns the policy — one retry on a deferral, the admin-panel
 * alarm, whether a caller should treat a message as lost — and this owns only
 * the transport. There is a second implementation of this interface in
 * `mail-transport.workers.ts`; the Workers bundle is aliased onto it, because
 * SMTP needs a raw TCP socket and that runtime has none.
 *
 * Splitting it this way keeps the parts that were learned the hard way — the
 * deferral retry, the banner that clears itself — in one place rather than
 * duplicated per runtime.
 */

export interface MailMessage {
  bcc: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  /** False when credentials are absent; sending is then a no-op, not an error. */
  readonly configured: boolean;
  /** Prove the credentials at startup, so a revoked one is not found by a user. */
  verify(): Promise<void>;
  send(message: MailMessage): Promise<void>;
  /** Whether the server said "later" rather than "no" — worth one retry. */
  isDeferral(error: unknown): boolean;
}

/**
 * Whether the server said "later" rather than "no".
 *
 * A 4.x.x reply is a deferral and a 5.x.x is a refusal; retrying a revoked app
 * password just fails twice as slowly. Gmail deferred one message on a cold
 * start with 421-4.3.0 and the missed-logout alert it carried was simply
 * dropped, because a send that fails is never tried again.
 */
function smtpDeferred(e: unknown): boolean {
  const code = (e as { responseCode?: number }).responseCode;
  if (typeof code === 'number') return code >= 400 && code < 500;
  return /\b4\d\d[- ]?4\.\d+\.\d+/.test((e as Error)?.message ?? '');
}

class SmtpTransport implements MailTransport {
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from?: string;

  constructor() {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    this.from = user;
    this.transporter =
      user && pass ? nodemailer.createTransport({ service: 'gmail', auth: { user, pass } }) : null;
  }

  get configured(): boolean {
    return this.transporter !== null;
  }

  async verify(): Promise<void> {
    if (!this.transporter) return;
    await this.transporter.verify();
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) return;
    await this.transporter.sendMail({ from: this.from, ...message });
  }

  isDeferral(error: unknown): boolean {
    return smtpDeferred(error);
  }
}

export const mailTransport: MailTransport = new SmtpTransport();

/** Named for the log line that says which transport a deployment is using. */
export const mailTransportName = 'SMTP (Gmail)';
