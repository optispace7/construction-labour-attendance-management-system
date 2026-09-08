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

function build(over: { pending?: unknown; openSession?: boolean; failUpdate?: boolean } = {}) {
  const db = drizzleDouble(
    [
      [sites, [{ site: baseSite, settings: baseSettings }]],
      [workers, [{ worker: baseWorker, vendorName: null, designationName: null }]],
      [attendanceTaps, []],
      [attendanceSessions, over.openSession ? [openSession] : []],
      [manualAttendanceRequests, over.pending ? [over.pending] : []],
    ],
    {
      onWrite: (kind, table) => {
        if (table === attendanceTaps) return [{ id: 'tap-1' }];
        if (table === attendanceSessions) {
          return [
            {
              ...openSession,
              state: 'CLOSED',
              workedMinutes: 600,
              logoutAt: new Date('2026-06-09T12:30:00Z'),
            },
          ];
        }
        if (table === manualAttendanceRequests) {
          if (over.failUpdate) throw new Error('db unavailable');
          return [{ id: 'mreq-1' }];
        }
        return [];
      },
    },
  );
  const redis: any = { acquireLock: jest.fn().mockResolvedValue('tok'), releaseLock: jest.fn() };
  const audit: any = { record: jest.fn() };
  const notifications: any = { create: jest.fn() };
  return {
    svc: new AttendanceService({ db: db.db } as any, redis, audit, notifications),
    db,
    audit,
  };
}

/**
 * An open session for w1, so the tap engine decides LOGOUT.
 *
 * It is read twice on the way through — once as a plain row for the decision,
 * once through a join with its shift — so it carries both shapes.
 */
const openSession = {
  id: 'sess-1',
  workerId: 'w1',
  siteId: 'site-1',
  state: 'OPEN',
  loginAt: new Date('2026-06-09T02:30:00Z'),
  workDate: '2026-06-09',
  session: {
    id: 'sess-1',
    workerId: 'w1',
    siteId: 'site-1',
    state: 'OPEN',
    loginAt: new Date('2026-06-09T02:30:00Z'),
    workDate: '2026-06-09',
  },
  shift: null,
};



const logoutTap = dto({
  eventId: '22222222-2222-4222-8222-222222222222',
  clientEventTime: '2026-06-09T12:30:00Z',
});

describe('a badge scan supersedes the pending manual entry it overtook', () => {
  it('closes the pending request when a scan logs the worker out', async () => {
    const { svc, db } = build({ openSession: true, pending: pendingRequest });

    await svc.handleTap('org-1', logoutTap, { deviceId: 'dev-1' });

    const patch = db.wrote(manualAttendanceRequests) as any;
    expect(patch).toMatchObject({ status: 'REJECTED' });
    expect(db.boundValues()).toContain('mreq-1');
    // Nobody decided this — the null reviewer is how the queue tells the two
    // apart, so it must not be filled in with whoever was at the gate.
    expect(patch.reviewedBy).toBeUndefined();
    expect(patch.reviewNotes).toContain('a QR badge scan logged Basanta out');
  });

  it('closes the pending request when a scan logs the worker in', async () => {
    const { svc, db } = build({ pending: { ...pendingRequest, tapType: 'LOGIN' } });

    await svc.handleTap('org-1', dto(), { deviceId: 'dev-1', photoRoll: 99 });

    expect(db.wrote(manualAttendanceRequests)).toMatchObject({ status: 'REJECTED' });
  });

  it('records who overtook it in the audit trail', async () => {
    const { svc, audit } = build({ openSession: true, pending: pendingRequest });

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
    const { svc, db } = build({ openSession: true });
    await svc.handleTap('org-1', logoutTap, { deviceId: 'dev-1' });
    expect(db.writes.some((w) => w.table === manualAttendanceRequests)).toBe(false);
  });

  it('still records the scan when the queue tidy-up fails', async () => {
    const { svc } = build({ openSession: true, pending: pendingRequest, failUpdate: true });

    const res = await svc.handleTap('org-1', logoutTap, { deviceId: 'dev-1' });

    expect(res.result).toBe('LOGOUT_RECORDED');
  });
});
