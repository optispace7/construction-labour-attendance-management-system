/**
 * One place for every number and date the dashboard shows.
 *
 * Scattered `toLocaleString()` calls are how a panel ends up showing "1,240" in
 * one card and "1240" in the next. Every helper here also has to survive null,
 * undefined and NaN, because a KPI that renders the word "NaN" in front of a
 * client is worse than one that renders a dash.
 */

/** The dash we show instead of a number we do not have. Never "0", never "—". */
export const NO_VALUE = '–';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 1240 → "1,240". Anything that is not a real number → "–". */
export function formatNumber(value: number | null | undefined, fractionDigits = 0): string {
  if (!isNum(value)) return NO_VALUE;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Compact form for tiles that must not wrap: 1240 → "1.2k", 1_240_000 → "1.2M".
 * Below 1000 it stays exact — "847" reads better than "0.8k".
 */
export function formatCompact(value: number | null | undefined): string {
  if (!isNum(value)) return NO_VALUE;
  if (Math.abs(value) < 1000) return formatNumber(value);
  return value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
}

/**
 * A share as a percentage. Returns "–" when the denominator is zero or missing
 * rather than 0% — "0% attendance" and "we don't know" are different claims, and
 * only one of them is safe to put in front of a client.
 */
export function formatPercent(
  part: number | null | undefined,
  whole: number | null | undefined,
  fractionDigits = 0,
): string {
  const pct = percentValue(part, whole);
  if (pct === null) return NO_VALUE;
  return `${pct.toFixed(fractionDigits)}%`;
}

/** The raw 0-100 number behind [formatPercent], or null when undefined. */
export function percentValue(
  part: number | null | undefined,
  whole: number | null | undefined,
): number | null {
  if (!isNum(part) || !isNum(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** 570 → "9h 30m". Minutes only below an hour; hours only when it is exact. */
export function formatDuration(minutes: number | null | undefined): string {
  if (!isNum(minutes) || minutes < 0) return NO_VALUE;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** 1234.5 hours → "1,234.5" — one decimal is enough for a headline tile. */
export function formatHours(hours: number | null | undefined): string {
  if (!isNum(hours)) return NO_VALUE;
  return formatNumber(Math.round(hours * 10) / 10, hours % 1 === 0 ? 0 : 1);
}

const parseDate = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null;
  // A bare "2026-07-27" is parsed as UTC midnight, which displays as the
  // previous day anywhere west of Greenwich. Anchor it to local midnight.
  const d =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00`)
      : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "27 Jul" — the default for axis ticks and dense lists. */
export function formatDay(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  return d ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : NO_VALUE;
}

/** "Mon 27" — reads better than "27 Jul" across a single week. */
export function formatWeekday(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  return d ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : NO_VALUE;
}

/** "27 Jul 2026" — for period labels and anything that outlives the year. */
export function formatFullDate(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  return d
    ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : NO_VALUE;
}

/** "14:32" — 24h, because a site register is not an appointment. */
export function formatTime(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  return d
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    : NO_VALUE;
}

/** "27 Jul, 14:32" */
export function formatDateTime(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  return d ? `${formatDay(d)}, ${formatTime(d)}` : NO_VALUE;
}

/**
 * "just now" / "12m ago" / "3h ago" / "2d ago".
 *
 * Deliberately stops at days: past a week nobody is reading this as elapsed
 * time, they want the date, and the caller should show one.
 */
export function formatRelative(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  if (!d) return NO_VALUE;
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 0) return 'just now';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "1 worker" / "3 workers" — no bare "(s)" anywhere in the UI. */
export function pluralise(count: number | null | undefined, one: string, many?: string): string {
  const n = isNum(count) ? count : 0;
  return `${formatNumber(n)} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

/** Local-calendar YYYY-MM-DD. toISOString() would shift the day west of UTC. */
export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return isoDay(d);
}

/** Inclusive day count between two YYYY-MM-DD strings. */
export function daySpan(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Change between two periods, as a plain count.
 *
 * Deliberately not a percentage: on the small numbers a single site produces,
 * a percentage swings alarmingly for a change of one or two people, and
 * "6 more than yesterday" is the sentence somebody can act on anyway.
 *
 * Returns null when either figure is missing — a card should say nothing rather
 * than imply a comparison it cannot make.
 */
export function changeVs(
  current: number | null | undefined,
  previous: number | null | undefined,
): { delta: number; direction: 'up' | 'down' | 'flat' } | null {
  if (!isNum(current) || !isNum(previous)) return null;
  const delta = current - previous;
  if (delta === 0) return { delta: 0, direction: 'flat' };
  return { delta, direction: delta > 0 ? 'up' : 'down' };
}

/** Cuts a long vendor/site/trade name for an axis, keeping it recognisable. */
export function truncate(text: string | null | undefined, max = 18): string {
  if (!text) return NO_VALUE;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
