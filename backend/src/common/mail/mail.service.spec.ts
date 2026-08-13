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
  const prisma: any = {
    organization: { findMany: jest.fn().mockResolvedValue([{ id: 'org1' }, { id: 'org2' }]) },
    notification: { create: notifications },
  };
  const svc = new MailService(prisma);
  // Swap the real transporter for the double; the constructor built one only
  // if the env happened to carry credentials.
  Object.defineProperty(svc, 'transporter', { value: { sendMail, verify }, writable: true });
  Object.defineProperty(svc, 'logger', {
    value: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { svc, notifications, prisma };
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
