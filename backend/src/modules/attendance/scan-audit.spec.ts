import { AttendanceService } from './attendance.service';
import { TapSource } from '../../common/enums';
import { drizzleDouble } from '../../../test/drizzle-double';
import {
  attendanceSessions,
  attendanceTaps,
  manualAttendanceRequests,
  sites,
  workers,
} from '../../infra/d1/schema.generated';

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
};

const baseSettings = {
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
};

const baseSite = { id: 'site-1', timezone: 'Asia/Kolkata', latitude: null, longitude: null };

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

/**
 * The site and worker reads are joins, so their rows arrive under the join's
 * own keys — the same shape the service destructures.
 */
function build(
  over: { openSession?: unknown; auditImpl?: jest.Mock; onWrite?: jest.Mock } = {},
) {
  const db = drizzleDouble(
    [
      [sites, [{ site: baseSite, settings: baseSettings }]],
      [
        workers,
        [{ worker: baseWorker, vendorName: null, designationName: null }],
      ],
      // Read twice on a tap: once for the replay check (nothing), then for the
      // worker's last tap (also nothing here — the engine sees a fresh day).
      [attendanceTaps, () => []],
      [attendanceSessions, over.openSession ? [over.openSession] : []],
      [manualAttendanceRequests, []],
    ],
    {
      onWrite: (kind, table) => {
        if (table === attendanceTaps) return [{ id: 'tap-1' }];
        if (table === attendanceSessions) {
          return [
            {
              id: 'sess-1',
              loginAt: new Date('2026-06-09T02:30:00Z'),
              logoutAt: new Date('2026-06-09T12:30:00Z'),
              workedMinutes: 480,
              overtimeMinutes: 0,
            },
          ];
        }
        return [];
      },
    },
  );
  const redis: any = { acquireLock: jest.fn().mockResolvedValue('tok'), releaseLock: jest.fn() };
  const audit: any = { record: over.auditImpl ?? jest.fn() };
  const notifications: any = { create: jest.fn() };
  return {
    svc: new AttendanceService({ db: db.db } as any, redis, audit, notifications),
    db,
    audit,
    notifications,
  };
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
      session: {
        id: 'sess-1',
        workerId: 'w1',
        siteId: 'site-1',
        state: 'OPEN',
        loginAt: new Date('2026-06-09T02:30:00Z'),
        workDate: '2026-06-09',
      },
      shift: null,
      // The open-session read is a plain select, so the row is also its own
      // columns — one object serves both reads.
      id: 'sess-1',
      workerId: 'w1',
      siteId: 'site-1',
      state: 'OPEN',
      loginAt: new Date('2026-06-09T02:30:00Z'),
      workDate: '2026-06-09',
    };
    const { svc, audit } = build({ openSession: open });

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
    const { svc, db } = build({ auditImpl: failing });

    const res = await svc.handleTap('org-1', dto(), { deviceId: 'dev-1', photoRoll: 99 });

    expect(res.result).toBe('LOGIN_RECORDED');
    expect(db.writes.some((w) => w.kind === 'insert' && w.table === attendanceSessions)).toBe(true);
  });
});
