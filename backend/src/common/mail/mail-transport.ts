import * as nodemailer from 'nodemailer';

/**
 * How mail actually leaves the process.
 *
 * `MailService` owns the policy — one retry on a deferral, the admin-panel
 * alarm, whether a caller should treat a message as lost — and this owns only
 * the transport.
 *
 * There is deliberately only one implementation. SMTP was expected to need a
 * second one for the serverless runtime, on the assumption it could not open a
 * raw socket; it can. Only port 25 is blocked there, and Gmail submission is on
 * 465, so the same Gmail credentials work on both. That was checked against the
 * real thing rather than assumed: Gmail answered
 * `535-5.7.8 Username and Password not accepted` to a deliberately wrong
 * password, which is a reply that can only come back over a connection that
 * worked.
 *
 * The seam is still worth having — it is what let that be tested, and what
 * keeps the hard-won parts (the deferral retry, the self-clearing banner) out
 * of the transport.
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
  private transporter?: nodemailer.Transporter | null;

  /**
   * Built on first use, not in the constructor.
   *
   * `createTransport` generates random bytes for its connection ids, and a
   * serverless runtime forbids that while a module is still being evaluated —
   * there is no request to attribute it to, so the whole Worker fails to start.
   * Deferring it also means the credentials are read when they are needed
   * rather than whenever this module happened to be imported.
   */
  private get mailer(): nodemailer.Transporter | null {
    if (this.transporter === undefined) {
      const user = process.env.GMAIL_USER;
      const pass = process.env.GMAIL_APP_PASSWORD;
      this.transporter =
        user && pass
          ? nodemailer.createTransport({ service: 'gmail', auth: { user, pass } })
          : null;
    }
    return this.transporter;
  }

  get configured(): boolean {
    // Answered from the environment rather than by building the transport:
    // `enabled` is read during bootstrap, which is still global scope.
    return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  }

  async verify(): Promise<void> {
    await this.mailer?.verify();
  }

  async send(message: MailMessage): Promise<void> {
    const mailer = this.mailer;
    if (!mailer) return;
    await mailer.sendMail({ from: process.env.GMAIL_USER, ...message });
  }

  isDeferral(error: unknown): boolean {
    return smtpDeferred(error);
  }
}

export const mailTransport: MailTransport = new SmtpTransport();

/** Named for the log line that says which transport a deployment is using. */
export const mailTransportName = 'SMTP (Gmail)';
