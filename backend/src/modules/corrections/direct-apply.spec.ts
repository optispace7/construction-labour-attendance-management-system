import { CorrectionsService } from './corrections.service';

/**
 * Corrections filed by someone the Super Admin has cleared to apply their own.
 *
 * The behaviour that matters: the request still exists, still carries its
 * reason and its author, and still goes through the one apply path — it just
 * does not wait for a second person. And an officer without the grant must be
 * exactly as blocked as before.
 */

const officer: any = {
  userId: 'u-officer',
  organizationId: 'org1',
  role: 'SUPERVISOR',
  siteScopes: [],
};

const workDate = new Date(Date.UTC(2026, 5, 8));

const dto: any = {
  workerId: 'w1',
  siteId: 'site1',
  workDate: '2026-06-08',
  type: 'LOGOUT',
  reason: 'FORGOT_CARD',
  notes: 'Gate tablet was flat; he left at 18:30.',
  items: [{ field: 'logout_at', proposedValue: '2026-06-08T13:00:00Z' }],
};

/** A session the correction can land on, plus the tx doubles around it. */
function harness(canApplyCorrections: boolean) {
  const session = {
    id: 's1',
    updatedAt: new Date('2026-06-08T06:00:00Z'),
    loginAt: new Date('2026-06-08T03:30:00Z'), // 09:00 IST
    logoutAt: null,
    siteId: 'site1',
    shiftId: null,
    workDate,
    shift: null,
    site: { timezone: 'Asia/Kolkata' },
  };

  const tx: any = {
    correctionRequest: {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'c1',
        status: 'PENDING',
        organizationId: 'org1',
        workerId: 'w1',
        siteId: 'site1',
        sessionId: null,
        workDate,
        createdAt: new Date('2026-06-08T14:00:00Z'),
        items: dto.items,
      }),
      update: jest
        .fn()
        .mockImplementation(({ data }: any) => ({ id: 'c1', status: 'APPROVED', ...data })),
    },
    site: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
    },
    attendanceSession: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(session),
      create: jest.fn(),
      update: jest
        .fn()
        .mockResolvedValue({ ...session, logoutAt: new Date('2026-06-08T13:00:00Z') }),
    },
  };

  const prisma: any = {
    user: { findFirst: jest.fn().mockResolvedValue({ canApplyCorrections }) },
    correctionRequest: {
      create: jest.fn().mockResolvedValue({ id: 'c1', status: 'PENDING', items: dto.items }),
    },
    $transaction: (fn: any) => fn(tx),
  };
  const audit: any = { record: jest.fn() };
  return { svc: new CorrectionsService(prisma, audit), prisma, tx, audit };
}

describe('CorrectionsService.create (direct apply)', () => {
  it('applies the correction on the spot when the author is cleared for it', async () => {
    const { svc, tx } = harness(true);

    const res: any = await svc.create(officer, dto);

    expect(res.status).toBe('APPROVED');
    expect(res.autoApplied).toBe(true);
    // The attendance row actually changed — not merely a request marked approved.
    expect(tx.attendanceSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: expect.objectContaining({ logoutAt: new Date('2026-06-08T13:00:00Z') }),
      }),
    );
    // Signed off by its own author, so the history says who did it.
    expect(tx.correctionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reviewedBy: 'u-officer', autoApplied: true }),
      }),
    );
  });

  it('records the bypass under its own audit action', async () => {
    const { svc, audit } = harness(true);

    await svc.create(officer, dto);

    const actions = audit.record.mock.calls.map((c: any[]) => c[0].action);
    // Both halves are still on the record: it was filed, and it was applied
    // without review — the second under a name a reader can search for.
    expect(actions).toContain('CORRECTION_REQUEST');
    expect(actions).toContain('CORRECTION_AUTO_APPLY');
    expect(actions).not.toContain('CORRECTION_APPROVE');
  });

  it('still queues the correction when the author is not cleared', async () => {
    const { svc, prisma, tx } = harness(false);

    const res: any = await svc.create(officer, dto);

    expect(res.status).toBe('PENDING');
    expect(prisma.correctionRequest.create).toHaveBeenCalled();
    // Nothing was applied: attendance is untouched until somebody approves.
    expect(tx.attendanceSession.update).not.toHaveBeenCalled();
  });

  it("reads the grant from the user row, not from the caller's token", async () => {
    const { svc, prisma } = harness(true);

    await svc.create(officer, dto);

    // Revoking the flag has to bite immediately, so it is looked up per call —
    // and only for the live account in the caller's own organization.
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-officer', organizationId: 'org1', deletedAt: null },
      }),
    );
  });

  /**
   * Both ends of a night shift, filed as one request.
   *
   * The mobile and web forms now send `login_at` and `logout_at` together, with
   * the logout dated to the following morning when the shift crosses midnight.
   * The pair has to apply as one operation, and the day has to be the day they
   * came in — filing it under the morning they walked out is the mistake this
   * whole area keeps making.
   */
  it('applies both stamps of an overnight shift and files it under the day they came in', async () => {
    const overnight: any = {
      ...dto,
      type: 'MISSING',
      workDate: '2026-08-08',
      items: [
        // 21:30 IST on the 8th…
        { field: 'login_at', proposedValue: '2026-08-08T16:00:00.000Z' },
        // …out at 08:00 IST on the 9th.
        { field: 'logout_at', proposedValue: '2026-08-09T02:30:00.000Z' },
      ],
    };

    const created: any[] = [];
    const tx: any = {
      correctionRequest: {
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          status: 'PENDING',
          organizationId: 'org1',
          workerId: 'w1',
          siteId: 'site1',
          sessionId: null,
          workDate: new Date(Date.UTC(2026, 7, 8)),
          createdAt: new Date('2026-08-09T04:00:00Z'),
          items: overnight.items,
        }),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ id: 'c1', status: 'APPROVED', ...data })),
      },
      site: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'site1', timezone: 'Asia/Kolkata', settings: null }),
      },
      attendanceSession: {
        findUnique: jest.fn(),
        // Never scanned, so there is nothing to patch — the pair has to make it.
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const row = { id: 'sNew', ...data, shift: null, site: { timezone: 'Asia/Kolkata' } };
          created.push(row);
          return row;
        }),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({
          ...created[0],
          ...data,
          shift: null,
          site: { timezone: 'Asia/Kolkata' },
        })),
      },
    };
    const prisma: any = {
      user: { findFirst: jest.fn().mockResolvedValue({ canApplyCorrections: true }) },
      correctionRequest: { create: jest.fn() },
      $transaction: (fn: any) => fn(tx),
    };
    const svc = new CorrectionsService(prisma, { record: jest.fn() } as any);

    const res: any = await svc.create(officer, overnight);

    expect(res.autoApplied).toBe(true);
    // One session, carrying both stamps, closed because the logout is known.
    expect(created).toHaveLength(1);
    expect(created[0].loginAt).toEqual(new Date('2026-08-08T16:00:00.000Z'));
    expect(created[0].logoutAt).toEqual(new Date('2026-08-09T02:30:00.000Z'));
    expect(created[0].state).toBe('CLOSED');
    // The 8th — the shift belongs to the night it started, not to the morning
    // the logout happens to fall in.
    expect(created[0].workDate).toEqual(new Date(Date.UTC(2026, 7, 8)));
    // 21:30 → 08:00 is ten and a half hours across midnight.
    expect(tx.attendanceSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ workedMinutes: 630 }) }),
    );
  });

  it('still refuses a backwards pair from someone cleared to apply their own', async () => {
    const { svc, tx } = harness(true);
    // Both stamps on the same day, with the logout earlier than the login —
    // what an un-ticked "went out the next day" would produce. The grant skips
    // the review, never the sanity check.
    tx.correctionRequest.findFirst.mockResolvedValue({
      id: 'c1',
      status: 'PENDING',
      organizationId: 'org1',
      workerId: 'w1',
      siteId: 'site1',
      sessionId: null,
      workDate,
      createdAt: new Date('2026-06-08T14:00:00Z'),
      items: [
        { field: 'login_at', proposedValue: '2026-06-08T16:00:00.000Z' }, // 21:30 IST
        { field: 'logout_at', proposedValue: '2026-06-08T02:30:00.000Z' }, // 08:00 IST, same day
      ],
    });

    await expect(svc.create(officer, dto)).rejects.toMatchObject({ code: 'BUSINESS_RULE' });
    expect(tx.correctionRequest.update).not.toHaveBeenCalled();
  });

  it('leaves no request behind when applying it fails', async () => {
    const { svc, tx } = harness(true);
    // The session the correction names has since been deleted.
    tx.attendanceSession.findFirst.mockResolvedValue(null);
    // ...and a logout-only correction cannot invent one.

    await expect(svc.create(officer, dto)).rejects.toMatchObject({ code: 'CONFLICT' });

    // The create and the apply share a transaction, so a failed apply rolls the
    // request back rather than parking it in a queue nobody is watching.
    expect(tx.correctionRequest.update).not.toHaveBeenCalled();
  });
});
