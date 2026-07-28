import { AttendanceService } from './attendance.service';
import { TapSource } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';

function makeDto(over: Partial<any> = {}) {
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    siteId: 'site-1',
    deviceId: 'dev-1',
    source: TapSource.NFC_UID,
    identifier: '04AABBCC',
    clientEventTime: '2026-06-09T02:30:00Z',
    ...over,
  } as any;
}

const baseWorker = {
  id: 'w1',
  fullName: 'Ramesh',
  photoUrl: null,
  bloodGroup: 'B+',
  emergencyContactName: 'S',
  emergencyContactNumber: '9',
  deletedAt: null,
  validityTill: null as Date | null,
};
const baseSite = {
  id: 'site-1',
  timezone: 'Asia/Kolkata',
  latitude: null,
  longitude: null,
  settings: {
    siteId: 'site-1',
    verificationMode: 'AUTO',
    autoLoginCountdownSeconds: 10,
    duplicateTapCooldownSeconds: 30,
    safetyGapMinutes: 0,
    geoEnforcement: false,
    geoRadiusMeters: 200,
    photoVerificationMode: 'NEVER',
    photoVerificationRandomPct: 0,
    defaultShiftId: null,
    updatedAt: new Date(),
  },
};

function buildService(prismaOver: any) {
  const prisma: any = {
    attendanceTap: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'tap-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    site: {
      findFirst: jest.fn().mockResolvedValue(baseSite),
      findUnique: jest.fn().mockResolvedValue(baseSite),
    },
    worker: { findFirst: jest.fn().mockResolvedValue(baseWorker) },
    attendanceSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'sess-1', loginAt: new Date('2026-06-09T02:30:00Z') }),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    manualAttendanceRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'mreq-1' }),
    },
    ...prismaOver,
  };
  const redis: any = { acquireLock: jest.fn().mockResolvedValue('tok'), releaseLock: jest.fn() };
  const audit: any = { record: jest.fn() };
  const notifications: any = { create: jest.fn() };
  return {
    svc: new AttendanceService(prisma, redis, audit, notifications),
    prisma,
    audit,
    notifications,
  };
}

describe('AttendanceService.handleTap', () => {
  it('returns IDEMPOTENT_REPLAY for an already-seen eventId', async () => {
    const { svc } = buildService({
      attendanceTap: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tap-x', eventId: 'e', tapType: 'LOGIN' }),
      },
    });
    const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' });
    expect(res.result).toBe('IDEMPOTENT_REPLAY');
  });

  // A typed-in worker code has no badge behind it, so it files a request and
  // leaves attendance alone until a Safety Officer accepts it.
  it('holds a hand-typed LOGIN for review instead of opening a session', async () => {
    const { svc, prisma, notifications } = buildService({});
    const res = await svc.handleTap(
      'org-1',
      makeDto({ source: TapSource.MANUAL, manual: { isBackup: true, reason: 'Forgot card' } }),
      { deviceId: 'dev-1', photoRoll: 99 },
    );

    expect(res.result).toBe('MANUAL_PENDING_APPROVAL');
    expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    // The tap is still written — it is the evidence that someone typed it in.
    expect(prisma.attendanceTap.create).toHaveBeenCalled();
    expect(prisma.manualAttendanceRequest.create).toHaveBeenCalled();
    expect(prisma.manualAttendanceRequest.create.mock.calls[0][0].data).toMatchObject({
      tapType: 'LOGIN',
      reason: 'Forgot card',
      sessionId: null,
    });
    expect(notifications.create).toHaveBeenCalled();
  });

  it('holds a hand-typed LOGOUT for review and leaves the session open', async () => {
    const open = {
      id: 'sess-1',
      loginAt: new Date('2026-06-09T01:00:00Z'),
      siteId: 'site-1',
      shift: null,
    };
    const { svc, prisma } = buildService({
      attendanceSession: {
        findFirst: jest.fn().mockResolvedValue(open),
        findUnique: jest.fn().mockResolvedValue(open),
        create: jest.fn(),
        update: jest.fn(),
      },
    });
    const res = await svc.handleTap(
      'org-1',
      makeDto({ source: TapSource.MANUAL, manual: { isBackup: true, reason: 'Lost card' } }),
      { deviceId: 'dev-1' },
    );

    expect(res.result).toBe('MANUAL_PENDING_APPROVAL');
    expect(prisma.attendanceSession.update).not.toHaveBeenCalled();
    // The logout pins the session it means to close, so approval cannot land on
    // a different one later.
    expect(prisma.manualAttendanceRequest.create.mock.calls[0][0].data).toMatchObject({
      tapType: 'LOGOUT',
      sessionId: 'sess-1',
    });
  });

  it('refuses a second hand-typed punch while one is still waiting', async () => {
    const { svc, prisma } = buildService({
      manualAttendanceRequest: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ tapType: 'LOGIN', createdAt: new Date('2026-06-09T02:00:00Z') }),
        create: jest.fn(),
      },
    });

    await expect(
      svc.handleTap('org-1', makeDto({ source: TapSource.MANUAL, manual: { isBackup: true } }), {
        deviceId: 'dev-1',
      }),
    ).rejects.toMatchObject({ code: 'MANUAL_REVIEW_PENDING' });
    // Nothing is written — the watchman is told at the gate.
    expect(prisma.attendanceTap.create).not.toHaveBeenCalled();
    expect(prisma.manualAttendanceRequest.create).not.toHaveBeenCalled();
  });

  it('still refuses a hand-typed login on an expired card', async () => {
    const { svc, prisma } = buildService({
      worker: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ ...baseWorker, validityTill: new Date('2026-06-01T00:00:00Z') }),
      },
    });

    await expect(
      svc.handleTap('org-1', makeDto({ source: TapSource.MANUAL, manual: { isBackup: true } }), {
        deviceId: 'dev-1',
      }),
    ).rejects.toMatchObject({ code: 'CARD_EXPIRED' });
    expect(prisma.manualAttendanceRequest.create).not.toHaveBeenCalled();
  });

  it('records a LOGIN in AUTO mode (creates an open session)', async () => {
    const { svc, prisma } = buildService({});
    const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1', photoRoll: 99 });
    expect(res.result).toBe('LOGIN_RECORDED');
    expect(prisma.attendanceSession.create).toHaveBeenCalled();
  });

  describe('expired ID card', () => {
    // Tap is 09-Jun-2026 08:00 IST; the card lapsed at the end of 08-Jun.
    const expiredWorker = { ...baseWorker, validityTill: new Date('2026-06-08T00:00:00.000Z') };

    it('refuses the LOGIN and records no tap at all', async () => {
      const { svc, prisma } = buildService({
        worker: { findFirst: jest.fn().mockResolvedValue(expiredWorker) },
      });

      await expect(svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' })).rejects.toBeInstanceOf(
        AppException,
      );
      expect(prisma.attendanceTap.create).not.toHaveBeenCalled();
      expect(prisma.attendanceSession.create).not.toHaveBeenCalled();
    });

    it('names the worker and the expiry date so the gate can act on it', async () => {
      const { svc } = buildService({
        worker: { findFirst: jest.fn().mockResolvedValue(expiredWorker) },
      });
      try {
        await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' });
        throw new Error('expected the tap to be rejected');
      } catch (e) {
        const err = e as AppException;
        expect(err.code).toBe('CARD_EXPIRED');
        expect(err.getStatus()).toBe(422);
        expect(err.detail).toContain('Ramesh');
        expect(err.detail).toContain('2026-06-08');
      }
    });

    it('still lets someone already on site tap out', async () => {
      // Trapping a worker inside the gate would be worse than a lapsed card.
      const open = {
        id: 'sess-1',
        loginAt: new Date('2026-06-09T02:30:00Z'),
        siteId: 'site-1',
        shift: null,
      };
      const { svc } = buildService({
        worker: { findFirst: jest.fn().mockResolvedValue(expiredWorker) },
        attendanceSession: {
          findFirst: jest.fn().mockResolvedValue(open),
          findUnique: jest.fn().mockResolvedValue(open),
          update: jest.fn().mockResolvedValue({
            id: 'sess-1',
            workedMinutes: 540,
            overtimeMinutes: 0,
            logoutAt: new Date(),
          }),
          create: jest.fn(),
        },
      });
      const res = await svc.handleTap(
        'org-1',
        makeDto({ clientEventTime: '2026-06-09T11:30:00Z' }),
        { deviceId: 'dev-1' },
      );
      expect(res.result).toBe('LOGOUT_RECORDED');
    });

    it('lets a card valid through today log in', async () => {
      const validToday = { ...baseWorker, validityTill: new Date('2026-06-09T00:00:00.000Z') };
      const { svc, prisma } = buildService({
        worker: { findFirst: jest.fn().mockResolvedValue(validToday) },
      });
      const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1', photoRoll: 99 });
      expect(res.result).toBe('LOGIN_RECORDED');
      expect(prisma.attendanceSession.create).toHaveBeenCalled();
    });
  });

  it('records a LOGOUT when an open session exists', async () => {
    const open = {
      id: 'sess-1',
      loginAt: new Date('2026-06-09T02:30:00Z'),
      siteId: 'site-1',
      shift: null,
    };
    const { svc } = buildService({
      attendanceSession: {
        findFirst: jest.fn().mockResolvedValue(open),
        findUnique: jest.fn().mockResolvedValue(open),
        update: jest.fn().mockResolvedValue({
          id: 'sess-1',
          workedMinutes: 540,
          overtimeMinutes: 0,
          logoutAt: new Date(),
        }),
        create: jest.fn(),
      },
    });
    const res = await svc.handleTap('org-1', makeDto({ clientEventTime: '2026-06-09T11:30:00Z' }), {
      deviceId: 'dev-1',
    });
    expect(res.result).toBe('LOGOUT_RECORDED');
    expect((res as any).workedMinutes).toBe(540);
  });

  it('rejects a duplicate tap inside the cooldown window', async () => {
    const lastTap = { clientEventTime: new Date('2026-06-09T02:30:00Z'), tapType: 'LOGIN' };
    const { svc } = buildService({
      attendanceTap: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(lastTap),
      },
    });
    await expect(
      svc.handleTap('org-1', makeDto({ clientEventTime: '2026-06-09T02:30:10Z' }), {
        deviceId: 'dev-1',
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_TAP' });
  });
});

describe('AttendanceService.dashboardStats', () => {
  const user = { organizationId: 'org-1', role: 'SUPER_ADMIN', siteScopes: [] } as any;

  /** UTC midnight of a business day, the way businessDate() returns it. */
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  function buildStats(sessionRows: any[], workerGroups: any[], openRows: any[] = []) {
    const prisma: any = {
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }) },
      attendanceSession: {
        // Three calls in order: open sessions, missed logouts, then the
        // today+yesterday window that gate movement is tallied from.
        findMany: jest
          .fn()
          .mockResolvedValueOnce(openRows)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(sessionRows),
      },
      worker: { groupBy: jest.fn().mockResolvedValue(workerGroups) },
    };
    return new AttendanceService(prisma, {} as any, {} as any, {} as any);
  }

  it('counts people rather than sessions, so a worker who re-enters counts once', async () => {
    // Ramesh has two sessions today — he stepped out and came back.
    const today = day(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10));
    const svc = buildStats(
      [
        {
          workerId: 'w1',
          workDate: today,
          state: 'CLOSED',
          lateMinutes: 0,
          worker: { category: 'WORKER' },
        },
        {
          workerId: 'w1',
          workDate: today,
          state: 'OPEN',
          lateMinutes: 0,
          worker: { category: 'WORKER' },
        },
        {
          workerId: 'w2',
          workDate: today,
          state: 'CLOSED',
          lateMinutes: 15,
          worker: { category: 'WORKER' },
        },
      ],
      [{ category: 'WORKER', _count: { _all: 10 } }],
    );

    const res = await svc.dashboardStats(user);

    expect(res.movement.today.checkedIn).toBe(2);
    expect(res.movement.today.onSite).toBe(1);
    // Derived, so the three figures always reconcile on screen.
    expect(res.movement.today.checkedOut).toBe(1);
    expect(res.movement.today.lateArrivals).toBe(1);
  });

  it('reports the registered workforce as the denominator for an attendance rate', async () => {
    const svc = buildStats(
      [],
      [
        { category: 'WORKER', _count: { _all: 120 } },
        { category: 'STAFF', _count: { _all: 8 } },
      ],
    );

    const res = await svc.dashboardStats(user);

    expect(res.workforce.total).toBe(128);
    expect(res.workforce.byCategory).toMatchObject({ WORKER: 120, STAFF: 8, VISITOR: 0 });
  });

  // The reason "on site" read 6 on one screen and 2 on another: four sessions
  // from the previous day were never scanned out.
  it('splits people on site into today and carried over from earlier days', async () => {
    const today = day(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10));
    const yesterday = new Date(today.getTime() - 86_400_000);
    const person = (name: string, workDate: Date) => ({
      loginAt: workDate,
      workDate,
      worker: { fullName: name, workerCode: name, category: 'WORKER' },
      site: { name: 'Tower A' },
    });

    const svc = buildStats(
      [],
      [],
      [
        person('stale-1', yesterday),
        person('stale-2', yesterday),
        person('here-1', today),
        person('here-2', today),
        person('here-3', today),
      ],
    );

    const res = await svc.dashboardStats(user);

    expect(res.onSiteNow.total).toBe(5);
    expect(res.onSiteNow.today).toBe(3);
    expect(res.onSiteNow.carriedOver).toBe(2);
    // The split must always reconcile with the headline, or the card lies.
    expect(res.onSiteNow.today + res.onSiteNow.carriedOver).toBe(res.onSiteNow.total);

    const people = res.onSiteNow.byCategory.WORKER.people;
    expect(people.filter((p) => p.carriedOver).map((p) => p.fullName)).toEqual([
      'stale-1',
      'stale-2',
    ]);
  });

  it('reports nothing carried over when every open session started today', async () => {
    const today = day(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10));
    const svc = buildStats(
      [],
      [],
      [
        {
          loginAt: today,
          workDate: today,
          worker: { fullName: 'Ramesh', workerCode: 'W1', category: 'WORKER' },
          site: { name: 'Tower A' },
        },
      ],
    );

    const res = await svc.dashboardStats(user);
    expect(res.onSiteNow.today).toBe(1);
    expect(res.onSiteNow.carriedOver).toBe(0);
  });

  it('keeps yesterday separate from today so a card can show a real change', async () => {
    const today = day(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10));
    const yesterday = new Date(today.getTime() - 86_400_000);
    const svc = buildStats(
      [
        {
          workerId: 'w1',
          workDate: today,
          state: 'OPEN',
          lateMinutes: 0,
          worker: { category: 'WORKER' },
        },
        {
          workerId: 'w2',
          workDate: yesterday,
          state: 'CLOSED',
          lateMinutes: 0,
          worker: { category: 'WORKER' },
        },
        {
          workerId: 'w3',
          workDate: yesterday,
          state: 'CLOSED',
          lateMinutes: 0,
          worker: { category: 'WORKER' },
        },
      ],
      [],
    );

    const res = await svc.dashboardStats(user);

    expect(res.movement.today.checkedIn).toBe(1);
    expect(res.movement.yesterday.checkedIn).toBe(2);
  });
});

describe('AttendanceService.loggedOutToday', () => {
  const user = {
    organizationId: 'org-1',
    role: 'SITE_ADMIN',
    siteScopes: ['site-1'],
  } as any;

  it('returns one latest logged-out row per person and excludes people currently on site', async () => {
    const workerBackOnSite = {
      id: 'w1',
      fullName: 'Ramesh',
      workerCode: 'W001',
      category: 'WORKER',
    };
    const workerGoneHome = { id: 'w2', fullName: 'Suresh', workerCode: 'W002', category: 'WORKER' };
    const closedRows = [
      {
        id: 'closed-w1',
        loginAt: new Date('2026-07-14T02:30:00Z'),
        logoutAt: new Date('2026-07-14T04:30:00Z'),
        workedMinutes: 120,
        worker: workerBackOnSite,
        site: { id: 'site-1', name: 'Site 1' },
      },
      {
        id: 'closed-w2-latest',
        loginAt: new Date('2026-07-14T02:30:00Z'),
        logoutAt: new Date('2026-07-14T11:30:00Z'),
        workedMinutes: 540,
        worker: workerGoneHome,
        site: { id: 'site-1', name: 'Site 1' },
      },
      {
        id: 'closed-w2-earlier',
        loginAt: new Date('2026-07-14T01:30:00Z'),
        logoutAt: new Date('2026-07-14T02:00:00Z'),
        workedMinutes: 30,
        worker: workerGoneHome,
        site: { id: 'site-1', name: 'Site 1' },
      },
    ];

    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ workerId: 'w1' }])
      .mockResolvedValueOnce(closedRows);
    const { svc } = buildService({
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }) },
      attendanceSession: { findMany },
    });

    const rows = await svc.loggedOutToday(user, 'all', undefined, '2026-07-14');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('closed-w2-latest');
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ state: 'OPEN', siteId: { in: ['site-1'] } }),
      }),
    );
  });
});

describe('AttendanceService.workerTapState', () => {
  it('reports the open session a *different* device opened, so this one scans OUT', async () => {
    const { svc } = buildService({
      attendanceSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'sess-9',
          loginAt: new Date('2026-07-22T02:30:00Z'),
          siteId: 'site-1',
        }),
      },
      attendanceTap: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ clientEventTime: new Date('2026-07-22T02:30:00Z') }),
      },
    });

    const state = await svc.workerTapState('org-1', 'w1');

    expect(state.openSessionId).toBe('sess-9');
    expect(state.lastTapAt).toEqual(new Date('2026-07-22T02:30:00Z'));
  });

  it('reports nobody logged in when there is no open session', async () => {
    const { svc } = buildService({});
    const state = await svc.workerTapState('org-1', 'w1');
    expect(state.openSessionId).toBeNull();
    expect(state.lastTapAt).toBeNull();
  });

  it('rejects a missing workerId rather than scanning the whole org', async () => {
    const { svc } = buildService({});
    await expect(svc.workerTapState('org-1', '')).rejects.toBeInstanceOf(AppException);
  });
});

/**
 * The safety gap at service level: who it applies to, who is exempt, and what
 * the watchman's override does. The window arithmetic itself is covered in
 * engine/tap-decision.spec.ts.
 */
describe('AttendanceService safety gap', () => {
  // Site runs a 10-minute gap; the worker logged in one minute before the tap.
  const gappedSite = {
    ...baseSite,
    settings: { ...baseSite.settings, safetyGapMinutes: 10 },
  };
  const openSession = {
    id: 'sess-1',
    workerId: 'w1',
    siteId: 'site-1',
    state: 'OPEN',
    loginAt: new Date('2026-06-09T02:29:00Z'),
    workDate: new Date('2026-06-09T00:00:00Z'),
    shift: null,
  };

  function buildGapped(over: any = {}) {
    return buildService({
      site: {
        findFirst: jest.fn().mockResolvedValue(gappedSite),
        findUnique: jest.fn().mockResolvedValue(gappedSite),
      },
      attendanceSession: {
        findFirst: jest.fn().mockResolvedValue(openSession),
        findUnique: jest.fn().mockResolvedValue(openSession),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...openSession, workedMinutes: 1 }),
      },
      attendanceTap: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tap-1' }),
        findFirst: jest.fn().mockResolvedValue({
          clientEventTime: new Date('2026-06-09T02:29:00Z'),
          tapType: 'LOGIN',
        }),
      },
      ...over,
    });
  }

  it('refuses to close a session opened a minute ago, and records no tap', async () => {
    const { svc, prisma } = buildGapped();

    await expect(svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' })).rejects.toMatchObject({
      code: 'TAP_TOO_SOON',
    });
    expect(prisma.attendanceTap.create).not.toHaveBeenCalled();
    expect(prisma.attendanceSession.update).not.toHaveBeenCalled();
  });

  it('exempts visitors — a ten-minute site visit is a normal visit', async () => {
    const { svc, prisma } = buildGapped({
      worker: {
        findFirst: jest.fn().mockResolvedValue({ ...baseWorker, category: 'VISITOR' }),
      },
    });

    const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' });

    expect(res.result).toBe('LOGOUT_RECORDED');
    expect(prisma.attendanceSession.update).toHaveBeenCalled();
  });

  it('lets the watchman record it anyway, and keeps his reason', async () => {
    const { svc, prisma } = buildGapped();
    const audit: any = (svc as any).audit;

    const res = await svc.handleTap('org-1', makeDto({ override: { reason: 'Sent home sick' } }), {
      deviceId: 'dev-1',
    });

    expect(res.result).toBe('LOGOUT_RECORDED');
    expect(prisma.attendanceSession.update).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ATTENDANCE_SAFETY_GAP_OVERRIDE',
        entityId: 'w1',
        reason: 'Sent home sick',
      }),
    );
  });

  // The cooldown used to be absolute, and a scan inside it was silently
  // dropped. It is now a refusal the watchman can answer: he is at the gate and
  // can see whether it is one badge read twice or a second man who walked up.
  it('lets a confirmed override clear the duplicate cooldown as well', async () => {
    const { svc, prisma } = buildGapped({
      attendanceTap: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tap-1' }),
        findFirst: jest.fn().mockResolvedValue({
          clientEventTime: new Date('2026-06-09T02:29:50Z'),
          tapType: 'LOGIN',
        }),
      },
    });

    // This fixture has the worker already on site, so the scan closes the
    // session rather than opening one — the point is that it went through.
    const res = await svc.handleTap('org-1', makeDto({ override: {} }), {
      deviceId: 'dev-1',
      photoRoll: 99,
    });

    expect(res.result).toBe('LOGOUT_RECORDED');
    expect(prisma.attendanceTap.create).toHaveBeenCalled();
  });

  it('still refuses a duplicate when nobody overrode it', async () => {
    const { svc } = buildGapped({
      attendanceTap: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tap-1' }),
        findFirst: jest.fn().mockResolvedValue({
          clientEventTime: new Date('2026-06-09T02:29:50Z'),
          tapType: 'LOGIN',
        }),
      },
    });

    await expect(svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' })).rejects.toMatchObject({
      code: 'DUPLICATE_TAP',
    });
  });

  // The prompt for a written reason was removed: watchmen were being asked to
  // justify a decision they had no vocabulary for. The override still audits.
  it('accepts an override with no reason attached', async () => {
    const { svc, audit } = buildGapped({});

    const res = await svc.handleTap('org-1', makeDto({ override: {} }), {
      deviceId: 'dev-1',
      photoRoll: 99,
    });

    expect(res.result).toBe('LOGOUT_RECORDED');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ATTENDANCE_SAFETY_GAP_OVERRIDE' }),
    );
  });
});
