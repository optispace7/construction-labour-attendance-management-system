import { AttendanceService } from './attendance.service';
import { TapSource } from '@prisma/client';

/**
 * A hand-typed punch that a real badge scan has overtaken.
 *
 * This happened at Brigade WTC on 5 Aug 2026: a watchman typed a logout, the
 * man found his card and scanned out 29 seconds later, and the typed entry sat
 * in the review queue pointing at a session that was already closed. Accepting
 * it could only ever 409, and until somebody declined it by hand he was still
 * listed as waiting and no second manual punch could be typed for him.
 */
const baseWorker = {
  id: 'w1',
  fullName: 'Basanta',
  workerCode: 'W-0058',
  category: 'WORKER',
  photoUrl: null,
  bloodGroup: null,
  emergencyContactName: null,
  emergencyContactNumber: null,
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
    source: TapSource.QR,
    identifier: 'W-0058',
    clientEventTime: '2026-06-09T02:30:00Z',
    ...over,
  }) as any;

const pendingRequest = {
  id: 'mreq-1',
  tapType: 'LOGOUT',
  recordedAt: new Date('2026-06-09T12:29:31Z'),
};

function build(over: any = {}) {
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
    worker: {
      findFirst: jest.fn().mockResolvedValue(baseWorker),
      findUnique: jest.fn().mockResolvedValue(baseWorker),
    },
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
      update: jest.fn().mockResolvedValue({ id: 'mreq-1' }),
    },
    ...over,
  };
  const redis: any = { acquireLock: jest.fn().mockResolvedValue('tok'), releaseLock: jest.fn() };
  const audit: any = { record: jest.fn() };
  const notifications: any = { create: jest.fn() };
  return {
    svc: new AttendanceService(prisma, redis, audit, notifications),
    prisma,
    audit,
  };
}

/** An open session for w1, so the tap engine decides LOGOUT. */
function openSessionMocks() {
  const open = {
    id: 'sess-1',
    workerId: 'w1',
    siteId: 'site-1',
    state: 'OPEN',
    loginAt: new Date('2026-06-09T02:30:00Z'),
    workDate: new Date('2026-06-09T00:00:00Z'),
    shift: null,
  };
  return {
    attendanceSession: {
      findFirst: jest.fn().mockResolvedValue(open),
      findUnique: jest.fn().mockResolvedValue(open),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({
        ...open,
        state: 'CLOSED',
        workedMinutes: 600,
        logoutAt: new Date('2026-06-09T12:30:00Z'),
      }),
    },
  };
}

const logoutTap = dto({
  eventId: '22222222-2222-4222-8222-222222222222',
  clientEventTime: '2026-06-09T12:30:00Z',
});

describe('a badge scan supersedes the pending manual entry it overtook', () => {
  it('closes the pending request when a scan logs the worker out', async () => {
    const { svc, prisma } = build({
      ...openSessionMocks(),
      manualAttendanceRequest: {
        findFirst: jest.fn().mockResolvedValue(pendingRequest),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'mreq-1' }),
      },
    });

    await svc.handleTap('org-1', logoutTap, { deviceId: 'dev-1' });

    const patch = prisma.manualAttendanceRequest.update.mock.calls[0][0];
    expect(patch.where).toEqual({ id: 'mreq-1' });
    expect(patch.data).toMatchObject({ status: 'REJECTED' });
    // Nobody decided this — the null reviewer is how the queue tells the two
    // apart, so it must not be filled in with whoever was at the gate.
    expect(patch.data.reviewedBy).toBeUndefined();
    expect(patch.data.reviewNotes).toContain('a QR badge scan logged Basanta out');
  });

  it('closes the pending request when a scan logs the worker in', async () => {
    const { svc, prisma } = build({
      manualAttendanceRequest: {
        findFirst: jest.fn().mockResolvedValue({ ...pendingRequest, tapType: 'LOGIN' }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'mreq-1' }),
      },
    });

    await svc.handleTap('org-1', dto(), { deviceId: 'dev-1', photoRoll: 99 });

    expect(prisma.manualAttendanceRequest.update).toHaveBeenCalled();
  });

  it('records who overtook it in the audit trail', async () => {
    const { svc, audit } = build({
      ...openSessionMocks(),
      manualAttendanceRequest: {
        findFirst: jest.fn().mockResolvedValue(pendingRequest),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'mreq-1' }),
      },
    });

    await svc.handleTap('org-1', logoutTap, { deviceId: 'dev-1' });

    const call = audit.record.mock.calls.find(
      (c: any[]) => c[0].action === 'MANUAL_ATTENDANCE_SUPERSEDED',
    );
    expect(call).toBeDefined();
    expect(call[0]).toMatchObject({
      entityType: 'ManualAttendanceRequest',
      entityId: 'mreq-1',
      deviceId: 'dev-1',
    });
    expect(call[0].newValue.supersededBy).toMatchObject({
      tapType: 'LOGOUT',
      sessionId: 'sess-1',
    });
    // No actor: a scan resolved this, not a Safety Officer.
    expect(call[0].actorUserId).toBeUndefined();
  });

  it('leaves the queue alone when nothing is waiting', async () => {
    const { svc, prisma } = build(openSessionMocks());
    await svc.handleTap('org-1', logoutTap, { deviceId: 'dev-1' });
    expect(prisma.manualAttendanceRequest.update).not.toHaveBeenCalled();
  });

  it('still records the scan when the queue tidy-up fails', async () => {
    const { svc } = build({
      ...openSessionMocks(),
      manualAttendanceRequest: {
        findFirst: jest.fn().mockResolvedValue(pendingRequest),
        create: jest.fn(),
        update: jest.fn().mockRejectedValue(new Error('db unavailable')),
      },
    });

    const res = await svc.handleTap('org-1', logoutTap, { deviceId: 'dev-1' });

    expect(res.result).toBe('LOGOUT_RECORDED');
  });
});
