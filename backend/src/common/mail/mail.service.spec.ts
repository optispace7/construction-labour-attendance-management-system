import { EMAIL_FAILING, MailService } from './mail.service';

/**
 * A mailer that has stopped working is invisible by nature — the symptom is
 * post that never arrives. Gmail refused our app password for hours and the
 * only trace was a line in the container log, so the failure now has to reach
 * the admin panel and the caller has to be told the mail did not go.
 */

type Sent = { transporter: { sendMail: jest.Mock; verify: jest.Mock } };

function build(sendMail: jest.Mock, verify = jest.fn().mockResolvedValue(true)) {
  const notifications: jest.Mock = jest.fn().mockResolvedValue({});
  const cleared: jest.Mock = jest.fn().mockResolvedValue({ count: 1 });
  const prisma: any = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: 'org1' }, { id: 'org2' }]) },
    notification: { create: notifications, updateMany: cleared },
  };
  const svc = new MailService(prisma);
  // Swap the real transporter for the double; the constructor built one only
  // if the env happened to carry credentials.
  Object.defineProperty(svc, 'transporter', { value: { sendMail, verify }, writable: true });
  Object.defineProperty(svc, 'logger', {
    value: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  // Nobody should sit through the real backoff to watch a retry.
  Object.defineProperty(svc, 'retryDelayMs', { value: 0, writable: true });
  return { svc, notifications, cleared, prisma };
}

/** A refusal carries the SMTP reply code the way nodemailer reports it. */
function smtpError(message: string, responseCode?: number) {
  return Object.assign(new Error(message), responseCode ? { responseCode } : {});
}

describe('MailService', () => {
  it('reports success and raises nothing', async () => {
    const { svc, notifications } = build(jest.fn().mockResolvedValue({}));
    await expect(svc.send(['a@b.com'], 'subject', 'body')).resolves.toBe(true);
    expect(notifications).not.toHaveBeenCalled();
    expect(svc.failure).toBeNull();
  });

  it('tells the caller the mail did not go', async () => {
    const { svc } = build(jest.fn().mockRejectedValue(new Error('Invalid login: 535-5.7.8')));
    // The old signature returned false only for "no recipients", so a caller
    // could not tell a refusal from a no-op and marked the mail as sent.
    await expect(svc.send(['a@b.com'], 'subject', 'body')).resolves.toBe(false);
    expect(svc.failure).toMatch(/535/);
  });

  it('raises the alarm on every organization', async () => {
    const { svc, notifications } = build(
      jest.fn().mockRejectedValue(new Error('Invalid login: 535-5.7.8 BadCredentials')),
    );

    await svc.send(['a@b.com'], 'subject', 'body');

    expect(notifications).toHaveBeenCalledTimes(2);
    const first = notifications.mock.calls[0][0].data;
    expect(first.type).toBe(EMAIL_FAILING);
    expect(first.organizationId).toBe('org1');
    // The admin is told what to do about it, not just that it broke.
    expect(first.body).toMatch(/app password/i);
    expect(first.data.credentialProblem).toBe(true);
  });

  it('does not repeat the alarm for every refused message', async () => {
    const { svc, notifications } = build(jest.fn().mockRejectedValue(new Error('boom')));

    await svc.send(['a@b.com'], 's', 'b');
    await svc.send(['a@b.com'], 's', 'b');
    await svc.send(['a@b.com'], 's', 'b');

    // Once per organization, not once per attempt — a revoked credential fails
    // on all of them and a wall of identical banners teaches people to scroll.
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  it('clears the failure once mail gets through again', async () => {
    const sendMail = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({});
    const { svc } = build(sendMail);

    await svc.send(['a@b.com'], 's', 'b');
    expect(svc.failure).not.toBeNull();

    await svc.send(['a@b.com'], 's', 'b');
    expect(svc.failure).toBeNull();
  });

  it('takes the banner down when delivery recovers', async () => {
    const sendMail = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({});
    const { svc, cleared } = build(sendMail);

    await svc.send(['a@b.com'], 's', 'b');
    expect(cleared).not.toHaveBeenCalled();

    await svc.send(['a@b.com'], 's', 'b');
    // The alarm is a stored notification: clearing the field in memory left a
    // red banner up until somebody clicked Dismiss.
    expect(cleared).toHaveBeenCalledWith({
      where: { type: EMAIL_FAILING, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it('does not sweep the notifications table after every ordinary send', async () => {
    const { svc, cleared } = build(jest.fn().mockResolvedValue({}));

    await svc.send(['a@b.com'], 's', 'b');
    await svc.send(['a@b.com'], 's', 'b');

    expect(cleared).not.toHaveBeenCalled();
  });

  it('clears an alarm raised before this container started', async () => {
    const { svc, cleared } = build(jest.fn());

    // Nothing failed in *this* process, so there is no in-memory failure to
    // notice — the standing banner is from the revoked password we just fixed.
    await svc.onModuleInit();

    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('retries once when the server only deferred the message', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValueOnce(
        smtpError('Data command failed: 421-4.3.0 Temporary System Problem.', 421),
      )
      .mockResolvedValue({});
    const { svc, notifications } = build(sendMail);

    await expect(svc.send(['a@b.com'], 's', 'b')).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
    // A blip Gmail told us to sleep off is not an outage anyone needs to see.
    expect(notifications).not.toHaveBeenCalled();
  });

  it('reads the deferral off the message when there is no response code', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValueOnce(new Error('Data command failed: 421-4.3.0 Temporary System Problem.'))
      .mockResolvedValue({});
    const { svc } = build(sendMail);

    await expect(svc.send(['a@b.com'], 's', 'b')).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('does not retry a refusal', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValue(
        smtpError('Invalid login: 535-5.7.8 Username and Password not accepted', 535),
      );
    const { svc, notifications } = build(sendMail);

    await expect(svc.send(['a@b.com'], 's', 'b')).resolves.toBe(false);
    // 5.x.x means never; a revoked password would just fail twice as slowly.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveBeenCalled();
  });

  it('raises the alarm when the retry fails too', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValue(
        smtpError('Data command failed: 421-4.3.0 Temporary System Problem.', 421),
      );
    const { svc, notifications } = build(sendMail);

    await expect(svc.send(['a@b.com'], 's', 'b')).resolves.toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  it('finds a revoked password at startup, not at the first send', async () => {
    const { svc, notifications } = build(
      jest.fn(),
      jest.fn().mockRejectedValue(new Error('Invalid login: 535-5.7.8')),
    );

    await svc.onModuleInit();

    // Nobody had to be waiting on an email for this to be noticed.
    expect(notifications).toHaveBeenCalledTimes(2);
    expect(notifications.mock.calls[0][0].data.type).toBe(EMAIL_FAILING);
  });

  it('never throws out of the alarm itself', async () => {
    const { svc, prisma } = build(jest.fn().mockRejectedValue(new Error('boom')));
    prisma.organization.findMany.mockRejectedValue(new Error('db down'));
    // The caller is already handling a failure; the alarm must not add another.
    await expect(svc.send(['a@b.com'], 's', 'b')).resolves.toBe(false);
  });
});

// Keeps the unused-type checker quiet about the helper's shape.
export type _Sent = Sent;
