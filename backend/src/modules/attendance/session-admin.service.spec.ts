import { SessionAdminService } from './session-admin.service';

const user: any = { userId: 'u1', organizationId: 'org1', role: 'SUPER_ADMIN', siteScopes: [] };
const site = { id: 'site1', name: 'Brigade WTC', timezone: 'Asia/Kolkata' };
const workDate = new Date(Date.UTC(2026, 6, 21)); // 2026-07-21

function session(over: Partial<any> = {}) {
  return {
    id: 's1',
    workerId: 'w34',
    siteId: 'site1',
    workDate,
    loginAt: new Date('2026-07-21T05:00:00Z'), // 10:30 IST
    logoutAt: null,
    state: 'OPEN',
    workedMinutes: null,
    overtimeMinutes: null,
    closedReason: null,
    loginTapId: null,
    logoutTapId: null,
    worker: { id: 'w34', fullName: 'Shattappa Kusale', workerCode: 'W-0034' },
    site,
    ...over,
  };
}

function harness(over: Partial<any> = {}) {
  const audit: any = { record: jest.fn() };
  const prisma: any = {
    organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }) },
    shift: { findUnique: jest.fn().mockResolvedValue(null) },
    worker: { findFirst: jest.fn() },
    attendanceSession: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ shiftId: null }),
      update: jest.fn((args: any) => Promise.resolve({ ...session(), ...args.data })),
      delete: jest.fn(),
    },
    ...over,
  };
  return { prisma, audit, svc: new SessionAdminService(prisma, audit) };
}

describe('SessionAdminService.edit — moving a session to the right worker', () => {
  it('reassigns the worker, keeps the times, and audits the before/after', async () => {
    const { prisma, audit, svc } = harness();
    prisma.attendanceSession.findFirst
      .mockResolvedValueOnce(session()) // loadSession
      .mockResolvedValueOnce(null); // no clashing record for the target
    prisma.worker.findFirst.mockResolvedValue({
      id: 'w59',
      fullName: 'Yallappa',
      workerCode: 'W-0059',
    });
    prisma.attendanceSession.update.mockResolvedValue(
      session({
        workerId: 'w59',
        worker: { id: 'w59', fullName: 'Yallappa', workerCode: 'W-0059' },
      }),
    );

    await svc.edit(user, 's1', { workerId: 'w59', reason: 'W-0034 was not on site' });

    const data = prisma.attendanceSession.update.mock.calls[0][0].data;
    expect(data.workerId).toBe('w59');
    expect(data.loginAt).toEqual(new Date('2026-07-21T05:00:00Z'));
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
    const { prisma, svc } = harness();
    prisma.attendanceSession.findFirst
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce({ id: 's2', state: 'OPEN', loginAt: new Date() });
    prisma.worker.findFirst.mockResolvedValue({
      id: 'w59',
      fullName: 'Yallappa',
      workerCode: 'W-0059',
    });

    await expect(svc.edit(user, 's1', { workerId: 'w59', reason: 'swap' })).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
      detail: expect.stringMatching(/already has an open session/),
    });
    expect(prisma.attendanceSession.update).not.toHaveBeenCalled();
  });

  it('rejects a logout that lands before the login', async () => {
    const { prisma, svc } = harness();
    prisma.attendanceSession.findFirst.mockResolvedValueOnce(session());

    await expect(
      svc.edit(user, 's1', { logoutAt: '2026-07-21T04:00:00Z', reason: 'typo' }),
    ).rejects.toMatchObject({ detail: expect.stringMatching(/after the login time/) });
  });

  it('recomputes hours and closes the session when a logout time is set', async () => {
    const { prisma, svc } = harness();
    prisma.attendanceSession.findFirst.mockResolvedValueOnce(session());

    await svc.edit(user, 's1', { logoutAt: '2026-07-21T12:35:00Z', reason: 'left at 18:05' });

    const data = prisma.attendanceSession.update.mock.calls[0][0].data;
    expect(data.state).toBe('CLOSED');
    expect(data.workedMinutes).toBe(455); // 10:30 → 18:05 IST
    expect(data.overtimeMinutes).toBe(0); // under the 8h default day
  });
});

describe('SessionAdminService.bulkLogout — the end-of-shift sweep', () => {
  const open = [
    {
      ...session({ id: 'a', worker: { fullName: 'Viresh', workerCode: 'W-0010' } }),
      shiftId: null,
    },
    {
      ...session({
        id: 'b',
        loginAt: new Date('2026-07-21T12:54:50Z'), // 18:24 IST — after the sweep time
        worker: { fullName: 'Verash', workerCode: 'W-0012' },
      }),
      shiftId: null,
    },
  ];

  it('closes what it can and reports who was skipped, without writing on a dry run', async () => {
    const { prisma, audit, svc } = harness();
    prisma.attendanceSession.findMany.mockResolvedValue(open);

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
    expect(prisma.attendanceSession.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('stamps the morning after the work date when told the shift ran overnight', async () => {
    const { prisma, audit, svc } = harness();
    // A night man: in at 20:20 IST on the 21st, still open.
    prisma.attendanceSession.findMany.mockResolvedValue([
      {
        ...session({
          id: 'n',
          loginAt: new Date('2026-07-21T14:50:00Z'),
          worker: { fullName: 'Kailu', workerCode: 'W-0084' },
        }),
        shiftId: null,
      },
    ]);

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
    const { prisma, audit, svc } = harness();
    prisma.attendanceSession.findMany.mockResolvedValue(open);

    await svc.bulkLogout(user, { date: '2026-07-21', time: '18:05', reason: 'shift ended' });

    expect(prisma.attendanceSession.update).toHaveBeenCalledTimes(1);
    const data = prisma.attendanceSession.update.mock.calls[0][0].data;
    expect(data.state).toBe('CLOSED');
    expect(data.closedReason).toBe('ADMIN_BULK_LOGOUT');
    // 18:05 IST is 12:35 UTC on the same work date.
    expect(data.logoutAt.toISOString()).toBe('2026-07-21T12:35:00.000Z');
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
      worker: { id: 'w5', fullName: 'Hemanth B U', workerCode: 'W-0005' },
    }),
    session({
      id: 'b',
      workerId: 'w58',
      logoutAt: new Date('2026-07-21T05:31:00Z'),
      state: 'CLOSED',
      workedMinutes: 1,
      worker: { id: 'w58', fullName: 'Basanta Kumar Satapathy', workerCode: 'W-0058' },
    }),
  ];

  it('clears the logout and the hours it produced, and audits each row', async () => {
    const { prisma, audit, svc } = harness();
    prisma.attendanceSession.findMany
      .mockResolvedValueOnce(closed) // the chosen sessions
      .mockResolvedValueOnce([]); // nobody is open elsewhere

    const result = await svc.bulkReopen(user, {
      sessionIds: ['a', 'b'],
      reason: 'scanned out by a stray second tap',
    });

    expect(result.reopened.map((r) => r.workerCode)).toEqual(['W-0005', 'W-0058']);
    expect(result.skipped).toEqual([]);
    const data = prisma.attendanceSession.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
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
    const { prisma, audit, svc } = harness();
    prisma.attendanceSession.findMany.mockResolvedValueOnce(closed).mockResolvedValueOnce([]);

    const result = await svc.bulkReopen(user, {
      sessionIds: ['a', 'b'],
      reason: 'checking',
      dryRun: true,
    });

    expect(result.reopened).toHaveLength(2);
    expect(prisma.attendanceSession.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips anyone already on site rather than breaking the one-open-session rule', async () => {
    const { prisma, svc } = harness();
    prisma.attendanceSession.findMany
      .mockResolvedValueOnce(closed)
      .mockResolvedValueOnce([{ workerId: 'w58', workDate: new Date(Date.UTC(2026, 6, 22)) }]);

    const result = await svc.bulkReopen(user, { sessionIds: ['a', 'b'], reason: 'undo' });

    expect(result.reopened.map((r) => r.workerCode)).toEqual(['W-0005']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        workerCode: 'W-0058',
        reason: 'Already on site from 2026-07-22',
      }),
    ]);
    expect(prisma.attendanceSession.update).toHaveBeenCalledTimes(1);
  });

  it('reopens only the first of two records for the same person', async () => {
    const { prisma, svc } = harness();
    const twice = [
      closed[0],
      session({ id: 'c', workerId: 'w5', state: 'CLOSED', worker: closed[0].worker }),
    ];
    prisma.attendanceSession.findMany.mockResolvedValueOnce(twice).mockResolvedValueOnce([]);

    const result = await svc.bulkReopen(user, { sessionIds: ['a', 'c'], reason: 'undo' });

    expect(result.reopened).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/being reopened/);
  });
});

describe('SessionAdminService.remove', () => {
  it('deletes the session and keeps the whole record in the audit row', async () => {
    const { prisma, audit, svc } = harness();
    prisma.attendanceSession.findFirst.mockResolvedValue(session());

    await svc.remove(user, 's1', 'duplicate scan');

    expect(prisma.attendanceSession.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
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
