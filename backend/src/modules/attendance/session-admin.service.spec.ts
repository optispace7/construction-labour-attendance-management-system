import { SessionAdminService } from './session-admin.service';
import { drizzleDouble } from '../../../test/drizzle-double';
import {
  attendanceSessions,
  organizations,
  shifts,
  workers,
} from '../../infra/d1/schema.generated';

const user: any = { userId: 'u1', organizationId: 'org1', role: 'SUPER_ADMIN', siteScopes: [] };
const WORK_DATE = '2026-07-21';

/**
 * A session as the join returns it: one flat row, which the service nests.
 * The panel's shape is asserted through what comes back, not through this.
 */
function session(over: Partial<any> = {}) {
  const { worker, ...rest } = over as any;
  return {
    id: 's1',
    workerId: 'w34',
    siteId: 'site1',
    workDate: WORK_DATE,
    loginAt: new Date('2026-07-21T05:00:00Z'), // 10:30 IST
    logoutAt: null,
    state: 'OPEN',
    workedMinutes: null,
    overtimeMinutes: null,
    closedReason: null,
    loginTapId: null,
    logoutTapId: null,
    workerFullName: 'Shattappa Kusale',
    workerCode: 'W-0034',
    workerCategory: 'WORKER',
    designationName: null,
    vendorName: null,
    siteName: 'Brigade WTC',
    siteTimezone: 'Asia/Kolkata',
    ...(worker
      ? { workerFullName: worker.fullName, workerCode: worker.workerCode, workerId: worker.id ?? 'w34' }
      : {}),
    ...rest,
  };
}

/**
 * The service against a Drizzle double.
 *
 * `sessions` is given the read index, because the sessions table is read
 * several times in one call for different reasons — the session being edited,
 * its shift, a clashing record — and each test says which read is which.
 */
function harness(
  sessions: (n: number) => any[] = () => [],
  over: { worker?: any; shift?: any } = {},
) {
  const audit: any = { record: jest.fn() };
  const db = drizzleDouble([
    [organizations, [{ timezone: 'Asia/Kolkata' }]],
    [shifts, over.shift ? [over.shift] : []],
    [workers, over.worker ? [over.worker] : []],
    [attendanceSessions, sessions],
  ]);
  return { db, audit, svc: new SessionAdminService({ db: db.db } as any, audit) };
}

/** The values of the update against the sessions table, if there was one. */
const patch = (db: ReturnType<typeof harness>['db']) => db.wrote(attendanceSessions) as any;
const updates = (db: ReturnType<typeof harness>['db']) =>
  db.writes.filter((w) => w.kind === 'update' && w.table === attendanceSessions);

describe('SessionAdminService.edit — moving a session to the right worker', () => {
  it('reassigns the worker, keeps the times, and audits the before/after', async () => {
    const moved = session({
      workerId: 'w59',
      workerFullName: 'Yallappa',
      workerCode: 'W-0059',
    });
    // 0 loadSession, 1 the session's shiftId, 2 a clashing record, 3 the read
    // back after the update.
    const { db, audit, svc } = harness(
      (n) => (n === 0 ? [session()] : n === 1 ? [{ shiftId: null }] : n === 2 ? [] : [moved]),
      { worker: { id: 'w59', fullName: 'Yallappa', workerCode: 'W-0059' } },
    );

    await svc.edit(user, 's1', { workerId: 'w59', reason: 'W-0034 was not on site' });

    expect(patch(db).workerId).toBe('w59');
    expect(patch(db).loginAt).toEqual(new Date('2026-07-21T05:00:00Z'));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ATTENDANCE_SESSION_EDIT',
        reason: 'W-0034 was not on site',
        oldValue: expect.objectContaining({ workerCode: 'W-0034' }),
        newValue: expect.objectContaining({ workerCode: 'W-0059' }),
      }),
    );
  });

  it('refuses when the target worker already has a record that day', async () => {
    const { db, svc } = harness(
      (n) =>
        n === 0
          ? [session()]
          : n === 1
            ? [{ shiftId: null }]
            : [{ id: 's2', state: 'OPEN', loginAt: new Date() }],
      { worker: { id: 'w59', fullName: 'Yallappa', workerCode: 'W-0059' } },
    );

    await expect(svc.edit(user, 's1', { workerId: 'w59', reason: 'swap' })).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
      detail: expect.stringMatching(/already has an open session/),
    });
    expect(updates(db)).toHaveLength(0);
  });

  it('rejects a logout that lands before the login', async () => {
    const { svc } = harness((n) => (n === 0 ? [session()] : [{ shiftId: null }]));

    await expect(
      svc.edit(user, 's1', { logoutAt: '2026-07-21T04:00:00Z', reason: 'typo' }),
    ).rejects.toMatchObject({ detail: expect.stringMatching(/after the login time/) });
  });

  it('recomputes hours and closes the session when a logout time is set', async () => {
    const { db, svc } = harness((n) =>
      n === 0 ? [session()] : n === 1 ? [{ shiftId: null }] : [session()],
    );

    await svc.edit(user, 's1', { logoutAt: '2026-07-21T12:35:00Z', reason: 'left at 18:05' });

    expect(patch(db).state).toBe('CLOSED');
    expect(patch(db).workedMinutes).toBe(455); // 10:30 → 18:05 IST
    expect(patch(db).overtimeMinutes).toBe(0); // under the 8h default day
  });
});

describe('SessionAdminService.bulkLogout — the end-of-shift sweep', () => {
  const open = [
    { ...session({ id: 'a', workerFullName: 'Viresh', workerCode: 'W-0010' }), shiftId: null },
    {
      ...session({
        id: 'b',
        loginAt: new Date('2026-07-21T12:54:50Z'), // 18:24 IST — after the sweep time
        workerFullName: 'Verash',
        workerCode: 'W-0012',
      }),
      shiftId: null,
    },
  ];

  it('closes what it can and reports who was skipped, without writing on a dry run', async () => {
    const { db, audit, svc } = harness(() => open);

    const result = await svc.bulkLogout(user, {
      date: '2026-07-21',
      time: '18:05',
      reason: 'shift ended',
      dryRun: true,
    });

    expect(result.closed).toHaveLength(1);
    expect(result.closed[0].workerCode).toBe('W-0010');
    expect(result.closed[0].workedMinutes).toBe(455);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        workerCode: 'W-0012',
        reason: 'Logged in after this time — tick "next morning" for a night shift',
      }),
    ]);
    expect(updates(db)).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('stamps the morning after the work date when told the shift ran overnight', async () => {
    // A night man: in at 20:20 IST on the 21st, still open.
    const night = [
      {
        ...session({
          id: 'n',
          loginAt: new Date('2026-07-21T14:50:00Z'),
          workerFullName: 'Kailu',
          workerCode: 'W-0084',
        }),
        shiftId: null,
      },
    ];
    const { audit, svc } = harness(() => night);

    const sameDay = await svc.bulkLogout(user, {
      date: '2026-07-21',
      time: '08:00',
      reason: 'night shift ended',
      dryRun: true,
    });
    // 08:00 on the 21st is before he arrived, so the sweep cannot take him.
    expect(sameDay.closed).toHaveLength(0);
    expect(sameDay.skipped).toHaveLength(1);

    const nextDay = await svc.bulkLogout(user, {
      date: '2026-07-21',
      time: '08:00',
      nextDay: true,
      reason: 'night shift ended',
      dryRun: true,
    });
    expect(nextDay.skipped).toHaveLength(0);
    expect(nextDay.closed).toHaveLength(1);
    // 20:20 on the 21st → 08:00 on the 22nd is 11h40m.
    expect(nextDay.closed[0].logoutAt).toEqual(new Date('2026-07-22T02:30:00Z'));
    expect(nextDay.closed[0].workedMinutes).toBe(700);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('writes the closures and one audit row each when not a dry run', async () => {
    const { db, audit, svc } = harness(() => open);

    await svc.bulkLogout(user, { date: '2026-07-21', time: '18:05', reason: 'shift ended' });

    expect(updates(db)).toHaveLength(1);
    expect(patch(db).state).toBe('CLOSED');
    expect(patch(db).closedReason).toBe('ADMIN_BULK_LOGOUT');
    // 18:05 IST is 12:35 UTC on the same work date.
    expect(patch(db).logoutAt.toISOString()).toBe('2026-07-21T12:35:00.000Z');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ATTENDANCE_SESSION_BULK_LOGOUT', reason: 'shift ended' }),
    );
  });

  it('rejects a malformed time instead of guessing', async () => {
    const { svc } = harness();
    await expect(
      svc.bulkLogout(user, { date: '2026-07-21', time: '6:05pm', reason: 'x' }),
    ).rejects.toMatchObject({ detail: expect.stringMatching(/HH:mm/) });
  });
});

describe('SessionAdminService.bulkReopen — undoing a stray logout', () => {
  const closed = [
    session({
      id: 'a',
      workerId: 'w5',
      logoutAt: new Date('2026-07-21T06:08:00Z'),
      state: 'CLOSED',
      workedMinutes: 1,
      closedReason: 'SCAN',
      workerFullName: 'Hemanth B U',
      workerCode: 'W-0005',
    }),
    session({
      id: 'b',
      workerId: 'w58',
      logoutAt: new Date('2026-07-21T05:31:00Z'),
      state: 'CLOSED',
      workedMinutes: 1,
      workerFullName: 'Basanta Kumar Satapathy',
      workerCode: 'W-0058',
    }),
  ];

  it('clears the logout and the hours it produced, and audits each row', async () => {
    // 0 the chosen sessions, 1 whoever is open elsewhere (nobody).
    const { db, audit, svc } = harness((n) => (n === 0 ? closed : []));

    const result = await svc.bulkReopen(user, {
      sessionIds: ['a', 'b'],
      reason: 'scanned out by a stray second tap',
    });

    expect(result.reopened.map((r) => r.workerCode)).toEqual(['W-0005', 'W-0058']);
    expect(result.skipped).toEqual([]);
    expect(patch(db)).toMatchObject({
      logoutAt: null,
      state: 'OPEN',
      workedMinutes: null,
      overtimeMinutes: null,
      closedReason: null,
    });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ATTENDANCE_SESSION_REOPEN',
        oldValue: expect.objectContaining({ state: 'CLOSED', workedMinutes: 1 }),
        newValue: expect.objectContaining({ state: 'OPEN', logoutAt: null }),
      }),
    );
  });

  it('writes nothing on a dry run', async () => {
    const { db, audit, svc } = harness((n) => (n === 0 ? closed : []));

    const result = await svc.bulkReopen(user, {
      sessionIds: ['a', 'b'],
      reason: 'checking',
      dryRun: true,
    });

    expect(result.reopened).toHaveLength(2);
    expect(updates(db)).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips anyone already on site rather than breaking the one-open-session rule', async () => {
    const { db, svc } = harness((n) =>
      n === 0 ? closed : [{ workerId: 'w58', workDate: '2026-07-22' }],
    );

    const result = await svc.bulkReopen(user, { sessionIds: ['a', 'b'], reason: 'undo' });

    expect(result.reopened.map((r) => r.workerCode)).toEqual(['W-0005']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        workerCode: 'W-0058',
        reason: 'Already on site from 2026-07-22',
      }),
    ]);
    expect(updates(db)).toHaveLength(1);
  });

  it('reopens only the first of two records for the same person', async () => {
    const twice = [
      closed[0],
      session({
        id: 'c',
        workerId: 'w5',
        state: 'CLOSED',
        workerFullName: 'Hemanth B U',
        workerCode: 'W-0005',
      }),
    ];
    const { svc } = harness((n) => (n === 0 ? twice : []));

    const result = await svc.bulkReopen(user, { sessionIds: ['a', 'c'], reason: 'undo' });

    expect(result.reopened).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/being reopened/);
  });
});

describe('SessionAdminService.remove', () => {
  it('deletes the session and keeps the whole record in the audit row', async () => {
    const { db, audit, svc } = harness(() => [session()]);

    await svc.remove(user, 's1', 'duplicate scan');

    expect(db.writes).toContainEqual(
      expect.objectContaining({ kind: 'delete', table: attendanceSessions }),
    );
    expect(db.boundValues()).toContain('s1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ATTENDANCE_SESSION_DELETE',
        reason: 'duplicate scan',
        oldValue: expect.objectContaining({ workerCode: 'W-0034', workerName: 'Shattappa Kusale' }),
        newValue: null,
      }),
    );
  });
});
