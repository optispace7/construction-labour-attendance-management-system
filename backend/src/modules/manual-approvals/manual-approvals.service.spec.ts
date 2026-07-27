import { ManualApprovalsService } from './manual-approvals.service';

const reviewer: any = {
  userId: 'u-safety',
  organizationId: 'org-1',
  role: 'SUPERVISOR',
  siteScopes: ['site-1'],
};

const baseRequest = {
  id: 'req-1',
  organizationId: 'org-1',
  siteId: 'site-1',
  workerId: 'w1',
  tapId: 'tap-1',
  tapType: 'LOGIN' as 'LOGIN' | 'LOGOUT',
  sessionId: null as string | null,
  recordedAt: new Date('2026-06-09T02:30:00Z'),
  reason: 'Forgot card',
  status: 'PENDING',
  worker: { fullName: 'Ramesh', workerCode: 'EMP-1', category: 'WORKER' },
  site: {
    id: 'site-1',
    name: 'Tower A',
    timezone: 'Asia/Kolkata',
    settings: { defaultShiftId: null },
  },
  tap: { id: 'tap-1' },
};

function build(over: any = {}) {
  const tx: any = {
    attendanceSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'sess-new', loginAt: new Date('2026-06-09T02:30:00Z') }),
      update: jest.fn().mockResolvedValue({
        id: 'sess-1',
        logoutAt: new Date('2026-06-09T12:00:00Z'),
        workedMinutes: 570,
      }),
    },
    ...(over.tx ?? {}),
  };
  const prisma: any = {
    manualAttendanceRequest: {
      findFirst: jest.fn().mockResolvedValue(over.request ?? baseRequest),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ id: 'req-1', status: 'APPROVED' }),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const audit: any = { record: jest.fn() };
  return { svc: new ManualApprovalsService(prisma, audit), prisma, tx, audit };
}

describe('ManualApprovalsService.approve', () => {
  it('creates the session at the time the watchman recorded, not the review time', async () => {
    const { svc, tx, prisma } = build();
    await svc.approve(reviewer, 'req-1', { reviewNotes: 'Saw him on site' });

    expect(tx.attendanceSession.create).toHaveBeenCalled();
    expect(tx.attendanceSession.create.mock.calls[0][0].data).toMatchObject({
      workerId: 'w1',
      siteId: 'site-1',
      loginTapId: 'tap-1',
      loginAt: new Date('2026-06-09T02:30:00Z'),
      state: 'OPEN',
    });
    // The request points at the session it produced, so the two are traceable.
    expect(prisma.manualAttendanceRequest.update.mock.calls[0][0].data).toMatchObject({
      status: 'APPROVED',
      reviewedBy: 'u-safety',
      sessionId: 'sess-new',
    });
  });

  it('refuses a login for someone who has since scanned in properly', async () => {
    const { svc, tx } = build({
      tx: {
        attendanceSession: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'sess-real',
            loginAt: new Date('2026-06-09T03:00:00Z'),
            site: { name: 'Tower A' },
          }),
          create: jest.fn(),
          update: jest.fn(),
          findUnique: jest.fn(),
        },
      },
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.attendanceSession.create).not.toHaveBeenCalled();
  });

  it('closes the pinned session for an approved logout and scores the hours', async () => {
    const { svc, tx } = build({
      request: { ...baseRequest, tapType: 'LOGOUT', sessionId: 'sess-1' },
      tx: {
        attendanceSession: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'sess-1',
            state: 'OPEN',
            siteId: 'site-1',
            loginAt: new Date('2026-06-09T01:00:00Z'),
            shift: null,
          }),
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn().mockResolvedValue({
            id: 'sess-1',
            logoutAt: new Date('2026-06-09T02:30:00Z'),
            workedMinutes: 90,
          }),
        },
      },
    });

    await svc.approve(reviewer, 'req-1', {});

    const patch = tx.attendanceSession.update.mock.calls[0][0].data;
    expect(patch).toMatchObject({
      logoutTapId: 'tap-1',
      logoutAt: new Date('2026-06-09T02:30:00Z'),
      state: 'CLOSED',
      closedReason: 'MANUAL_APPROVED',
      workedMinutes: 90,
    });
  });

  it('refuses a logout whose session was already closed by a real scan', async () => {
    const { svc, tx } = build({
      request: { ...baseRequest, tapType: 'LOGOUT', sessionId: 'sess-1' },
      tx: {
        attendanceSession: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'sess-1',
            state: 'CLOSED',
            siteId: 'site-1',
            loginAt: new Date('2026-06-09T01:00:00Z'),
            logoutAt: new Date('2026-06-09T02:00:00Z'),
            shift: null,
          }),
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
      },
    });

    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(tx.attendanceSession.update).not.toHaveBeenCalled();
  });

  it('will not review an entry that was already decided', async () => {
    const { svc } = build({ request: { ...baseRequest, status: 'REJECTED' } });
    await expect(svc.approve(reviewer, 'req-1', {})).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
    });
  });
});

describe('ManualApprovalsService.reject', () => {
  it('leaves attendance untouched and records who declined it', async () => {
    const { svc, prisma, tx, audit } = build();
    await svc.reject(reviewer, 'req-1', { reviewNotes: 'Not on site' });

    expect(tx.attendanceSession.create).not.toHaveBeenCalled();
    expect(tx.attendanceSession.update).not.toHaveBeenCalled();
    expect(prisma.manualAttendanceRequest.update.mock.calls[0][0].data).toMatchObject({
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
    const { svc, prisma } = build();
    await svc.list(reviewer);

    expect(prisma.manualAttendanceRequest.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      status: 'PENDING',
      siteId: { in: ['site-1'] },
    });
  });

  it('leaves a Super Admin unscoped', async () => {
    const { svc, prisma } = build();
    await svc.list({ ...reviewer, role: 'SUPER_ADMIN' });

    expect(prisma.manualAttendanceRequest.findMany.mock.calls[0][0].where.siteId).toBeUndefined();
  });
});
