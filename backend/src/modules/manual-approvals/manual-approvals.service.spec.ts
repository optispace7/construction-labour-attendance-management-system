import { ManualApprovalsService } from './manual-approvals.service';
import { drizzleDouble } from '../../../test/drizzle-double';
import {
  attendanceSessions,
  attendanceTaps,
  manualAttendanceRequests,
  siteSettings,
  users,
} from '../../infra/d1/schema.generated';

const reviewer: any = {
  userId: 'u-safety',
  organizationId: 'org-1',
  role: 'SUPERVISOR',
  siteScopes: ['site-1'],
};

/** A request as the review join returns it: one flat row. */
const baseRequest = {
  id: 'req-1',
  siteId: 'site-1',
  workerId: 'w1',
  tapType: 'LOGIN' as 'LOGIN' | 'LOGOUT',
  sessionId: null as string | null,
  recordedAt: new Date('2026-06-09T02:30:00Z'),
  reason: 'Forgot card',
  status: 'PENDING',
  reviewedBy: null,
  reviewedAt: null,
  reviewNotes: null,
  createdAt: new Date('2026-06-09T02:30:00Z'),
  workerFullName: 'Ramesh',
  workerCode: 'EMP-1',
  workerPhotoUrl: null,
  workerCategory: 'WORKER',
  designationName: null,
  vendorName: null,
  siteName: 'Tower A',
  siteTimezone: 'Asia/Kolkata',
  tapRowId: 'tap-1',
  tapDeviceId: 'dev-1',
  tapLatitude: null,
  tapLongitude: null,
};

/**
 * The service against a Drizzle double.
 *
 * `openSession` is what a LOGIN approval finds in the way; `session` is what a
 * LOGOUT approval is filed against. Both are reads of the sessions table, and
 * only one branch runs per call, so one entry serves both.
 */
function build(
  over: {
    request?: Record<string, unknown>;
    session?: unknown;
    tap?: unknown;
    sessionClosedByRace?: boolean;
  } = {},
) {
  const db = drizzleDouble(
    [
      [manualAttendanceRequests, [{ ...baseRequest, ...(over.request ?? {}) }]],
      [siteSettings, [{ defaultShiftId: null }]],
      [attendanceSessions, over.session ? [over.session] : []],
      [
        attendanceTaps,
        [over.tap ?? { tapSource: 'QR', isManualBackup: false }],
      ],
      [users, []],
    ],
    {
      onWrite: () => [],
    },
  );
  // A concurrent scan closing the session shows up as the guarded update
  // matching nothing.
  if (over.sessionClosedByRace) {
    db.db.batch = jest.fn(() => Promise.resolve([{ meta: { changes: 0 } }, { meta: { changes: 1 } }])) as any;
  }
  const audit: any = { record: jest.fn() };
  return { svc: new ManualApprovalsService({ db: db.db } as any, audit), db, audit };
}

type Db = ReturnType<typeof build>['db'];
const wroteTo = (db: Db, table: unknown, kind: 'insert' | 'update' | 'delete') =>
  db.writes.some((w) => w.kind === kind && w.table === table);

describe('ManualApprovalsService.approve', () => {
  it('creates the session at the time the watchman recorded, not the review time', async () => {
    const { db, svc } = build();
    await svc.approve(reviewer, 'req-1', { reviewNotes: 'Saw him on site' });

    const session = db.writes.find(
      (w) => w.kind === 'insert' && w.table === attendanceSessions,
    )?.values as any;
    expect(session).toMatchObject({
      workerId: 'w1',
      siteId: 'site-1',
      loginTapId: 'tap-1',
      loginAt: new Date('2026-06-09T02:30:00Z'),
      state: 'OPEN',
    });
    // The request points at the session it produced, so the two are traceable.
    const request = db.writes.find(
      (w) => w.kind === 'update' && w.table === manualAttendanceRequests,
    )?.values as any;
    expect(request).toMatchObject({
      status: 'APPROVED',
      reviewedBy: 'u-safety',
      sessionId: session.id,
    });
  });

  it('refuses a login for someone who has since scanned in properly', async () => {
    const { db, svc } = build({
      session: {
        id: 'sess-real',
        loginAt: new Date('2026-06-09T03:00:00Z'),
        loginTapId: 'tap-real',
        siteName: 'Tower A',
      },
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(wroteTo(db, attendanceSessions, 'insert')).toBe(false);
  });

  it('names the badge and the site-local time when a scan logged them in first', async () => {
    const { svc } = build({
      session: {
        id: 'sess-real',
        loginAt: new Date('2026-06-09T03:00:00Z'), // 08:30 IST
        loginTapId: 'tap-real',
        siteName: 'Tower A',
      },
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: expect.stringContaining('A QR badge scan logged them in at 9 Jun 2026, 8:30 AM'),
    });
  });

  it('closes the pinned session for an approved logout and scores the hours', async () => {
    const { db, svc } = build({
      request: { tapType: 'LOGOUT', sessionId: 'sess-1' },
      session: {
        session: {
          id: 'sess-1',
          state: 'OPEN',
          siteId: 'site-1',
          loginAt: new Date('2026-06-09T01:00:00Z'),
        },
        shift: null,
      },
    });

    await svc.approve(reviewer, 'req-1', {});

    const patch = db.writes.find(
      (w) => w.kind === 'update' && w.table === attendanceSessions,
    )?.values as any;
    expect(patch).toMatchObject({
      logoutTapId: 'tap-1',
      logoutAt: new Date('2026-06-09T02:30:00Z'),
      state: 'CLOSED',
      closedReason: 'MANUAL_APPROVED',
      workedMinutes: 90,
    });
  });

  it('refuses a logout whose session was already closed by a real scan', async () => {
    const { db, svc } = build({
      request: { tapType: 'LOGOUT', sessionId: 'sess-1' },
      session: {
        session: {
          id: 'sess-1',
          state: 'CLOSED',
          siteId: 'site-1',
          loginAt: new Date('2026-06-09T01:00:00Z'),
          logoutAt: new Date('2026-06-09T02:00:00Z'),
          logoutTapId: 'tap-real',
          closedReason: null,
        },
        shift: null,
      },
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(wroteTo(db, attendanceSessions, 'update')).toBe(false);
  });

  it('tells the reviewer it was a QR scan, when, and how long after they typed it', async () => {
    // Typed at 08:00 IST; the badge scanned out 29 seconds later, which is
    // exactly how the Brigade WTC entry got stuck on 5 Aug 2026.
    const { svc } = build({
      request: { tapType: 'LOGOUT', sessionId: 'sess-1' },
      session: {
        session: {
          id: 'sess-1',
          state: 'CLOSED',
          siteId: 'site-1',
          loginAt: new Date('2026-06-09T01:00:00Z'),
          logoutAt: new Date('2026-06-09T02:30:29Z'),
          logoutTapId: 'tap-real',
          closedReason: null,
        },
        shift: null,
      },
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: expect.stringContaining(
        'already been logged out at 9 Jun 2026, 8:00 AM by a QR badge scan, ' +
          '29 seconds after this entry was typed',
      ),
    });
  });

  it('says so plainly when an office screen closed the session, not a badge', async () => {
    const { svc } = build({
      request: { tapType: 'LOGOUT', sessionId: 'sess-1' },
      session: {
        session: {
          id: 'sess-1',
          state: 'CLOSED',
          siteId: 'site-1',
          loginAt: new Date('2026-06-09T01:00:00Z'),
          logoutAt: new Date('2026-06-09T04:00:00Z'),
          logoutTapId: null,
          closedReason: 'ADMIN_BULK_LOGOUT',
        },
        shift: null,
      },
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: expect.stringContaining('by a bulk logout in Fix attendance'),
    });
  });

  // D1 has no interactive transaction, so the close is guarded on the session
  // still being OPEN. A scan that closed it in between makes the write match
  // nothing, and the reviewer is told rather than the real logout overwritten.
  it('refuses when a scan closes the session while the approval is in flight', async () => {
    const { svc } = build({
      request: { tapType: 'LOGOUT', sessionId: 'sess-1' },
      session: {
        session: {
          id: 'sess-1',
          state: 'OPEN',
          siteId: 'site-1',
          loginAt: new Date('2026-06-09T01:00:00Z'),
        },
        shift: null,
      },
      sessionClosedByRace: true,
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: expect.stringContaining('was logged out while this entry was being accepted'),
    });
  });

  it('will not review an entry that was already decided', async () => {
    const { svc } = build({ request: { status: 'REJECTED' } });
    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
    });
  });
});

describe('ManualApprovalsService.reject', () => {
  it('leaves attendance untouched and records who declined it', async () => {
    const { db, svc, audit } = build();
    await svc.reject(reviewer, 'req-1', { reviewNotes: 'Not on site' });

    expect(db.writes.some((w) => w.table === attendanceSessions)).toBe(false);
    expect(db.wrote(manualAttendanceRequests)).toMatchObject({
      status: 'REJECTED',
      reviewedBy: 'u-safety',
      reviewNotes: 'Not on site',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MANUAL_ATTENDANCE_REJECT' }),
    );
  });
});

describe('ManualApprovalsService.list', () => {
  it('scopes a Safety Officer to their own sites and defaults to what is pending', async () => {
    const { db, svc } = build();
    await svc.list(reviewer);

    const bound = db.boundValues();
    expect(bound).toContain('org-1');
    expect(bound).toContain('PENDING');
    expect(bound).toContain('site-1');
  });

  it('leaves a Super Admin unscoped', async () => {
    const { db, svc } = build();
    await svc.list({ ...reviewer, role: 'SUPER_ADMIN' });

    expect(db.boundValues()).not.toContain('site-1');
  });
});
