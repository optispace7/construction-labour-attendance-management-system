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
    ...prismaOver,
  };
  const redis: any = { acquireLock: jest.fn().mockResolvedValue('tok'), releaseLock: jest.fn() };
  const audit: any = { record: jest.fn() };
  return { svc: new AttendanceService(prisma, redis, audit), prisma };
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

  it('does not let an override wave through a duplicate tap as well', async () => {
    // Overriding the cooldown would reopen the very accident the gap prevents:
    // one badge, read twice in the same breath.
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

    await expect(
      svc.handleTap('org-1', makeDto({ override: { reason: 'anything' } }), { deviceId: 'dev-1' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_TAP' });
  });
});
