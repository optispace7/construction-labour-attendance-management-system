import { AttendanceService } from './attendance.service';
import { TapSource } from '@prisma/client';

/**
 * Every scan that becomes attendance must leave an audit row — and must still
 * succeed if that audit write fails, because a tap is the one call that cannot
 * be allowed to fail at the gate.
 */
const baseWorker = {
  id: 'w1',
  fullName: 'Ramesh',
  workerCode: 'W-0001',
  category: 'WORKER',
  photoUrl: null,
  bloodGroup: 'B+',
  emergencyContactName: 'S',
  emergencyContactNumber: '9',
  deletedAt: null,
  validityTill: null,
  vendor: null,
  designation: null,
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
  },
};

const dto = (over: Partial<any> = {}) =>
  ({
    eventId: '11111111-1111-4111-8111-111111111111',
    siteId: 'site-1',
    deviceId: 'dev-1',
    source: TapSource.NFC_UID,
    identifier: '04AABBCC',
    clientEventTime: '2026-06-09T02:30:00Z',
    ...over,
  }) as any;

function build(over: any = {}, auditImpl?: jest.Mock) {
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
    ...over,
  };
  const redis: any = { acquireLock: jest.fn().mockResolvedValue('tok'), releaseLock: jest.fn() };
  const audit: any = { record: auditImpl ?? jest.fn() };
  return { svc: new AttendanceService(prisma, redis, audit), prisma, audit };
}

describe('scan auditing', () => {
  it('writes ATTENDANCE_LOGIN when a scan opens a session', async () => {
    const { svc, audit } = build();
    await svc.handleTap('org-1', dto(), { deviceId: 'dev-1', photoRoll: 99 });

    const call = audit.record.mock.calls.find((c: any[]) => c[0].action === 'ATTENDANCE_LOGIN');
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      organizationId: 'org-1',
      entityType: 'Worker',
      entityId: 'w1',
      deviceId: 'dev-1',
    });
    expect(call[0].newValue).toMatchObject({ sessionId: 'sess-1', source: TapSource.NFC_UID });
  });

  it('writes ATTENDANCE_LOGOUT when a scan closes a session', async () => {
    const open = {
      id: 'sess-1',
      workerId: 'w1',
      siteId: 'site-1',
      state: 'OPEN',
      loginAt: new Date('2026-06-09T02:30:00Z'),
      workDate: new Date('2026-06-09T00:00:00Z'),
      shift: null,
    };
    const { svc, audit } = build({
      attendanceSession: {
        findFirst: jest.fn().mockResolvedValue(open),
        findUnique: jest.fn().mockResolvedValue(open),
        create: jest.fn(),
        update: jest
          .fn()
          .mockResolvedValue({ ...open, id: 'sess-1', workedMinutes: 480, logoutAt: new Date() }),
      },
    });
    // Same worker, later in the day → the engine decides LOGOUT.
    await svc.handleTap(
      'org-1',
      dto({
        eventId: '22222222-2222-4222-8222-222222222222',
        clientEventTime: '2026-06-09T12:30:00Z',
      }),
      { deviceId: 'dev-1' },
    );

    const call = audit.record.mock.calls.find((c: any[]) => c[0].action === 'ATTENDANCE_LOGOUT');
    expect(call).toBeDefined();
    expect(call[0].newValue).toMatchObject({ sessionId: 'sess-1', workedMinutes: 480 });
  });

  it('still records the tap when the audit write throws', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('audit table unavailable'));
    const { svc, prisma } = build({}, failing);

    const res = await svc.handleTap('org-1', dto(), { deviceId: 'dev-1', photoRoll: 99 });

    expect(res.result).toBe('LOGIN_RECORDED');
    expect(prisma.attendanceSession.create).toHaveBeenCalled();
  });
});
