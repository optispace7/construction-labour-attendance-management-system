/** Pure CSV helpers used by the reports service (kept dependency-free & testable). */

/**
 * A clock time that belongs to a night shift, in the muster grid where each day
 * owns one IN/Out pair. Every time on such a row carries it, so the shift reads
 * as one stretch rather than an out time singled out from its own login.
 *
 * It travels as a value rather than decorated text so every format can say it
 * its own way: colour in Excel, the PDF and the web preview; the date spelled
 * out in CSV, which has no formatting to colour.
 */
export interface NightTime {
  /** The clock time itself, "07:52". */
  value: string;
  /**
   * Set only on the out time that lands the following morning — "06 Aug" — and
   * used by the formats that cannot carry colour, and for the panel's tooltip.
   */
  day?: string;
  night: true;
}

export type Cell = string | number | NightTime | null;

export function isNightTime(v: unknown): v is NightTime {
  return typeof v === 'object' && v !== null && (v as NightTime).night === true;
}

/** The plain text of a cell — what a colourless format has to fall back on. */
export function cellText(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  if (isNightTime(v)) return v.day ? `${v.value} (${v.day})` : v.value;
  return String(v);
}

export function toCsv(headers: string[], rows: (Cell | undefined)[][]): string {
  const escape = (v: Cell | undefined): string => {
    const s = cellText(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return lines.join('\n');
}

export function minutesToHours(mins: number | null | undefined): string {
  if (!mins) return '0.00';
  return (mins / 60).toFixed(2);
}

/** Statutory ceiling on a single day's working hours, in minutes. */
export const COMPLIANCE_CAP_MINUTES = 9 * 60;

export interface CappedSession {
  workedMinutes: number | null;
  overtimeMinutes: number | null;
  logoutAt: Date | null;
  /** True when this session was longer than the cap and has been trimmed. */
  capped: boolean;
}

export interface CappableSession {
  workedMinutes: number | null;
  overtimeMinutes: number | null;
  loginAt: Date | null;
  logoutAt: Date | null;
}

/** Trim one session down to `keepMinutes`, giving up overtime before regular. */
function trimTo(session: CappableSession, keepMinutes: number): CappedSession {
  const worked = session.workedMinutes ?? 0;
  const overtime = session.overtimeMinutes ?? 0;
  const regular = Math.max(0, worked - overtime);
  return {
    workedMinutes: keepMinutes,
    // Whatever the cap leaves once regular hours are paid; never negative.
    overtimeMinutes: Math.max(0, keepMinutes - regular),
    logoutAt: session.loginAt
      ? new Date(session.loginAt.getTime() + keepMinutes * 60_000)
      : session.logoutAt,
    capped: true,
  };
}

function untouched(session: CappableSession): CappedSession {
  return {
    workedMinutes: session.workedMinutes,
    overtimeMinutes: session.overtimeMinutes,
    logoutAt: session.logoutAt,
    capped: false,
  };
}

/**
 * Trim one worker's day down to the statutory ceiling. The two causes of an
 * over-long day are a worker who forgot to tap out (one enormous session) and a
 * split shift that genuinely adds up past the cap — the ceiling is a limit on
 * the day, so both are measured against the same total.
 *
 * `sessions` is one worker's sessions for a single work date, in login order.
 * The day is trimmed from the last shift backwards: earlier shifts are settled
 * fact by the time a later one starts, so the minutes that breach the ceiling
 * are the ones at the end of the day. Within a trimmed shift, overtime goes
 * before regular hours, so a capped day keeps every regular minute it can.
 *
 * Each logout stamp is pulled back to its own login + kept minutes, so the row
 * stays internally consistent — a reader cannot derive 12 hours from the
 * timestamps while the hours column claims 9. A shift trimmed away entirely
 * keeps its login and reads as zero minutes rather than vanishing: the worker
 * did tap in, and the sheet should still say so.
 *
 * Days at or under the cap are returned untouched, as are sessions still open
 * (no worked minutes yet) — there are no hours there to trim.
 */
export function capWorkerDay(
  sessions: CappableSession[],
  capMinutes: number = COMPLIANCE_CAP_MINUTES,
): CappedSession[] {
  const total = sessions.reduce((sum, s) => sum + (s.workedMinutes ?? 0), 0);
  if (total <= capMinutes) return sessions.map(untouched);

  // Walk backwards giving up minutes until the day fits under the ceiling.
  let excess = total - capMinutes;
  const out = sessions.map(untouched);
  for (let i = sessions.length - 1; i >= 0 && excess > 0; i--) {
    const worked = sessions[i].workedMinutes;
    if (worked === null) continue; // still open — nothing to give up
    const give = Math.min(excess, worked);
    if (give === 0) continue;
    out[i] = trimTo(sessions[i], worked - give);
    excess -= give;
  }
  return out;
}

/**
 * Single-session convenience wrapper around {@link capWorkerDay}, for the paths
 * that hold one session rather than a whole day.
 */
export function capSessionHours(
  session: CappableSession,
  capMinutes: number = COMPLIANCE_CAP_MINUTES,
): CappedSession {
  return capWorkerDay([session], capMinutes)[0];
}
