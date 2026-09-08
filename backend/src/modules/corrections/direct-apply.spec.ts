import { CorrectionsService } from './corrections.service';
import { makeWorld, onlySession, SITE, USER, WORKER, World } from '../../../test/correction-fixtures';

/**
 * Corrections filed by someone the Super Admin has cleared to apply their own.
 *
 * The behaviour that matters: the request still exists, still carries its
 * reason and its author, and still goes through the one apply path — it just
 * does not wait for a second person. And an officer without the grant must be
 * exactly as blocked as before.
 *
 * Run against a real SQLite through D1's API, so "the request was rolled back"
 * is read off the database rather than off a mock's call log.
 */
const officer: any = {
  userId: USER,
  organizationId: 'org1',
  role: 'SUPERVISOR',
  siteScopes: [],
};

const dto: any = {
  workerId: WORKER,
  siteId: SITE,
  workDate: '2026-06-08',
  type: 'LOGOUT',
  reason: 'FORGOT_CARD',
  notes: 'Gate tablet was flat; he left at 18:30.',
  items: [{ field: 'logout_at', proposedValue: '2026-06-08T13:00:00Z' }],
};

describe('CorrectionsService.create (direct apply)', () => {
  let w: World;
  let svc: CorrectionsService;
  let audit: { record: jest.Mock };

  /** A world where the officer may or may not skip the queue. */
  const build = async (canApplyCorrections: boolean) => {
    w = await makeWorld({ canApplyCorrections });
    audit = { record: jest.fn() };
    svc = new CorrectionsService({ db: w.drizzle, d1: w.db } as never, audit as never);
  };

  /** The session a logout correction can land on: in at 09:00 IST, still open. */
  const openDay = () =>
    w.session({
      id: 's1',
      workDate: '2026-06-08',
      loginAt: '2026-06-08T03:30:00Z',
      state: 'OPEN',
      updatedAt: '2026-06-08T06:00:00Z',
    });

  const requests = async () =>
    (await w.db.prepare('SELECT * FROM correction_requests').all()).results as Record<
      string,
      unknown
    >[];

  afterEach(async () => {
    await w?.dispose();
  });

  it('applies the correction on the spot when the author is cleared for it', async () => {
    await build(true);
    await openDay();

    const res: any = await svc.create(officer, dto);

    expect(res.autoApplied).toBe(true);
    expect(res.status).toBe('APPROVED');
    // The attendance actually moved.
    const s = await w.readSession('s1');
    expect(s?.state).toBe('CLOSED');
    expect(s?.logout_at).toBe(new Date('2026-06-08T13:00:00Z').getTime());
    // The request is still a record of who asked and why.
    expect(res.reason).toBe('FORGOT_CARD');
    expect(res.requestedBy).toBe(USER);
    expect(res.items).toHaveLength(1);
  });

  it('records the bypass under its own audit action', async () => {
    await build(true);
    await openDay();

    await svc.create(officer, dto);

    // A distinct action, so "who changed attendance without review" is a
    // question the audit log can answer on its own.
    const actions = audit.record.mock.calls.map((c) => c[0].action);
    expect(actions).toContain('CORRECTION_REQUEST');
    expect(actions).toContain('CORRECTION_AUTO_APPLY');
    expect(actions).not.toContain('CORRECTION_APPROVE');
  });

  it('still queues the correction when the author is not cleared', async () => {
    await build(false);
    await openDay();

    const res: any = await svc.create(officer, dto);

    expect(res.status).toBe('PENDING');
    expect(res.autoApplied).toBe(false);
    // Attendance is untouched until somebody reviews it.
    expect((await w.readSession('s1'))?.logout_at).toBeNull();
    expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual(['CORRECTION_REQUEST']);
  });

  it("reads the grant from the user row, not from the caller's token", async () => {
    await build(false);
    await openDay();

    // The token says otherwise; the row is what counts, so the Super Admin can
    // take the grant back now rather than when a session happens to expire.
    const res: any = await svc.create(
      { ...officer, canApplyCorrections: true } as never,
      dto,
    );

    expect(res.status).toBe('PENDING');
    expect((await w.readSession('s1'))?.logout_at).toBeNull();
  });

  it('applies both stamps of an overnight shift and files it under the day they came in', async () => {
    await build(true);
    // Never scanned, so there is nothing to patch — the pair has to make it.
    const overnight = {
      ...dto,
      type: 'MISSING',
      workDate: '2026-08-08',
      items: [
        // 21:30 IST on the 8th…
        { field: 'login_at', proposedValue: '2026-08-08T16:00:00.000Z' },
        // …out at 08:00 IST on the 9th.
        { field: 'logout_at', proposedValue: '2026-08-09T02:30:00.000Z' },
      ],
    };

    const res: any = await svc.create(officer, overnight);

    expect(res.autoApplied).toBe(true);
    // One session, carrying both stamps, closed because the logout is known.
    const s = await onlySession(w);
    expect(s?.login_at).toBe(new Date('2026-08-08T16:00:00.000Z').getTime());
    expect(s?.logout_at).toBe(new Date('2026-08-09T02:30:00.000Z').getTime());
    expect(s?.state).toBe('CLOSED');
    // The 8th — the shift belongs to the night it started, not to the morning
    // the logout happens to fall in.
    expect(s?.work_date).toBe('2026-08-08');
    // 21:30 → 08:00 is ten and a half hours across midnight.
    expect(s?.worked_minutes).toBe(630);
  });

  it('still refuses a backwards pair from someone cleared to apply their own', async () => {
    await build(true);
    // Both stamps on the same day, with the logout earlier than the login —
    // what an un-ticked "went out the next day" would produce. The grant skips
    // the review, never the sanity check.
    const backwards = {
      ...dto,
      type: 'MISSING',
      items: [
        { field: 'login_at', proposedValue: '2026-06-08T16:00:00.000Z' }, // 21:30 IST
        { field: 'logout_at', proposedValue: '2026-06-08T02:30:00.000Z' }, // 08:00 IST, same day
      ],
    };

    await expect(svc.create(officer, backwards)).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
    });
    // No attendance, and no request left waiting for a reviewer who was never
    // going to be asked.
    expect(await onlySession(w)).toBeNull();
    expect((await requests())[0]?.status).toBe('CANCELLED');
  });

  it('leaves no request behind when applying it fails', async () => {
    await build(true);
    // No session for that day, and a logout-only correction cannot invent one.

    await expect(svc.create(officer, dto)).rejects.toMatchObject({ code: 'CONFLICT' });

    // The request must not be parked in a queue nobody is watching: it was
    // never filed for review in the first place.
    const [req] = await requests();
    expect(req?.status).toBe('CANCELLED');
    expect(await onlySession(w)).toBeNull();
  });
});
