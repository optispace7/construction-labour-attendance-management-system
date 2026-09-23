import { decideTap, distanceMeters, shouldVerifyPhoto } from './tap-decision';

describe('decideTap', () => {
  const t = (iso: string) => new Date(iso);

  it('opens a LOGIN when no open session and no recent tap', () => {
    const d = decideTap(t('2026-06-09T08:00:00Z'), 30, null, null);
    expect(d.action).toBe('LOGIN');
  });

  it('closes via LOGOUT when an open session exists', () => {
    const d = decideTap(
      t('2026-06-09T17:00:00Z'),
      30,
      { id: 's1', loginAt: t('2026-06-09T08:00:00Z'), siteId: 'site1' },
      {
        clientEventTime: t('2026-06-09T08:00:00Z'),
        tapType: 'LOGIN',
      },
    );
    expect(d).toEqual({ action: 'LOGOUT', sessionId: 's1' });
  });

  it('rejects a duplicate tap inside the cooldown window', () => {
    const d = decideTap(t('2026-06-09T08:00:10Z'), 30, null, {
      clientEventTime: t('2026-06-09T08:00:00Z'),
      tapType: 'LOGIN',
    });
    expect(d.action).toBe('DUPLICATE');
    if (d.action === 'DUPLICATE') expect(d.cooldownRemainingSeconds).toBe(20);
  });

  it('allows a tap exactly at the cooldown boundary', () => {
    const d = decideTap(t('2026-06-09T08:00:30Z'), 30, null, {
      clientEventTime: t('2026-06-09T08:00:00Z'),
      tapType: 'LOGIN',
    });
    expect(d.action).toBe('LOGIN');
  });
});

describe('decideTap safety gap', () => {
  const t = (iso: string) => new Date(iso);
  const open = (loginAt: string) => ({ id: 's1', loginAt: t(loginAt), siteId: 'site1' });
  const last = (at: string, tapType: 'LOGIN' | 'LOGOUT') => ({
    clientEventTime: t(at),
    tapType,
  });

  /// The accident the gap exists for: a badge left in front of the camera, and
  /// the re-read that clears the 30-second cooldown scanning the worker back
  /// out ~43 seconds after he arrived.
  it('refuses the re-read that used to log a worker straight back out', () => {
    const d = decideTap(
      t('2026-07-27T04:53:26Z'),
      30,
      open('2026-07-27T04:52:42Z'),
      last('2026-07-27T04:52:42Z', 'LOGIN'),
      600,
    );
    expect(d).toEqual({
      action: 'TOO_SOON',
      blocked: 'LOGOUT',
      remainingSeconds: 556,
      elapsedMinutes: 0,
    });
  });

  it('reports whole minutes on site and the wait remaining', () => {
    const d = decideTap(
      t('2026-06-09T08:03:30Z'),
      30,
      open('2026-06-09T08:00:00Z'),
      last('2026-06-09T08:00:00Z', 'LOGIN'),
      600,
    );
    expect(d.action).toBe('TOO_SOON');
    if (d.action === 'TOO_SOON') {
      expect(d.elapsedMinutes).toBe(3);
      expect(d.remainingSeconds).toBe(390);
    }
  });

  it('lets the LOGOUT through once the gap has passed', () => {
    const d = decideTap(
      t('2026-06-09T08:10:00Z'),
      30,
      open('2026-06-09T08:00:00Z'),
      last('2026-06-09T08:00:00Z', 'LOGIN'),
      600,
    );
    expect(d).toEqual({ action: 'LOGOUT', sessionId: 's1' });
  });

  it('is symmetric: refuses logging back in too soon after a logout', () => {
    const d = decideTap(
      t('2026-06-09T17:00:40Z'),
      30,
      null,
      last('2026-06-09T17:00:00Z', 'LOGOUT'),
      600,
    );
    expect(d.action).toBe('TOO_SOON');
    if (d.action === 'TOO_SOON') expect(d.blocked).toBe('LOGIN');
  });

  it('does not start the gap from a LOGIN tap that opened no session', () => {
    const d = decideTap(
      t('2026-06-09T08:00:40Z'),
      30,
      null,
      last('2026-06-09T08:00:00Z', 'LOGIN'),
      600,
    );
    expect(d.action).toBe('LOGIN');
  });

  it('lets the cooldown answer first inside its own window', () => {
    const d = decideTap(
      t('2026-06-09T08:00:10Z'),
      30,
      open('2026-06-09T08:00:00Z'),
      last('2026-06-09T08:00:00Z', 'LOGIN'),
      600,
    );
    expect(d.action).toBe('DUPLICATE');
  });

  it('switched off (0) leaves the old behaviour untouched', () => {
    const d = decideTap(
      t('2026-06-09T08:00:40Z'),
      30,
      open('2026-06-09T08:00:00Z'),
      last('2026-06-09T08:00:00Z', 'LOGIN'),
      0,
    );
    expect(d).toEqual({ action: 'LOGOUT', sessionId: 's1' });
  });

  it('allows the tap exactly at the gap boundary', () => {
    const d = decideTap(
      t('2026-06-09T08:10:00Z'),
      30,
      open('2026-06-09T08:00:00Z'),
      last('2026-06-09T08:00:00Z', 'LOGIN'),
      600,
    );
    expect(d.action).toBe('LOGOUT');
  });

  it('ignores a tap that predates the state change rather than blocking it', () => {
    // A clock-skewed device or a late offline replay. Measuring it against a
    // future login would refuse it for a wait that has already elapsed.
    const d = decideTap(
      t('2026-06-09T07:59:00Z'),
      30,
      open('2026-06-09T08:00:00Z'),
      last('2026-06-09T08:00:00Z', 'LOGIN'),
      600,
    );
    expect(d).toEqual({ action: 'LOGOUT', sessionId: 's1' });
  });
});

describe('decideTap late copy of a logout', () => {
  const t = (iso: string) => new Date(iso);
  const last = (at: string, tapType: 'LOGIN' | 'LOGOUT') => ({
    clientEventTime: t(at),
    tapType,
  });

  /// W-0080, 21 Sep 2026: two reads a second apart at 20:30:57 and 20:30:58 IST.
  /// The later one logged him out; the earlier one reached the server seven
  /// minutes after and opened a session that ran until the 23rd.
  it('refuses the earlier read that arrives after the logout', () => {
    const d = decideTap(
      t('2026-09-21T15:00:57.412Z'),
      30,
      null,
      last('2026-09-21T15:00:58.481Z', 'LOGOUT'),
      600,
    );
    expect(d).toEqual({ action: 'DUPLICATE', cooldownRemainingSeconds: 0 });
  });

  it('refuses it well outside the cooldown too', () => {
    // W-0409 the same evening: stamped 35 s before the logout it followed.
    const d = decideTap(
      t('2026-09-21T15:08:54Z'),
      30,
      null,
      last('2026-09-21T15:09:29Z', 'LOGOUT'),
      600,
    );
    expect(d.action).toBe('DUPLICATE');
  });

  it('refuses it even when the watchman overrode', () => {
    const d = decideTap(
      t('2026-09-21T15:00:57Z'),
      30,
      null,
      last('2026-09-21T15:00:58Z', 'LOGOUT'),
      0,
      true,
    );
    expect(d.action).toBe('DUPLICATE');
  });

  it('still logs in the next morning after a logout', () => {
    const d = decideTap(
      t('2026-09-22T05:00:00Z'),
      30,
      null,
      last('2026-09-21T15:00:58Z', 'LOGOUT'),
      600,
    );
    expect(d.action).toBe('LOGIN');
  });

  it('still lets an overridden re-login straight after a logout through', () => {
    const d = decideTap(
      t('2026-09-21T15:01:10Z'),
      30,
      null,
      last('2026-09-21T15:00:58Z', 'LOGOUT'),
      0,
      true,
    );
    expect(d.action).toBe('LOGIN');
  });

  it('leaves a tap that predates an open session as a LOGOUT', () => {
    // Logout-before-login stays out of scope at the gate: only a worker who is
    // already logged out is protected here.
    const d = decideTap(
      t('2026-09-21T07:59:00Z'),
      30,
      { id: 's1', loginAt: t('2026-09-21T08:00:00Z'), siteId: 'site1' },
      last('2026-09-21T08:00:00Z', 'LOGIN'),
      600,
    );
    expect(d).toEqual({ action: 'LOGOUT', sessionId: 's1' });
  });
});

describe('distanceMeters', () => {
  it('is ~0 for identical points', () => {
    expect(distanceMeters(12.97, 77.59, 12.97, 77.59)).toBeLessThan(1);
  });

  it('computes a known distance within tolerance', () => {
    // ~111 km per degree of latitude.
    const d = distanceMeters(12.0, 77.0, 13.0, 77.0);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
});

describe('shouldVerifyPhoto', () => {
  it('ALWAYS always triggers', () => {
    expect(shouldVerifyPhoto('ALWAYS', 0, 99)).toBe(true);
  });
  it('NEVER never triggers', () => {
    expect(shouldVerifyPhoto('NEVER', 100, 0)).toBe(false);
  });
  it('RANDOM triggers below the percentage', () => {
    expect(shouldVerifyPhoto('RANDOM', 20, 19)).toBe(true);
    expect(shouldVerifyPhoto('RANDOM', 20, 20)).toBe(false);
  });
});
