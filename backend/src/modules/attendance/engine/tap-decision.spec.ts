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
