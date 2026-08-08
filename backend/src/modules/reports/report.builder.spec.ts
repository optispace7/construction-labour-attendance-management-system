import {
  capSessionHours,
  capWorkerDay,
  COMPLIANCE_CAP_MINUTES,
  minutesToHours,
  toCsv,
} from './report.builder';

describe('report.builder', () => {
  it('spells the day out in CSV, which has no colour to carry it', () => {
    const csv = toCsv(
      ['5 Aug IN', '5 Aug Out'],
      [
        [
          { value: '20:20', night: true },
          { value: '07:52', day: '06 Aug', night: true },
        ],
      ],
    );
    // A reader of the CSV still learns the shift ended the next morning.
    expect(csv.split('\n')[1]).toBe('20:20,07:52 (06 Aug)');
  });

  it('builds CSV with header and rows', () => {
    const csv = toCsv(
      ['A', 'B'],
      [
        [1, 'x'],
        [2, 'y'],
      ],
    );
    expect(csv).toBe('A,B\n1,x\n2,y');
  });

  it('escapes values containing commas, quotes, and newlines', () => {
    const csv = toCsv(['Name'], [['Doe, John'], ['say "hi"'], ['line\nbreak']]);
    expect(csv).toBe('Name\n"Doe, John"\n"say ""hi"""\n"line\nbreak"');
  });

  it('converts minutes to hours with 2 decimals', () => {
    expect(minutesToHours(90)).toBe('1.50');
    expect(minutesToHours(0)).toBe('0.00');
    expect(minutesToHours(null)).toBe('0.00');
  });
});

describe('capSessionHours', () => {
  const login = new Date('2026-07-09T02:30:00.000Z');
  const session = (workedMinutes: number | null, overtimeMinutes: number | null, hours = 0) => ({
    workedMinutes,
    overtimeMinutes,
    loginAt: login,
    logoutAt: hours ? new Date(login.getTime() + hours * 3_600_000) : null,
  });

  it('leaves a normal 8-hour day untouched', () => {
    const r = capSessionHours(session(480, 0, 8));
    expect(r.capped).toBe(false);
    expect(r.workedMinutes).toBe(480);
    expect(r.logoutAt).toEqual(new Date('2026-07-09T10:30:00.000Z'));
  });

  it('leaves a day exactly at the cap untouched', () => {
    const r = capSessionHours(session(COMPLIANCE_CAP_MINUTES, 60, 9));
    expect(r.capped).toBe(false);
    expect(r.workedMinutes).toBe(COMPLIANCE_CAP_MINUTES);
    expect(r.overtimeMinutes).toBe(60);
  });

  it('trims a forgotten logout down to 9 hours', () => {
    // Tapped in at 08:00 local, never tapped out — 14 hours on the clock.
    const r = capSessionHours(session(840, 360, 14));
    expect(r.capped).toBe(true);
    expect(r.workedMinutes).toBe(540);
    expect(minutesToHours(r.workedMinutes)).toBe('9.00');
  });

  it('pulls the logout stamp back so it agrees with the capped hours', () => {
    const r = capSessionHours(session(840, 360, 14));
    // login 02:30Z + 9h
    expect(r.logoutAt).toEqual(new Date('2026-07-09T11:30:00.000Z'));
  });

  it('trims overtime first, keeping every regular minute', () => {
    // 8h regular + 3h overtime = 11h worked → cap leaves 8h regular + 1h OT.
    const r = capSessionHours(session(660, 180));
    expect(r.workedMinutes).toBe(540);
    expect(r.overtimeMinutes).toBe(60);
  });

  it('never reports negative overtime when regular hours alone exceed the cap', () => {
    // 10h worked, none of it booked as overtime.
    const r = capSessionHours(session(600, 0));
    expect(r.workedMinutes).toBe(540);
    expect(r.overtimeMinutes).toBe(0);
  });

  it('passes through a session that has no worked minutes yet (still open)', () => {
    const r = capSessionHours(session(null, null));
    expect(r.capped).toBe(false);
    expect(r.workedMinutes).toBeNull();
    expect(r.logoutAt).toBeNull();
  });

  it('keeps a null logout null when there is no login to offset from', () => {
    const r = capSessionHours({
      workedMinutes: 700,
      overtimeMinutes: 0,
      loginAt: null,
      logoutAt: null,
    });
    expect(r.capped).toBe(true);
    expect(r.logoutAt).toBeNull();
  });

  it('honours a custom cap', () => {
    const r = capSessionHours(session(600, 0), 8 * 60);
    expect(r.workedMinutes).toBe(480);
  });
});

describe('capWorkerDay', () => {
  /** A shift starting at `startHour` local-ish, running `hours`. */
  const shift = (startHour: number, hours: number, overtimeMinutes = 0) => {
    const loginAt = new Date(Date.UTC(2026, 6, 11, startHour, 0, 0));
    return {
      workedMinutes: hours * 60,
      overtimeMinutes,
      loginAt,
      logoutAt: new Date(loginAt.getTime() + hours * 3_600_000),
    };
  };
  const totalWorked = (rows: { workedMinutes: number | null }[]) =>
    rows.reduce((sum, r) => sum + (r.workedMinutes ?? 0), 0);

  it('leaves a two-shift day that stays under the cap alone', () => {
    // 10:00-12:00 then 13:00-15:00 — four hours across two taps.
    const r = capWorkerDay([shift(10, 2), shift(13, 2)]);
    expect(r.map((s) => s.capped)).toEqual([false, false]);
    expect(totalWorked(r)).toBe(240);
    expect(r[1].logoutAt).toEqual(new Date(Date.UTC(2026, 6, 11, 15, 0, 0)));
  });

  it('caps two shifts that individually pass but together breach the ceiling', () => {
    // The case a per-session cap misses entirely: 6h + 6h = 12h.
    const r = capWorkerDay([shift(6, 6), shift(13, 6)]);
    expect(totalWorked(r)).toBe(COMPLIANCE_CAP_MINUTES);
    expect(r[0].capped).toBe(false);
    expect(r[1].capped).toBe(true);
  });

  it('trims from the last shift backwards, leaving the morning intact', () => {
    const r = capWorkerDay([shift(6, 6), shift(13, 6)]);
    expect(r[0].workedMinutes).toBe(360);
    expect(r[0].logoutAt).toEqual(new Date(Date.UTC(2026, 6, 11, 12, 0, 0)));
    // 3h of the afternoon shift survives: 13:00 + 3h.
    expect(r[1].workedMinutes).toBe(180);
    expect(r[1].logoutAt).toEqual(new Date(Date.UTC(2026, 6, 11, 16, 0, 0)));
  });

  it('spills into earlier shifts when the last one cannot give up enough', () => {
    // 5h + 5h + 2h = 12h; the 2h shift vanishes and the middle one gives 1h.
    const r = capWorkerDay([shift(6, 5), shift(12, 5), shift(18, 2)]);
    expect(totalWorked(r)).toBe(COMPLIANCE_CAP_MINUTES);
    expect(r.map((s) => s.workedMinutes)).toEqual([300, 240, 0]);
  });

  it('keeps a shift trimmed to nothing rather than dropping it', () => {
    const r = capWorkerDay([shift(6, 9), shift(18, 2)]);
    expect(r).toHaveLength(2);
    expect(r[1].workedMinutes).toBe(0);
    // Login stands, so the sheet still shows the worker tapped in.
    expect(r[1].logoutAt).toEqual(new Date(Date.UTC(2026, 6, 11, 18, 0, 0)));
  });

  it('gives up overtime before regular hours within a trimmed shift', () => {
    // 4h regular + 4h with 3h of it overtime = 8h + ... totals 11h.
    const r = capWorkerDay([shift(6, 4), shift(12, 7, 180)]);
    expect(totalWorked(r)).toBe(COMPLIANCE_CAP_MINUTES);
    // Second shift keeps 5h: its 4h of regular time plus 1h of overtime.
    expect(r[1].workedMinutes).toBe(300);
    expect(r[1].overtimeMinutes).toBe(60);
  });

  it('ignores a still-open session and caps only the settled ones', () => {
    const open = { workedMinutes: null, overtimeMinutes: null, loginAt: null, logoutAt: null };
    const r = capWorkerDay([shift(6, 6), open, shift(13, 6)]);
    expect(r[1].workedMinutes).toBeNull();
    expect(r[1].capped).toBe(false);
    expect(totalWorked(r)).toBe(COMPLIANCE_CAP_MINUTES);
  });

  it('handles an empty day', () => {
    expect(capWorkerDay([])).toEqual([]);
  });

  it('honours a custom cap across the day', () => {
    const r = capWorkerDay([shift(6, 4), shift(12, 4)], 6 * 60);
    expect(totalWorked(r)).toBe(360);
  });
});
