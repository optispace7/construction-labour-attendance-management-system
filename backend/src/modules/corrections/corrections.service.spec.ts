import { CorrectionsService } from './corrections.service';

const user: any = { userId: 'u1', organizationId: 'org1', role: 'SITE_ADMIN', siteScopes: [] };

describe('CorrectionsService.approve (approval gate)', () => {
  it('aborts with CONFLICT when the session changed after the request was filed', async () => {
    const requestCreatedAt = new Date('2026-06-08T10:00:00Z');
    const sessionUpdatedAt = new Date('2026-06-08T12:00:00Z'); // later → stale request

    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          sessionId: 's1',
          createdAt: requestCreatedAt,
          items: [{ field: 'logout_at', proposedValue: '2026-06-08T11:00:00Z' }],
        }),
        update: jest.fn(),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's1',
          updatedAt: sessionUpdatedAt,
          loginAt: new Date(),
          logoutAt: null,
          siteId: 's',
          shiftId: null,
        }),
        update: jest.fn(),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const audit: any = { record: jest.fn() };
    const svc = new CorrectionsService(prisma, audit);

    await expect(svc.approve(user, 'c1', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.correctionRequest.update).not.toHaveBeenCalled();
  });

  it('resolves the session by worker + work date when the request has no sessionId', async () => {
    const workDate = new Date(Date.UTC(2026, 5, 8));
    const session = {
      id: 's1',
      updatedAt: new Date('2026-06-08T12:00:00Z'),
      loginAt: new Date('2026-06-08T03:30:00Z'), // 09:00 IST
      logoutAt: null,
      siteId: 'site1',
      shiftId: null,
      workDate,
      shift: null,
      site: { timezone: 'Asia/Kolkata' },
    };
    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null, // mobile-filed request
          workDate,
          createdAt: new Date('2026-06-08T10:00:00Z'),
          items: [{ field: 'logout_at', proposedValue: '2026-06-08T12:30:00Z' }],
        }),
        update: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(session),
        create: jest.fn(),
        update: jest
          .fn()
          .mockResolvedValue({ ...session, logoutAt: new Date('2026-06-08T12:30:00Z') }),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const audit: any = { record: jest.fn() };
    const svc = new CorrectionsService(prisma, audit);

    const res = await svc.approve(user, 'c1', {});

    expect(res.status).toBe('APPROVED');
    // The session was located without a pinned id and actually patched.
    expect(tx.attendanceSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org1', workerId: 'w1', workDate },
      }),
    );
    expect(tx.attendanceSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: expect.objectContaining({ logoutAt: new Date('2026-06-08T12:30:00Z') }),
      }),
    );
    // ...and the approved request is back-linked to the row it changed.
    expect(tx.correctionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sessionId: 's1' }) }),
    );
  });

  it('refiles the session under the corrected login date', async () => {
    const workDate = new Date(Date.UTC(2026, 5, 8));
    const session = {
      id: 's1',
      updatedAt: new Date('2026-06-08T12:00:00Z'),
      loginAt: new Date('2026-06-08T03:30:00Z'),
      logoutAt: null,
      siteId: 'site1',
      shiftId: null,
      workDate,
      shift: null,
      site: { timezone: 'Asia/Kolkata' },
    };
    // Correction moves login to 2026-06-09 09:00 IST → work date must follow.
    const correctedLogin = new Date('2026-06-09T03:30:00Z');
    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null,
          workDate,
          createdAt: new Date('2026-06-09T10:00:00Z'),
          items: [{ field: 'login_at', proposedValue: correctedLogin.toISOString() }],
        }),
        update: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(session),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...session, loginAt: correctedLogin }),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const audit: any = { record: jest.fn() };
    const svc = new CorrectionsService(prisma, audit);

    await svc.approve(user, 'c1', {});

    expect(tx.attendanceSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { workDate: new Date(Date.UTC(2026, 5, 9)) } }),
    );
  });

  it('targets the day the supervisor picked, not the off-by-one workDate', async () => {
    // The mobile files workDate as UTC-converted local midnight, so a correction
    // meant for the 15th arrives stamped the 14th. Approving must not grab the
    // 14th's real session and overwrite it.
    const sessionOn14th = {
      id: 's14',
      updatedAt: new Date('2026-07-14T08:00:00Z'),
      loginAt: new Date('2026-07-14T07:09:00Z'),
      logoutAt: null,
      siteId: 'site1',
      shiftId: null,
      workDate: new Date(Date.UTC(2026, 6, 14)),
      shift: null,
      site: { timezone: 'Asia/Kolkata' },
    };
    const created: any[] = [];
    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null,
          workDate: new Date(Date.UTC(2026, 6, 14)), // filed a day early
          createdAt: new Date('2026-07-15T10:00:00Z'),
          // Supervisor picked 2026-07-15 10:50 IST.
          items: [{ field: 'login_at', proposedValue: '2026-07-15T05:20:00.000Z' }],
        }),
        update: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        // Only the 14th's session exists; nothing on the 15th.
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.state === 'OPEN') return null;
          return where.workDate?.getTime() === Date.UTC(2026, 6, 14) ? sessionOn14th : null;
        }),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const row = { id: 'sNew', ...data, shift: null, site: { timezone: 'Asia/Kolkata' } };
          created.push(row);
          return row;
        }),
        update: jest.fn().mockImplementation(async () => ({
          ...created[0],
          shift: null,
          site: { timezone: 'Asia/Kolkata' },
        })),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const svc = new CorrectionsService(prisma, { record: jest.fn() } as any);

    await svc.approve(user, 'c1', {});

    // The 14th's session must be untouched; a new one lands on the 15th.
    expect(tx.attendanceSession.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's14' } }),
    );
    expect(created).toHaveLength(1);
    expect(created[0].workDate).toEqual(new Date(Date.UTC(2026, 6, 15)));
  });

  it('refuses a login-only correction when the worker already has an open session', async () => {
    // uq_open_session_per_worker permits only one — creating a second would
    // blow up on the unique index at write time.
    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null,
          workDate: new Date(Date.UTC(2026, 6, 15)),
          createdAt: new Date('2026-07-15T10:00:00Z'),
          items: [{ field: 'login_at', proposedValue: '2026-07-15T05:20:00.000Z' }],
        }),
        update: jest.fn(),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.state === 'OPEN') return { id: 'sOpen' }; // already clocked in
          return null;
        }),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const svc = new CorrectionsService(prisma, { record: jest.fn() } as any);

    await expect(svc.approve(user, 'c1', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.attendanceSession.create).not.toHaveBeenCalled();
  });

  it('creates the session CLOSED when the correction supplies a logout', async () => {
    const created: any[] = [];
    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null,
          workDate: new Date(Date.UTC(2026, 6, 15)),
          createdAt: new Date('2026-07-15T10:00:00Z'),
          items: [
            { field: 'login_at', proposedValue: '2026-07-15T03:30:00.000Z' },
            { field: 'logout_at', proposedValue: '2026-07-15T12:30:00.000Z' },
          ],
        }),
        update: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const row = { id: 'sNew', ...data, shift: null, site: { timezone: 'Asia/Kolkata' } };
          created.push(row);
          return row;
        }),
        update: jest.fn().mockImplementation(async () => ({
          ...created[0],
          shift: null,
          site: { timezone: 'Asia/Kolkata' },
        })),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const svc = new CorrectionsService(prisma, { record: jest.fn() } as any);

    await svc.approve(user, 'c1', {});

    // Never OPEN — that would collide with uq_open_session_per_worker.
    expect(created[0].state).toBe('CLOSED');
    // And no pre-flight open-session probe was needed.
    expect(tx.attendanceSession.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ state: 'OPEN' }) }),
    );
  });

  it('refuses a logout that lands before the login it belongs to', async () => {
    const workDate = new Date(Date.UTC(2026, 7, 5));
    const session = {
      id: 's1',
      updatedAt: new Date('2026-08-05T16:20:00Z'),
      loginAt: new Date('2026-08-05T16:14:10Z'), // 21:44 IST
      logoutAt: null,
      siteId: 'site1',
      shiftId: null,
      workDate,
      shift: null,
      site: { timezone: 'Asia/Kolkata' },
    };
    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null,
          workDate,
          createdAt: new Date('2026-08-06T05:30:00Z'),
          // 18:26 IST — earlier in the day than the login above.
          items: [{ field: 'logout_at', proposedValue: '2026-08-05T12:56:00Z' }],
        }),
        update: jest.fn(),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(session),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const audit: any = { record: jest.fn() };
    const svc = new CorrectionsService(prisma, audit);

    await expect(svc.approve(user, 'c1', {})).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
    // Nothing was written: the day keeps whatever it had rather than closing
    // with negative time that the hours engine floors to zero.
    expect(tx.attendanceSession.update).not.toHaveBeenCalled();
    expect(tx.correctionRequest.update).not.toHaveBeenCalled();
  });

  it('closes the night shift running into the day a logout correction names', async () => {
    // In at 21:30 IST on the 5th, out at 08:00 IST on the 6th. The 6th has no
    // session of its own — the row to close is the one still open from the 5th.
    const session = {
      id: 's1',
      updatedAt: new Date('2026-08-05T16:00:00Z'),
      loginAt: new Date('2026-08-05T16:00:00Z'), // 21:30 IST on the 5th
      logoutAt: null,
      siteId: 'site1',
      shiftId: null,
      workDate: new Date(Date.UTC(2026, 7, 5)),
      shift: null,
      site: { timezone: 'Asia/Kolkata' },
    };
    const proposedLogout = new Date('2026-08-06T02:30:00Z'); // 08:00 IST on the 6th
    const findFirst = jest
      .fn()
      // Resolved by day first: nothing on the 6th…
      .mockResolvedValueOnce(null)
      // …then by the shift running into it.
      .mockResolvedValueOnce(session);
    const tx: any = {
      correctionRequest: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null,
          workDate: new Date(Date.UTC(2026, 7, 5)),
          createdAt: new Date('2026-08-06T04:00:00Z'),
          items: [{ field: 'logout_at', proposedValue: proposedLogout.toISOString() }],
        }),
        update: jest.fn().mockResolvedValue({ id: 'c1', status: 'APPROVED' }),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        findFirst,
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...session, logoutAt: proposedLogout }),
      },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const audit: any = { record: jest.fn() };
    const svc = new CorrectionsService(prisma, audit);

    const res = await svc.approve(user, 'c1', {});

    expect(res.status).toBe('APPROVED');
    // No row was invented for the 6th…
    expect(tx.attendanceSession.create).not.toHaveBeenCalled();
    // …the previous evening's session was closed instead, and it stays filed
    // under the day the shift started.
    expect(tx.attendanceSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: expect.objectContaining({ logoutAt: proposedLogout }),
      }),
    );
    expect(tx.attendanceSession.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { workDate: new Date(Date.UTC(2026, 7, 6)) } }),
    );
  });

  it('does not mutate attendance when rejecting', async () => {
    const prisma: any = {
      correctionRequest: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'c1', status: 'PENDING', organizationId: 'org1' }),
        update: jest.fn().mockResolvedValue({ id: 'c1', status: 'REJECTED' }),
      },
    };
    const audit: any = { record: jest.fn() };
    const svc = new CorrectionsService(prisma, audit);
    const res = await svc.reject(user, 'c1', { reviewNotes: 'invalid' });
    expect(res.status).toBe('REJECTED');
  });
});
