import { AttendanceService } from './attendance.service';
import { TapSource } from '../../common/enums';
import { drizzleDouble } from '../../../test/drizzle-double';
import {
  attendanceSessions,
  attendanceTaps,
  sites,
  workers,
} from '../../infra/d1/schema.generated';

/**
 * The gate's confirm screen shows what previewTap answers.
 *
 * It used to show the phone's own guess, made from its copy of who was on
 * site. That copy could not see a login made at another gate, so the screen
 * offered LOGIN, the watchman pressed OK, and the server recorded LOGOUT. The
 * preview reads the same rows as the scan and runs the same decision — and
 * writes nothing, because the watchman can still press Cancel.
 */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

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
  validityTill: null as string | null,
};

const baseSettings = {
  siteId: 'site-1',
  verificationMode: 'AUTO',
  autoLoginCountdownSeconds: 10,
  duplicateTapCooldownSeconds: 30,
  safetyGapMinutes: 10,
  geoEnforcement: false,
  geoRadiusMeters: 200,
  photoVerificationMode: 'NEVER',
  photoVerificationRandomPct: 0,
  defaultShiftId: null,
  updatedAt: new Date(),
};

const baseSite = { id: 'site-1', timezone: 'Asia/Kolkata', latitude: null, longitude: null };

function build(
  o: {
    worker?: Record<string, unknown> | null;
    openSession?: Record<string, unknown>;
    lastTap?: Record<string, unknown>;
  } = {},
) {
  const db = drizzleDouble([
    [sites, [{ site: baseSite, settings: baseSettings }]],
    [
      workers,
      o.worker === null
        ? []
        : [
            {
              worker: { ...baseWorker, ...(o.worker ?? {}) },
              vendorName: 'Acme',
              designationName: 'Mason',
            },
          ],
    ],
    [attendanceSessions, o.openSession ? [o.openSession] : []],
    [attendanceTaps, o.lastTap ? [o.lastTap] : []],
  ]);
  const redis: any = { acquireLock: jest.fn(), releaseLock: jest.fn() };
  const svc = new AttendanceService(
    { db: db.db } as any,
    redis,
    { record: jest.fn() } as any,
    { create: jest.fn() } as any,
  );
  return { svc, db, redis };
}

const dto = { siteId: 'site-1', source: TapSource.QR, identifier: 'W-0001' } as any;

const openSession = (loginAt: Date, siteId = 'site-1') => ({
  id: 'sess-1',
  workerId: 'w1',
  siteId,
  state: 'OPEN',
  loginAt,
});
const loginTap = (at: Date) => ({ clientEventTime: at, tapType: 'LOGIN' });

describe('AttendanceService.previewTap', () => {
  it('offers LOGIN to someone not on site, with the card the screen shows', async () => {
    const { svc, db, redis } = build();

    const res = await svc.previewTap('org-1', dto);

    expect(res).toMatchObject({
      action: 'LOGIN',
      worker: { id: 'w1', workerCode: 'W-0001', vendorName: 'Acme' },
    });
    expect(db.writes).toHaveLength(0);
    // A question, not a scan: no per-worker lock is held for it.
    expect(redis.acquireLock).not.toHaveBeenCalled();
  });

  it('offers LOGOUT to someone logged in at another gate', async () => {
    const { svc } = build({
      openSession: openSession(ago(9 * 60 * MIN), 'site-2'),
      lastTap: loginTap(ago(9 * 60 * MIN)),
    });

    await expect(svc.previewTap('org-1', dto)).resolves.toMatchObject({ action: 'LOGOUT' });
  });

  it('says too soon inside the safety gap, and what the scan would have been', async () => {
    const { svc } = build({
      openSession: openSession(ago(3 * MIN)),
      lastTap: loginTap(ago(3 * MIN)),
    });

    const res = await svc.previewTap('org-1', dto);

    expect(res).toMatchObject({ action: 'TOO_SOON', blocked: 'LOGOUT', elapsedMinutes: 3 });
    expect((res as { remainingSeconds: number }).remainingSeconds).toBeGreaterThan(0);
  });

  it('calls a read seconds after the last one a duplicate', async () => {
    const { svc } = build({ lastTap: { clientEventTime: ago(5_000), tapType: 'LOGOUT' } });

    await expect(svc.previewTap('org-1', dto)).resolves.toMatchObject({ action: 'DUPLICATE' });
  });

  it('exempts visitors from the safety gap, as the scan does', async () => {
    const { svc } = build({
      worker: { category: 'VISITOR' },
      openSession: openSession(ago(3 * MIN)),
      lastTap: loginTap(ago(3 * MIN)),
    });

    await expect(svc.previewTap('org-1', dto)).resolves.toMatchObject({ action: 'LOGOUT' });
  });

  it('refuses a login on an expired card, but still lets its holder out', async () => {
    const arriving = build({ worker: { validityTill: '2026-01-01' } });
    await expect(arriving.svc.previewTap('org-1', dto)).resolves.toMatchObject({
      action: 'CARD_EXPIRED',
      validityTill: '2026-01-01',
    });

    const leaving = build({
      worker: { validityTill: '2026-01-01' },
      openSession: openSession(ago(8 * 60 * MIN)),
      lastTap: loginTap(ago(8 * 60 * MIN)),
    });
    await expect(leaving.svc.previewTap('org-1', dto)).resolves.toMatchObject({
      action: 'LOGOUT',
    });
  });

  it('answers UNKNOWN_WORKER for a badge nobody active holds, and records nothing', async () => {
    const { svc, db } = build({ worker: null });

    await expect(svc.previewTap('org-1', dto)).resolves.toEqual({
      action: 'UNKNOWN_WORKER',
      worker: null,
    });
    // The scan itself files an unresolved badge for reconciliation; asking
    // about one must not.
    expect(db.writes).toHaveLength(0);
  });
});
