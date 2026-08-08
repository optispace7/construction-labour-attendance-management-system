import { ReportsService } from './reports.service';
import { ReportType } from './dto/report.dto';
import { Cell, cellText, isNightTime } from './report.builder';
import { AuthUser } from '../../common/auth/auth-user.interface';

/**
 * Attendance-sheet shape: one block per shift of the day. Driven through the
 * public preview() so the flat (CSV/PDF/preview) representation is what gets
 * asserted — that is what the admin actually reads.
 */
describe('ReportsService — attendance sheet shifts', () => {
  const user = {
    userId: 'u1',
    organizationId: 'org1',
    role: 'SUPER_ADMIN',
    siteScopes: [],
  } as unknown as AuthUser;

  const worker = (id: string, fullName: string, workerCode: string) => ({
    id,
    fullName,
    workerCode,
    fatherName: null,
    natureOfContractor: null,
    dateOfBirth: null,
    joinDate: null,
    exitDate: null,
    gender: null,
    mobileNumber: null,
    vendor: null,
  });

  const DAY = new Date(Date.UTC(2026, 6, 11));
  /** A shift on 11 Jul 2026, given in whole UTC hours. */
  const shift = (id: string, workerId: string, fromHour: number, toHour: number) => ({
    id,
    workerId,
    workDate: DAY,
    loginAt: new Date(Date.UTC(2026, 6, 11, fromHour)),
    logoutAt: new Date(Date.UTC(2026, 6, 11, toHour)),
    workedMinutes: (toHour - fromHour) * 60,
    overtimeMinutes: 0,
  });

  const build = (workers: unknown[], sessions: unknown[]) => {
    const prisma = {
      organization: { findUnique: jest.fn().mockResolvedValue({ timezone: 'UTC' }) },
      worker: { findMany: jest.fn().mockResolvedValue(workers) },
      attendanceSession: { findMany: jest.fn().mockResolvedValue(sessions) },
    };
    const crypto = { decrypt: jest.fn() };
    const audit = { record: jest.fn() };
    return new ReportsService(prisma as never, crypto as never, audit as never);
  };

  const params = { from: '2026-07-11', to: '2026-07-11' };
  /**
   * Strip the info columns — the assertions are about the IN/Out pair. An out
   * time on the following morning arrives as a value carrying its own day, so
   * it is flattened to text here the way a colourless format would render it.
   */
  const times = (row: Cell[]) => row.slice(-2).map(cellText);
  /** Banner rows carry their text in the first cell; worker rows in the second. */
  const names = (rows: Cell[][]) => rows.map((r) => (String(r[0]).includes('=====') ? r[0] : r[1]));

  it('keeps a single block when nobody logged in twice', async () => {
    const svc = build(
      [worker('w1', 'Anand', 'EMP1'), worker('w2', 'Bala', 'EMP2')],
      [shift('s1', 'w1', 9, 17), shift('s2', 'w2', 9, 17)],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, params);
    expect(out.rows).toHaveLength(2);
    expect(out.rows.some((r) => String(r[0]).includes('====='))).toBe(false);
  });

  it('splits a two-shift day into a second block instead of one long stretch', async () => {
    const svc = build(
      [worker('w1', 'Anand', 'EMP1'), worker('w2', 'Bala', 'EMP2')],
      [shift('s1', 'w1', 10, 12), shift('s2', 'w1', 13, 15), shift('s3', 'w2', 9, 17)],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, params);

    expect(names(out.rows)).toEqual([
      '===== FIRST LOGIN OF THE DAY =====',
      'Anand',
      'Bala',
      '===== SECOND LOGIN OF THE DAY =====',
      'Anand',
    ]);
    // Anand's morning shift is not stretched to his afternoon logout.
    expect(times(out.rows[1])).toEqual(['10:00', '12:00']);
    expect(times(out.rows[2])).toEqual(['09:00', '17:00']);
    expect(times(out.rows[4])).toEqual(['13:00', '15:00']);
  });

  it('numbers each block from one', async () => {
    const svc = build(
      [worker('w1', 'Anand', 'EMP1'), worker('w2', 'Bala', 'EMP2')],
      [shift('s1', 'w1', 10, 12), shift('s2', 'w1', 13, 15), shift('s3', 'w2', 9, 17)],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, params);
    expect(out.rows[1][0]).toBe(1); // Anand, first block
    expect(out.rows[2][0]).toBe(2); // Bala, first block
    expect(out.rows[4][0]).toBe(1); // Anand again, second block restarts
  });

  it('leaves single-shift days blank in the second block', async () => {
    const svc = build(
      [worker('w1', 'Anand', 'EMP1')],
      [
        // 11 Jul: two shifts. 12 Jul: one.
        shift('s1', 'w1', 10, 12),
        shift('s2', 'w1', 13, 15),
        {
          ...shift('s3', 'w1', 9, 17),
          workDate: new Date(Date.UTC(2026, 6, 12)),
          loginAt: new Date(Date.UTC(2026, 6, 12, 9)),
          logoutAt: new Date(Date.UTC(2026, 6, 12, 17)),
        },
      ],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, {
      from: '2026-07-11',
      to: '2026-07-12',
    });
    // Two days, so four time columns: 11 IN/Out then 12 IN/Out.
    expect(out.rows[1].slice(-4)).toEqual(['10:00', '12:00', '09:00', '17:00']);
    expect(out.rows[3].slice(-4)).toEqual(['13:00', '15:00', null, null]);
  });

  it('stays a single block in presence mode, however many taps a day held', async () => {
    const svc = build(
      [worker('w1', 'Anand', 'EMP1')],
      [shift('s1', 'w1', 10, 12), shift('s2', 'w1', 13, 15)],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, {
      ...params,
      attendanceMode: 'PRESENCE',
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].slice(-1)).toEqual(['P']);
  });

  it('pulls the last Out back when the day breaches the 9-hour cap', async () => {
    const svc = build(
      [worker('w1', 'Anand', 'EMP1')],
      // 06:00-12:00 then 13:00-19:00 — twelve hours across two taps.
      [shift('s1', 'w1', 6, 12), shift('s2', 'w1', 13, 19)],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, {
      ...params,
      capHours: true,
    });
    expect(times(out.rows[1])).toEqual(['06:00', '12:00']);
    // The afternoon keeps the 3 hours the ceiling leaves: 13:00 + 3h.
    expect(times(out.rows[3])).toEqual(['13:00', '16:00']);
  });

  it('marks both times of a shift that ends the next morning', async () => {
    const svc = build(
      [worker('w1', 'Kailu', 'W-0084')],
      [
        {
          ...shift('s1', 'w1', 22, 22),
          // In at 22:00 on the 11th, out at 06:00 on the 12th.
          logoutAt: new Date(Date.UTC(2026, 6, 12, 6)),
          workedMinutes: 480,
        },
      ],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, params);

    // The whole row is marked, serial number to out time, so the fill runs
    // unbroken rather than singling the out time out from its own login.
    expect(out.rows[0].every(isNightTime)).toBe(true);
    // Only the out time names a date, and that is what CSV falls back on.
    expect(times(out.rows[0])).toEqual(['22:00', '06:00 (12 Jul)']);
    // The worker's columns still read as themselves.
    expect(cellText(out.rows[0][1])).toBe('Kailu');
    expect(cellText(out.rows[0][0])).toBe('1');
  });

  it('leaves the times alone when the cap is off', async () => {
    const svc = build(
      [worker('w1', 'Anand', 'EMP1')],
      [shift('s1', 'w1', 6, 12), shift('s2', 'w1', 13, 19)],
    );
    const out = await svc.preview(user, ReportType.ATTENDANCE_SHEET, params);
    expect(times(out.rows[3])).toEqual(['13:00', '19:00']);
  });
});
