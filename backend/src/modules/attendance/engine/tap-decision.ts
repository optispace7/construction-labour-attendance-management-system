import { TapType } from '@prisma/client';

export interface OpenSessionInfo {
  id: string;
  loginAt: Date;
  siteId: string;
}

export interface LastTapInfo {
  clientEventTime: Date;
  tapType: TapType | null;
}

export type TapDecision =
  | { action: 'LOGIN' }
  | { action: 'LOGOUT'; sessionId: string }
  | { action: 'DUPLICATE'; cooldownRemainingSeconds: number }
  | {
      action: 'TOO_SOON';
      /** What the tap would have been had the gap already passed. */
      blocked: 'LOGIN' | 'LOGOUT';
      /** Seconds until the same scan would be accepted. */
      remainingSeconds: number;
      /** Minutes the worker has been in their current state. */
      elapsedMinutes: number;
    };

/**
 * Pure decision function: given the worker's current open session (if any),
 * their last tap, the site cooldown and the site safety gap, decide whether
 * this tap is a LOGIN, a LOGOUT, a DUPLICATE to ignore, or TOO_SOON to act on.
 *
 * Rules (docs/06-edge-cases.md #1, #4):
 *  - If the tap falls within the cooldown window of the last tap → DUPLICATE.
 *  - Else if the worker's state changed less than the safety gap ago → TOO_SOON.
 *  - Else if an open session exists → LOGOUT (closes it).
 *  - Else → LOGIN.
 *
 * The cooldown and the safety gap look alike but do different jobs. The
 * cooldown is measured from the last *tap* and is short — it swallows the badge
 * read that fires twice in the same second. The safety gap is measured from the
 * last *state change* and is long — it catches the read that lands a minute
 * later, once the cooldown has lapsed, which is how a queue of workers used to
 * get scanned back out shortly after arriving.
 *
 * Pass `safetyGapSeconds: 0` to switch the gap off — visitors are exempt,
 * because a ten-minute site visit is a normal visit.
 */
export function decideTap(
  tapTime: Date,
  cooldownSeconds: number,
  openSession: OpenSessionInfo | null,
  lastTap: LastTapInfo | null,
  safetyGapSeconds = 0,
): TapDecision {
  if (lastTap) {
    const elapsedMs = tapTime.getTime() - lastTap.clientEventTime.getTime();
    const cooldownMs = cooldownSeconds * 1000;
    if (elapsedMs >= 0 && elapsedMs < cooldownMs) {
      return {
        action: 'DUPLICATE',
        cooldownRemainingSeconds: Math.ceil((cooldownMs - elapsedMs) / 1000),
      };
    }
  }

  // The instant the worker entered their current state: the login that opened
  // the session they are in, or the logout tap that ended the last one. A tap
  // that predates it (a clock-skewed device, a late offline replay) is left to
  // the rules below rather than measured against a future event.
  const gapMs = Math.max(0, safetyGapSeconds) * 1000;
  const changedAt = openSession
    ? openSession.loginAt
    : lastTap?.tapType === 'LOGOUT'
      ? lastTap.clientEventTime
      : null;

  if (gapMs > 0 && changedAt) {
    const sinceChangeMs = tapTime.getTime() - changedAt.getTime();
    if (sinceChangeMs >= 0 && sinceChangeMs < gapMs) {
      return {
        action: 'TOO_SOON',
        blocked: openSession ? 'LOGOUT' : 'LOGIN',
        remainingSeconds: Math.ceil((gapMs - sinceChangeMs) / 1000),
        elapsedMinutes: Math.floor(sinceChangeMs / 60_000),
      };
    }
  }

  if (openSession) {
    return { action: 'LOGOUT', sessionId: openSession.id };
  }
  return { action: 'LOGIN' };
}

/** Haversine distance in metres between two lat/lng points. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Decide whether photo verification should trigger for this tap.
 * `roll` is a 0-100 value (caller supplies randomness) so this stays pure.
 */
export function shouldVerifyPhoto(
  mode: 'ALWAYS' | 'NEVER' | 'RANDOM',
  randomPct: number,
  roll: number,
): boolean {
  if (mode === 'ALWAYS') return true;
  if (mode === 'NEVER') return false;
  return roll < randomPct;
}
