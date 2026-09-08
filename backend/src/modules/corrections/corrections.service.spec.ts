import { CorrectionsService } from './corrections.service';
import { actor, makeWorld, onlySession, SITE, World } from '../../../test/correction-fixtures';

/**
 * The approval gate, against a real SQLite through D1's own API.
 *
 * These assertions used to be made against a Prisma mock, which could only ever
 * say that the service called the methods the mock expected. The apply is now
 * raw SQL whose whole safety mechanism is a guarded UPDATE's reported change
 * count, so the test seeds real rows, runs the real statements, and reads back
 * what the database actually holds.
 */
describe('CorrectionsService.approve (approval gate)', () => {
  let w: World;
  let svc: CorrectionsService;
  let audit: { record: jest.Mock };

  const build = async (opts: Parameters<typeof makeWorld>[0] = {}) => {
    w = await makeWorld(opts);
    audit = { record: jest.fn() };
    // Both halves of D1Service, over the one database: the services read
    // through Drizzle and the correction apply writes through D1 directly.
    svc = new CorrectionsService({ db: w.drizzle, d1: w.db } as never, audit as never);
  };

  afterEach(async () => {
    await w?.dispose();
  });

  const at = (iso: string) => new Date(iso).getTime();

  it('aborts with CONFLICT when the session changed after the request was filed', async () => {
    await build();
    // The session was touched at 12:00; the request was filed at 10:00, so what
    // the requester saw is no longer what is on the books.
    await w.session({ id: 's1', updatedAt: '2026-06-08T12:00:00Z' });
    await w.request({ id: 'c1', sessionId: 's1', createdAt: '2026-06-08T10:00:00Z' }, [
      { field: 'logout_at', proposedValue: '2026-06-08T11:00:00Z' },
    ]);

    await expect(svc.approve(actor as never, 'c1', {})).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Nothing moved, and the request is still waiting for someone.
    expect((await w.readSession('s1'))?.logout_at).toBeNull();
    expect((await w.readRequest('c1'))?.status).toBe('PENDING');
  });

  it('resolves the session by worker + work date when the request has no sessionId', async () => {
    await build();
    // A mobile-filed request pins nothing; the day is derived from the proposed
    // instant, which is unambiguous.
    await w.session({
      id: 's1',
      workDate: '2026-06-08',
      loginAt: '2026-06-08T03:30:00Z', // 09:00 IST
      updatedAt: '2026-06-08T12:00:00Z',
    });
    await w.request({ id: 'c1', sessionId: null }, [
      { field: 'logout_at', proposedValue: '2026-06-08T12:30:00Z' },
    ]);

    await svc.approve(actor as never, 'c1', {});

    const s = await w.readSession('s1');
    expect(s?.logout_at).toBe(at('2026-06-08T12:30:00Z'));
    expect(s?.state).toBe('CLOSED');
    expect(s?.closed_reason).toBe('CORRECTION');
    // A session found by date is exempt from the freshness check — it was
    // looked up fresh, so the current row is the intended target.
    expect((await w.readRequest('c1'))?.status).toBe('APPROVED');
  });

  it('refiles the session under the corrected login date', async () => {
    await build();
    await w.session({ id: 's1', workDate: '2026-06-08', loginAt: '2026-06-08T03:30:00Z' });
    await w.request({ id: 'c1', sessionId: 's1' }, [
      // Moved to the 9th, 09:00 IST.
      { field: 'login_at', proposedValue: '2026-06-09T03:30:00Z' },
      { field: 'logout_at', proposedValue: '2026-06-09T12:30:00Z' },
    ]);

    await svc.approve(actor as never, 'c1', {});

    expect((await w.readSession('s1'))?.work_date).toBe('2026-06-09');
  });

  it('targets the day the supervisor picked, not the off-by-one workDate', async () => {
    await build();
    // The mobile builds work_date from local midnight and converts to UTC, so
    // at +05:30 it lands on the previous day. The proposed instant wins.
    await w.session({ id: 's1', workDate: '2026-06-09', loginAt: '2026-06-09T03:30:00Z' });
    await w.request({ id: 'c1', sessionId: null, workDate: '2026-06-08' }, [
      { field: 'logout_at', proposedValue: '2026-06-09T12:30:00Z' },
    ]);

    await svc.approve(actor as never, 'c1', {});

    expect((await w.readSession('s1'))?.logout_at).toBe(at('2026-06-09T12:30:00Z'));
  });

  it('refuses a login-only correction when the worker already has an open session', async () => {
    await build();
    // Still clocked in from today; the correction is for a day gone by.
    await w.session({
      id: 'open-now',
      workDate: '2026-06-20',
      loginAt: '2026-06-20T03:30:00Z',
      state: 'OPEN',
    });
    await w.request({ id: 'c1', sessionId: null, workDate: '2026-06-08' }, [
      { field: 'login_at', proposedValue: '2026-06-08T03:30:00Z' },
    ]);

    await expect(svc.approve(actor as never, 'c1', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: expect.stringContaining('only have one session open at a time'),
    });
    expect((await w.readRequest('c1'))?.status).toBe('PENDING');
  });

  it('creates the session CLOSED when the correction supplies a logout', async () => {
    await build();
    // Nothing on the books for that day: the correction materialises the row.
    await w.request({ id: 'c1', sessionId: null, workDate: '2026-06-08' }, [
      { field: 'login_at', proposedValue: '2026-06-08T03:30:00Z' }, // 09:00 IST
      { field: 'logout_at', proposedValue: '2026-06-08T12:30:00Z' }, // 18:00 IST
    ]);

    await svc.approve(actor as never, 'c1', {});

    const s = await onlySession(w);
    expect(s).toMatchObject({
      state: 'CLOSED',
      work_date: '2026-06-08',
      closed_reason: 'CORRECTION',
      site_id: SITE,
    });
    expect(s?.worked_minutes).toBe(540);
  });

  it('refuses a logout that lands before the login it belongs to', async () => {
    await build();
    await w.session({ id: 's1', loginAt: '2026-06-08T06:00:00Z' });
    await w.request({ id: 'c1', sessionId: 's1' }, [
      { field: 'logout_at', proposedValue: '2026-06-08T05:00:00Z' },
    ]);

    await expect(svc.approve(actor as never, 'c1', {})).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
      detail: expect.stringContaining('not after the login time'),
    });
    expect((await w.readSession('s1'))?.logout_at).toBeNull();
  });

  it('closes the night shift running into the day a logout correction names', async () => {
    await build();
    // In at 20:00 IST on the 8th, out at 06:00 IST on the 9th. The logout falls
    // on a day with no session of its own; the row it means is still running.
    await w.session({
      id: 'night',
      workDate: '2026-06-08',
      loginAt: '2026-06-08T14:30:00Z',
      state: 'OPEN',
    });
    await w.request({ id: 'c1', sessionId: null, workDate: '2026-06-09' }, [
      { field: 'logout_at', proposedValue: '2026-06-09T00:30:00Z' },
    ]);

    await svc.approve(actor as never, 'c1', {});

    const s = await w.readSession('night');
    expect(s?.state).toBe('CLOSED');
    expect(s?.logout_at).toBe(at('2026-06-09T00:30:00Z'));
    // It stays filed under the day the shift began.
    expect(s?.work_date).toBe('2026-06-08');
  });

  it('applies a logout to the shift it can close, not a later stray tap', async () => {
    await build();
    // An 18:19 logout once landed on a stray tap made at 19:14, leaving both
    // men it hit reading zero hours. The session it means is the latest that
    // had already started by then.
    await w.session({
      id: 'real',
      workDate: '2026-06-08',
      loginAt: '2026-06-08T03:30:00Z', // 09:00 IST
      state: 'OPEN',
    });
    await w.session({
      id: 'stray',
      workDate: '2026-06-08',
      loginAt: '2026-06-08T13:44:00Z', // 19:14 IST — after the proposed logout
      state: 'OPEN',
    });
    await w.request({ id: 'c1', sessionId: null, workDate: '2026-06-08' }, [
      { field: 'logout_at', proposedValue: '2026-06-08T12:49:00Z' }, // 18:19 IST
    ]);

    await svc.approve(actor as never, 'c1', {});

    expect((await w.readSession('real'))?.state).toBe('CLOSED');
    expect((await w.readSession('stray'))?.state).toBe('OPEN');
  });

  it('does not mutate attendance when rejecting', async () => {
    await build();
    await w.session({ id: 's1' });
    await w.request({ id: 'c1', sessionId: 's1' }, [
      { field: 'logout_at', proposedValue: '2026-06-08T12:30:00Z' },
    ]);

    await svc.reject(actor as never, 'c1', { reviewNotes: 'Not what happened' });

    expect((await w.readSession('s1'))?.logout_at).toBeNull();
    const req = await w.readRequest('c1');
    expect(req?.status).toBe('REJECTED');
    expect(req?.review_notes).toBe('Not what happened');
  });
});
