import 'package:flutter_test/flutter_test.dart';
import 'package:clams_mobile/features/attendance/domain/tap_decision.dart';

void main() {
  DateTime t(String s) => DateTime.parse(s);

  group('decideTap', () {
    test('LOGIN when no open session and no recent tap', () {
      final d = decideTap(tapTime: t('2026-06-09T08:00:00Z'), cooldownSeconds: 30);
      expect(d.action, TapAction.login);
    });

    test('LOGOUT when an open session exists', () {
      final d = decideTap(
        tapTime: t('2026-06-09T17:00:00Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(id: 's1', loginAt: t('2026-06-09T08:00:00Z'), siteId: 'a'),
        lastTapTime: t('2026-06-09T08:00:00Z'),
      );
      expect(d.action, TapAction.logout);
      expect(d.sessionId, 's1');
    });

    test('DUPLICATE inside the cooldown window with remaining seconds', () {
      final d = decideTap(
        tapTime: t('2026-06-09T08:00:10Z'),
        cooldownSeconds: 30,
        lastTapTime: t('2026-06-09T08:00:00Z'),
      );
      expect(d.action, TapAction.duplicate);
      expect(d.cooldownRemainingSeconds, 20);
    });

    test('allows a tap exactly at the cooldown boundary', () {
      final d = decideTap(
        tapTime: t('2026-06-09T08:00:30Z'),
        cooldownSeconds: 30,
        lastTapTime: t('2026-06-09T08:00:00Z'),
      );
      expect(d.action, TapAction.login);
    });
  });

  group('safety gap', () {
    /// The bug this gap exists for: a watchman works a queue, the worker keeps
    /// his badge in front of the lens, and the re-read that finally clears the
    /// 30-second cooldown scans him back out ~43s after he arrived.
    test('refuses the re-read that used to log a worker straight back out', () {
      final d = decideTap(
        tapTime: t('2026-07-27T04:53:26Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(id: 's1', loginAt: t('2026-07-27T04:52:42Z'), siteId: 'a'),
        lastTapTime: t('2026-07-27T04:52:42Z'),
        lastTapType: 'LOGIN',
        safetyGapSeconds: 600,
      );
      expect(d.action, TapAction.tooSoon);
      expect(d.blocked, TapAction.logout);
      expect(d.elapsedMinutes, 0);
      expect(d.remainingSeconds, 556);
    });

    test('reports whole minutes on site and the wait remaining', () {
      final d = decideTap(
        tapTime: t('2026-06-09T08:03:30Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(id: 's1', loginAt: t('2026-06-09T08:00:00Z'), siteId: 'a'),
        lastTapTime: t('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
        safetyGapSeconds: 600,
      );
      expect(d.action, TapAction.tooSoon);
      expect(d.elapsedMinutes, 3);
      expect(d.remainingSeconds, 390);
    });

    test('LOGOUT once the gap has passed', () {
      final d = decideTap(
        tapTime: t('2026-06-09T08:10:00Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(id: 's1', loginAt: t('2026-06-09T08:00:00Z'), siteId: 'a'),
        lastTapTime: t('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
        safetyGapSeconds: 600,
      );
      expect(d.action, TapAction.logout);
      expect(d.sessionId, 's1');
    });

    test('is symmetric: refuses logging back in too soon after a logout', () {
      final d = decideTap(
        tapTime: t('2026-06-09T17:00:40Z'),
        cooldownSeconds: 30,
        lastTapTime: t('2026-06-09T17:00:00Z'),
        lastTapType: 'LOGOUT',
        safetyGapSeconds: 600,
      );
      expect(d.action, TapAction.tooSoon);
      expect(d.blocked, TapAction.login);
    });

    test('a LOGIN tap with no open session does not start the gap', () {
      // Nothing to protect: the worker is not on site, and the login that would
      // have put him there was never confirmed into a session.
      final d = decideTap(
        tapTime: t('2026-06-09T08:00:40Z'),
        cooldownSeconds: 30,
        lastTapTime: t('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
        safetyGapSeconds: 600,
      );
      expect(d.action, TapAction.login);
    });

    test('the cooldown still answers first inside its own window', () {
      final d = decideTap(
        tapTime: t('2026-06-09T08:00:10Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(id: 's1', loginAt: t('2026-06-09T08:00:00Z'), siteId: 'a'),
        lastTapTime: t('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
        safetyGapSeconds: 600,
      );
      expect(d.action, TapAction.duplicate);
    });

    test('switched off (0) leaves the old behaviour untouched', () {
      final d = decideTap(
        tapTime: t('2026-06-09T08:00:40Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(id: 's1', loginAt: t('2026-06-09T08:00:00Z'), siteId: 'a'),
        lastTapTime: t('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
      );
      expect(d.action, TapAction.logout);
    });

    test('allowed exactly at the gap boundary', () {
      final d = decideTap(
        tapTime: t('2026-06-09T08:10:00Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(id: 's1', loginAt: t('2026-06-09T08:00:00Z'), siteId: 'a'),
        lastTapTime: t('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
        safetyGapSeconds: 600,
      );
      expect(d.action, TapAction.logout);
    });
  });

  group('override', () {
    // The watchman has seen the refusal and confirmed it. He is at the gate and
    // can see whether it is one badge read twice or a second man who walked up.
    test('clears the duplicate cooldown', () {
      final d = decideTap(
        tapTime: DateTime.parse('2026-06-09T08:00:05Z'),
        cooldownSeconds: 30,
        lastTapTime: DateTime.parse('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
        overridden: true,
      );
      expect(d.action, TapAction.login);
    });

    test('clears the safety gap too', () {
      final d = decideTap(
        tapTime: DateTime.parse('2026-06-09T08:01:00Z'),
        cooldownSeconds: 30,
        openSession: OpenSession(
          id: 's1',
          loginAt: DateTime.parse('2026-06-09T08:00:00Z'),
          siteId: 'site-1',
        ),
        lastTapTime: DateTime.parse('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
        safetyGapSeconds: 600,
        overridden: true,
      );
      expect(d.action, TapAction.logout);
    });

    test('without it, the cooldown still refuses', () {
      final d = decideTap(
        tapTime: DateTime.parse('2026-06-09T08:00:05Z'),
        cooldownSeconds: 30,
        lastTapTime: DateTime.parse('2026-06-09T08:00:00Z'),
        lastTapType: 'LOGIN',
      );
      expect(d.action, TapAction.duplicate);
      expect(d.cooldownRemainingSeconds, 25);
    });
  });
}
