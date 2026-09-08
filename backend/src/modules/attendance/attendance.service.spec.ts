import { AttendanceService } from './attendance.service';
import { TapSource } from '../../common/enums';
import { AppException } from '../../common/errors/app.exception';
import { drizzleDouble } from '../../../test/drizzle-double';
import {
  attendanceSessions,
  attendanceTaps,
  manualAttendanceRequests,
  organizations,
  sites,
  workers,
} from '../../infra/d1/schema.generated';

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
  workerCode: 'W-0001',
  category: 'WORKER',
  photoUrl: null,
  bloodGroup: 'B+',
  emergencyContactName: 'S',
  emergencyContactNumber: '9',
  deletedAt: null,
  // A date-only column: 'YYYY-MM-DD' text, as SQLite stores it.
  validityTill: null as string | null,
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
  updatedAt: new Date(),
};

const baseSite = { id: 'site-1', timezone: 'Asia/Kolkata', latitude: null, longitude: null };

/**
 * An open session, in both the shapes it is read in.
 *
 * The tap decision reads it as a plain row; the logout path reads it joined to
 * its shift. One object carries both, so a fixture reads as "there is an open
 * session" rather than as two mocks that have to agree with each other.
 */
function openSessionRow(over: Partial<{ loginAt: Date; workDate: string }> = {}) {
  const session = {
    id: 'sess-1',
    workerId: 'w1',
    siteId: 'site-1',
    state: 'OPEN',
    loginAt: over.loginAt ?? new Date('2026-06-09T02:30:00Z'),
    workDate: over.workDate ?? '2026-06-09',
  };
  return { ...session, session, shift: null };
}

/**
 * The service against a Drizzle double.
 *
 * Each option names a row the database holds, not a query — the tap path reads
 * the taps table twice for different reasons, and the double is told which read
 * is which rather than the test having to count calls.
 */
function buildService(
  o: {
    worker?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    replayTap?: unknown;
    lastTap?: unknown;
    openSession?: unknown;
    pendingManual?: unknown;
    logoutResult?: Record<string, unknown>;
  } = {},
) {
  const db = drizzleDouble(
    [
      [sites, [{ site: baseSite, settings: { ...baseSettings, ...(o.settings ?? {}) } }]],
      [
        workers,
        [
          {
            worker: { ...baseWorker, ...(o.worker ?? {}) },
            vendorName: null,
            designationName: null,
          },
        ],
      ],
      // Read 0 is the replay check; read 1 is the worker's last tap.
      [
        attendanceTaps,
        (n) =>
          n === 0 ? (o.replayTap ? [o.replayTap] : []) : o.lastTap ? [o.lastTap] : [],
      ],
      [attendanceSessions, o.openSession ? [o.openSession] : []],
      [manualAttendanceRequests, o.pendingManual ? [o.pendingManual] : []],
    ],
    {
      onWrite: (kind, table) => {
        if (table === attendanceTaps) return [{ id: 'tap-1' }];
        if (table === attendanceSessions) {
          return [
            {
              id: 'sess-1',
              loginAt: new Date('2026-06-09T02:30:00Z'),
              logoutAt: new Date('2026-06-09T11:30:00Z'),
              workedMinutes: 540,
              overtimeMinutes: 0,
              ...(o.logoutResult ?? {}),
            },
          ];
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
    notifications,
  };
}

type Db = ReturnType<typeof buildService>['db'];
const inserted = (db: Db, table: unknown) =>
  db.writes.some((w) => w.kind === 'insert' && w.table === table);
const updated = (db: Db, table: unknown) =>
  db.writes.some((w) => w.kind === 'update' && w.table === table);

describe('AttendanceService.handleTap', () => {
  it('returns IDEMPOTENT_REPLAY for an already-seen eventId', async () => {
    const { svc } = buildService({ replayTap: { id: 'tap-x', eventId: 'e', tapType: 'LOGIN' } });
    const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' });
    expect(res.result).toBe('IDEMPOTENT_REPLAY');
  });

  // A typed-in worker code has no badge behind it, so it files a request and
  // leaves attendance alone until a Safety Officer accepts it.
  it('holds a hand-typed LOGIN for review instead of opening a session', async () => {
    const { svc, db, notifications } = buildService({});
    const res = await svc.handleTap(
      'org-1',
      makeDto({ source: TapSource.MANUAL, manual: { isBackup: true, reason: 'Forgot card' } }),
      { deviceId: 'dev-1', photoRoll: 99 },
    );

    expect(res.result).toBe('MANUAL_PENDING_APPROVAL');
    expect(inserted(db, attendanceSessions)).toBe(false);
    // The tap is still written — it is the evidence that someone typed it in.
    expect(inserted(db, attendanceTaps)).toBe(true);
    expect(db.wrote(manualAttendanceRequests)).toMatchObject({
      tapType: 'LOGIN',
      reason: 'Forgot card',
      sessionId: null,
    });
    expect(notifications.create).toHaveBeenCalled();
  });

  it('holds a hand-typed LOGOUT for review and leaves the session open', async () => {
    const { svc, db } = buildService({
      openSession: openSessionRow({ loginAt: new Date('2026-06-09T01:00:00Z') }),
    });
    const res = await svc.handleTap(
      'org-1',
      makeDto({ source: TapSource.MANUAL, manual: { isBackup: true, reason: 'Lost card' } }),
      { deviceId: 'dev-1' },
    );

    expect(res.result).toBe('MANUAL_PENDING_APPROVAL');
    expect(updated(db, attendanceSessions)).toBe(false);
    // The logout pins the session it means to close, so approval cannot land on
    // a different one later.
    expect(db.wrote(manualAttendanceRequests)).toMatchObject({
      tapType: 'LOGOUT',
      sessionId: 'sess-1',
    });
  });

  it('refuses a second hand-typed punch while one is still waiting', async () => {
    const { svc, db } = buildService({
      pendingManual: { tapType: 'LOGIN', createdAt: new Date('2026-06-09T02:00:00Z') },
    });

    await expect(
      svc.handleTap('org-1', makeDto({ source: TapSource.MANUAL, manual: { isBackup: true } }), {
        deviceId: 'dev-1',
      }),
    ).rejects.toMatchObject({ code: 'MANUAL_REVIEW_PENDING' });
    // Nothing is written — the watchman is told at the gate.
    expect(db.writes).toHaveLength(0);
  });

  it('still refuses a hand-typed login on an expired card', async () => {
    const { svc, db } = buildService({ worker: { validityTill: '2026-06-01' } });

    await expect(
      svc.handleTap('org-1', makeDto({ source: TapSource.MANUAL, manual: { isBackup: true } }), {
        deviceId: 'dev-1',
      }),
    ).rejects.toMatchObject({ code: 'CARD_EXPIRED' });
    expect(inserted(db, manualAttendanceRequests)).toBe(false);
  });

  it('records a LOGIN in AUTO mode (creates an open session)', async () => {
    const { svc, db } = buildService({});
    const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1', photoRoll: 99 });
    expect(res.result).toBe('LOGIN_RECORDED');
    expect(inserted(db, attendanceSessions)).toBe(true);
  });

  describe('expired ID card', () => {
    // Tap is 09-Jun-2026 08:00 IST; the card lapsed at the end of 08-Jun.
    const expired = { validityTill: '2026-06-08' };

    it('refuses the LOGIN and records no tap at all', async () => {
      const { svc, db } = buildService({ worker: expired });

      await expect(svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' })).rejects.toBeInstanceOf(
        AppException,
      );
      expect(db.writes).toHaveLength(0);
    });

    it('names the worker and the expiry date so the gate can act on it', async () => {
      const { svc } = buildService({ worker: expired });
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
      const { svc } = buildService({ worker: expired, openSession: openSessionRow() });
      const res = await svc.handleTap(
        'org-1',
        makeDto({ clientEventTime: '2026-06-09T11:30:00Z' }),
        { deviceId: 'dev-1' },
      );
      expect(res.result).toBe('LOGOUT_RECORDED');
    });

    it('lets a card valid through today log in', async () => {
      const { svc, db } = buildService({ worker: { validityTill: '2026-06-09' } });
      const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1', photoRoll: 99 });
      expect(res.result).toBe('LOGIN_RECORDED');
      expect(inserted(db, attendanceSessions)).toBe(true);
    });
  });

  it('records a LOGOUT when an open session exists', async () => {
    const { svc } = buildService({ openSession: openSessionRow() });
    const res = await svc.handleTap('org-1', makeDto({ clientEventTime: '2026-06-09T11:30:00Z' }), {
      deviceId: 'dev-1',
    });
    expect(res.result).toBe('LOGOUT_RECORDED');
    expect((res as any).workedMinutes).toBe(540);
  });

  it('rejects a duplicate tap inside the cooldown window', async () => {
    const { svc } = buildService({
      lastTap: { clientEventTime: new Date('2026-06-09T02:30:00Z'), tapType: 'LOGIN' },
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

  /** Today's business day as the service computes it, in stored 'YYYY-MM-DD'. */
  const todayText = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const dayBefore = (d: string) =>
    new Date(new Date(`${d}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

  /**
   * The sessions table is read three times in order: open sessions, missed
   * logouts, then the today+yesterday window gate movement is tallied from.
   */
  function buildStats(windowRows: any[], workforceGroups: any[], openRows: any[] = []) {
    const db = drizzleDouble([
      [organizations, [{ timezone: 'Asia/Kolkata' }]],
      [attendanceSessions, (n) => (n === 0 ? openRows : n === 1 ? [] : windowRows)],
      [workers, workforceGroups],
    ]);
    return new AttendanceService({ db: db.db } as any, {} as any, {} as any, {} as any);
  }

  it('counts people rather than sessions, so a worker who re-enters counts once', async () => {
    // Ramesh has two sessions today — he stepped out and came back.
    const today = todayText();
    const svc = buildStats(
      [
        { workerId: 'w1', workDate: today, state: 'CLOSED', lateMinutes: 0, category: 'WORKER' },
        { workerId: 'w1', workDate: today, state: 'OPEN', lateMinutes: 0, category: 'WORKER' },
        { workerId: 'w2', workDate: today, state: 'CLOSED', lateMinutes: 15, category: 'WORKER' },
      ],
      [{ category: 'WORKER', count: 10 }],
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
        { category: 'WORKER', count: 120 },
        { category: 'STAFF', count: 8 },
      ],
    );

    const res = await svc.dashboardStats(user);

    expect(res.workforce.total).toBe(128);
    expect(res.workforce.byCategory).toMatchObject({ WORKER: 120, STAFF: 8, VISITOR: 0 });
  });

  // The reason "on site" read 6 on one screen and 2 on another: four sessions
  // from the previous day were never scanned out.
  it('splits people on site into today and carried over from earlier days', async () => {
    const today = todayText();
    const yesterday = dayBefore(today);
    const person = (name: string, workDate: string) => ({
      loginAt: new Date(`${workDate}T02:30:00.000Z`),
      workDate,
      fullName: name,
      workerCode: name,
      category: 'WORKER',
      siteName: 'Tower A',
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
    const today = todayText();
    const svc = buildStats(
      [],
      [],
      [
        {
          loginAt: new Date(`${today}T02:30:00.000Z`),
          workDate: today,
          fullName: 'Ramesh',
          workerCode: 'W1',
          category: 'WORKER',
          siteName: 'Tower A',
        },
      ],
    );

    const res = await svc.dashboardStats(user);
    expect(res.onSiteNow.today).toBe(1);
    expect(res.onSiteNow.carriedOver).toBe(0);
  });

  it('keeps yesterday separate from today so a card can show a real change', async () => {
    const today = todayText();
    const yesterday = dayBefore(today);
    const svc = buildStats(
      [
        { workerId: 'w1', workDate: today, state: 'OPEN', lateMinutes: 0, category: 'WORKER' },
        {
          workerId: 'w2',
          workDate: yesterday,
          state: 'CLOSED',
          lateMinutes: 0,
          category: 'WORKER',
        },
        {
          workerId: 'w3',
          workDate: yesterday,
          state: 'CLOSED',
          lateMinutes: 0,
          category: 'WORKER',
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
    const closed = (id: string, workerId: string, name: string, logoutAt: string) => ({
      id,
      loginAt: new Date('2026-07-14T02:30:00Z'),
      logoutAt: new Date(logoutAt),
      workedMinutes: 120,
      workerId,
      fullName: name,
      workerCode: name,
      category: 'WORKER',
      designationName: null,
      vendorName: null,
      siteId: 'site-1',
      siteName: 'Site 1',
    });
    // Newest logout first, which is the order the query returns them in.
    const closedRows = [
      closed('closed-w2-latest', 'w2', 'Suresh', '2026-07-14T11:30:00Z'),
      closed('closed-w1', 'w1', 'Ramesh', '2026-07-14T04:30:00Z'),
      closed('closed-w2-earlier', 'w2', 'Suresh', '2026-07-14T02:00:00Z'),
    ];

    const db = drizzleDouble([
      [organizations, [{ timezone: 'Asia/Kolkata' }]],
      // Read 0 is who is still on site; read 1 is the day's closed rows.
      [attendanceSessions, (n) => (n === 0 ? [{ workerId: 'w1' }] : closedRows)],
    ]);
    const svc = new AttendanceService({ db: db.db } as any, {} as any, {} as any, {} as any);

    const rows = await svc.loggedOutToday(user, 'all', undefined, '2026-07-14');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('closed-w2-latest');
    // Both reads stay inside the user's own sites.
    expect(db.boundValues()).toContain('site-1');
  });
});

describe('AttendanceService.workerTapState', () => {
  it('reports the open session a *different* device opened, so this one scans OUT', async () => {
    const { svc } = buildService({
      openSession: {
        id: 'sess-9',
        loginAt: new Date('2026-07-22T02:30:00Z'),
        siteId: 'site-1',
      },
      replayTap: { clientEventTime: new Date('2026-07-22T02:30:00Z') },
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
  function buildGapped(over: Parameters<typeof buildService>[0] = {}) {
    return buildService({
      settings: { safetyGapMinutes: 10 },
      openSession: openSessionRow({ loginAt: new Date('2026-06-09T02:29:00Z') }),
      lastTap: { clientEventTime: new Date('2026-06-09T02:29:00Z'), tapType: 'LOGIN' },
      logoutResult: { workedMinutes: 1 },
      ...over,
    });
  }

  it('refuses to close a session opened a minute ago, and records no tap', async () => {
    const { svc, db } = buildGapped();

    await expect(svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' })).rejects.toMatchObject({
      code: 'TAP_TOO_SOON',
    });
    expect(db.writes).toHaveLength(0);
  });

  it('exempts visitors — a ten-minute site visit is a normal visit', async () => {
    const { svc, db } = buildGapped({ worker: { category: 'VISITOR' } });

    const res = await svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' });

    expect(res.result).toBe('LOGOUT_RECORDED');
    expect(updated(db, attendanceSessions)).toBe(true);
  });

  it('lets the watchman record it anyway, and keeps his reason', async () => {
    const { svc, db, audit } = buildGapped();

    const res = await svc.handleTap('org-1', makeDto({ override: { reason: 'Sent home sick' } }), {
      deviceId: 'dev-1',
    });

    expect(res.result).toBe('LOGOUT_RECORDED');
    expect(updated(db, attendanceSessions)).toBe(true);
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
    const { svc, db } = buildGapped({
      lastTap: { clientEventTime: new Date('2026-06-09T02:29:50Z'), tapType: 'LOGIN' },
    });

    // This fixture has the worker already on site, so the scan closes the
    // session rather than opening one — the point is that it went through.
    const res = await svc.handleTap('org-1', makeDto({ override: {} }), {
      deviceId: 'dev-1',
      photoRoll: 99,
    });

    expect(res.result).toBe('LOGOUT_RECORDED');
    expect(inserted(db, attendanceTaps)).toBe(true);
  });

  it('still refuses a duplicate when nobody overrode it', async () => {
    const { svc } = buildGapped({
      lastTap: { clientEventTime: new Date('2026-06-09T02:29:50Z'), tapType: 'LOGIN' },
    });

    await expect(svc.handleTap('org-1', makeDto(), { deviceId: 'dev-1' })).rejects.toMatchObject({
      code: 'DUPLICATE_TAP',
    });
  });

  // The prompt for a written reason was removed: watchmen were being asked to
  // justify a decision they had no vocabulary for. The override still audits.
  it('accepts an override with no reason attached', async () => {
    const { svc, audit } = buildGapped();

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
