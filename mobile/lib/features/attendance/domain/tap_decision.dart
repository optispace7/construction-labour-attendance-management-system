/// Pure offline tap-decision logic, mirroring the backend engine so the device
/// can decide LOGIN/LOGOUT/DUPLICATE/TOO_SOON instantly without a network
/// round-trip.
///
/// The last three are not produced by [decideTap] — the repository raises them:
/// `expired` when the worker's ID card has lapsed, so the tap is never queued;
/// `pendingApproval` when a punch was typed in by hand and now waits on a Safety
/// Officer; and `awaitingReview` when one is already waiting for that person.
enum TapAction { login, logout, duplicate, tooSoon, expired, pendingApproval, awaitingReview }

class OpenSession {
  const OpenSession({required this.id, required this.loginAt, required this.siteId});
  final String id;
  final DateTime loginAt;
  final String siteId;
}

class TapDecision {
  const TapDecision(
    this.action, {
    this.sessionId,
    this.cooldownRemainingSeconds = 0,
    this.blocked,
    this.remainingSeconds = 0,
    this.elapsedMinutes = 0,
  });

  final TapAction action;
  final String? sessionId;
  final int cooldownRemainingSeconds;

  /// For [TapAction.tooSoon]: what the scan would have been, and how long until
  /// it would be accepted.
  final TapAction? blocked;
  final int remainingSeconds;
  final int elapsedMinutes;
}

/// Decide whether a tap is a LOGIN, LOGOUT, a DUPLICATE to ignore, or TOO_SOON
/// to act on.
///
/// Rules (docs/06-edge-cases.md #1, #4):
///  - within cooldown of the last tap            -> DUPLICATE
///  - state changed less than the safety gap ago -> TOO_SOON
///  - else if an open session exists             -> LOGOUT
///  - else                                       -> LOGIN
///
/// The cooldown runs from the last *tap* and is short — it swallows a badge read
/// that fires twice in a second. The safety gap runs from the last *state
/// change* and is long — it catches the read that lands a minute later, once the
/// cooldown has lapsed. Pass `safetyGapSeconds: 0` to switch the gap off;
/// visitors are exempt and an override sets it to zero for that one scan.
TapDecision decideTap({
  required DateTime tapTime,
  required int cooldownSeconds,
  OpenSession? openSession,
  DateTime? lastTapTime,
  String? lastTapType,
  int safetyGapSeconds = 0,
}) {
  if (lastTapTime != null) {
    final elapsedMs = tapTime.difference(lastTapTime).inMilliseconds;
    final cooldownMs = cooldownSeconds * 1000;
    if (elapsedMs >= 0 && elapsedMs < cooldownMs) {
      final remaining = ((cooldownMs - elapsedMs) / 1000).ceil();
      return TapDecision(TapAction.duplicate, cooldownRemainingSeconds: remaining);
    }
  }

  // When the worker entered the state they are in now: the login that opened
  // their session, or the logout that ended the last one.
  final gapMs = (safetyGapSeconds < 0 ? 0 : safetyGapSeconds) * 1000;
  final changedAt = openSession != null
      ? openSession.loginAt
      : (lastTapType == 'LOGOUT' ? lastTapTime : null);

  if (gapMs > 0 && changedAt != null) {
    final sinceChangeMs = tapTime.difference(changedAt).inMilliseconds;
    if (sinceChangeMs >= 0 && sinceChangeMs < gapMs) {
      return TapDecision(
        TapAction.tooSoon,
        sessionId: openSession?.id,
        blocked: openSession != null ? TapAction.logout : TapAction.login,
        remainingSeconds: ((gapMs - sinceChangeMs) / 1000).ceil(),
        elapsedMinutes: sinceChangeMs ~/ 60000,
      );
    }
  }

  if (openSession != null) {
    return TapDecision(TapAction.logout, sessionId: openSession.id);
  }
  return const TapDecision(TapAction.login);
}
