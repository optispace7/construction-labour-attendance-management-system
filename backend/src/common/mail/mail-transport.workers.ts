import { env } from 'cloudflare:workers';

/**
 * Mail transport on the Workers runtime, over Cloudflare Email Service.
 *
 * The Node build sends over SMTP (see `mail-transport.ts`), which needs a raw
 * TCP socket this runtime does not have; the wrangler `alias` swaps this in.
 * The binding needs no API key, and the sending domain is onboarded once with
 * `wrangler email sending enable <domain>`.
 *
 * `MailService` keeps the policy — the deferral retry, the admin-panel alarm —
 * so the only thing that differs between runtimes is how the bytes leave.
 */

export interface MailMessage {
  bcc: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  readonly configured: boolean;
  verify(): Promise<void>;
  send(message: MailMessage): Promise<void>;
  isDeferral(error: unknown): boolean;
}

interface EmailBinding {
  send(message: {
    to: string | string[];
    from: { email: string; name?: string };
    subject: string;
    text: string;
  }): Promise<unknown>;
}

/** Who the mail comes from. Must be on a domain onboarded to Email Sending. */
const FROM_ADDRESS = process.env.MAIL_FROM_ADDRESS ?? '';
const FROM_NAME = process.env.MAIL_FROM_NAME ?? 'CLAMS';

function binding(): EmailBinding | undefined {
  return (env as unknown as { EMAIL?: EmailBinding }).EMAIL;
}

class EmailServiceTransport implements MailTransport {
  get configured(): boolean {
    // Both halves are required: a binding with no from-address cannot send, and
    // an address with no binding has nothing to send through.
    return Boolean(binding()) && FROM_ADDRESS.length > 0;
  }

  async verify(): Promise<void> {
    // There is nothing to authenticate — the binding carries the account's own
    // credentials. Whether the domain is onboarded shows up on the first send,
    // and MailService already surfaces that as the admin-panel alarm.
    if (!this.configured) {
      throw new Error(
        'Email is not configured: needs the EMAIL binding and MAIL_FROM_ADDRESS on an ' +
          'onboarded domain (wrangler email sending enable <domain>).',
      );
    }
  }

  async send(message: MailMessage): Promise<void> {
    const email = binding();
    if (!email || !FROM_ADDRESS) return;
    // Recipients are passed as a list rather than a bcc header: the binding
    // addresses each one itself, and the header would be the wrong shape here.
    // Every caller already treats the list as undisclosed recipients.
    await email.send({
      to: message.bcc.split(',').map((a) => a.trim()).filter(Boolean),
      from: { email: FROM_ADDRESS, name: FROM_NAME },
      subject: message.subject,
      text: message.text,
    });
  }

  isDeferral(error: unknown): boolean {
    // No SMTP reply codes here. A 429 or a 5xx from the service is worth the
    // one retry MailService allows; anything else is a refusal.
    const text = String((error as Error)?.message ?? error);
    return /\b(429|50\d|timeout|temporar)/i.test(text);
  }
}

export const mailTransport: MailTransport = new EmailServiceTransport();

export const mailTransportName = 'Cloudflare Email Service';
