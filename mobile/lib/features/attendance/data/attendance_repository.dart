import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

import '../../../core/geo/location_service.dart';
import '../../../core/network/api_client.dart';
import '../../../core/storage/local_db.dart';
import '../domain/models.dart';
import '../domain/card_validity.dart';
import '../domain/tap_decision.dart';

/// Outcome surfaced to the UI after a tap. The event is ALWAYS persisted to the
/// outbox first (durable) before this returns success — so attendance is never
/// lost on crash, restart or network loss.
class TapOutcome {
  const TapOutcome({
    required this.action,
    this.worker,
    this.cooldownRemainingSeconds = 0,
    this.requiresConfirm = false,
    this.message,
    this.blocked,
    this.remainingSeconds = 0,
    this.elapsedMinutes = 0,
    this.stateIsStale = false,
  });
  final TapAction action;
  final WorkerCard? worker;
  final int cooldownRemainingSeconds;
  final bool requiresConfirm;
  final String? message;

  /// For [TapAction.tooSoon]: what the scan would have recorded, how long the
  /// worker has been in their current state, and how long until it is allowed.
  final TapAction? blocked;
  final int remainingSeconds;
  final int elapsedMinutes;

  /// True when this device could NOT confirm the worker's live state with the
  /// server, so LOGIN/LOGOUT is a guess from whatever it last heard. A tap made
  /// on another gate — or a Super Admin fix in the panel — would not be in it.
  final bool stateIsStale;

  TapOutcome copyWith({TapAction? action, WorkerCard? worker}) => TapOutcome(
        action: action ?? this.action,
        worker: worker ?? this.worker,
        cooldownRemainingSeconds: cooldownRemainingSeconds,
        requiresConfirm: requiresConfirm,
        message: message,
        blocked: blocked,
        remainingSeconds: remainingSeconds,
        elapsedMinutes: elapsedMinutes,
        stateIsStale: stateIsStale,
      );
}

class AttendanceRepository {
  AttendanceRepository(this._db, this._api, this._location);
  final LocalDb _db;
  final ApiClient _api;
  final LocationService _location;
  final _uuid = const Uuid();

  /// How long a scan will wait on the server before falling back to local
  /// state. Short on purpose — the queue at the gate doesn't wait.
  static const _stateTimeout = Duration(seconds: 5);

  /// Resolve a worker from cached data for the given identifier/source.
  /// QR badges encode the EMP-ID (worker code); fall back to the opaque
  /// qr identifier for legacy codes. On a local cache miss we ask the server
  /// (best-effort) — this covers workers not assigned to the active site or a
  /// cache that hasn't refreshed yet, so a valid badge isn't reported as unknown.
  Future<WorkerCard?> resolve(TapSource source, String identifier) async {
    final local = await _resolveLocal(source, identifier);
    if (local != null) return local;
    return _resolveRemote(source, identifier);
  }

  Future<WorkerCard?> _resolveLocal(TapSource source, String identifier) async {
    switch (source) {
      case TapSource.nfcUid:
        return _db.findByUid(identifier);
      case TapSource.qr:
        return (await _db.findByCode(identifier)) ?? (await _db.findByQr(identifier));
      default:
        return _db.findByCode(identifier);
    }
  }

  /// Server lookup used only when the offline cache misses. Caches the result so
  /// the next scan resolves locally. Returns null when offline or not found —
  /// the tap is still recorded by identifier and resolves on sync.
  Future<WorkerCard?> _resolveRemote(TapSource source, String identifier) async {
    final attempts = switch (source) {
      TapSource.nfcUid => [
          {'uid': identifier},
        ],
      TapSource.qr => [
          {'code': identifier},
          {'qr': identifier},
        ],
      _ => [
          {'code': identifier},
        ],
    };
    for (final params in attempts) {
      try {
        final res = await _api.dio.get('/workers/lookup', queryParameters: params);
        final data = res.data;
        if (data is Map<String, dynamic>) {
          final card = WorkerCard.fromMap(data);
          await _db.cacheWorkers([card]);
          return card;
        }
      } on DioException catch (e) {
        // No response means offline — stop trying. A 404 just means "not this
        // identifier"; move on to the next attempt.
        if (e.response == null) break;
      }
    }
    return null;
  }

  /// The site's scanning rules, last known. Read from the local cache so the
  /// gate keeps enforcing what the admin panel says even with no network.
  Future<ScanPolicy> policy() async {
    final cooldown = int.tryParse(await _db.getMeta('policy:cooldownSeconds') ?? '');
    final gap = int.tryParse(await _db.getMeta('policy:safetyGapMinutes') ?? '');
    return ScanPolicy(
      cooldownSeconds: cooldown ?? 30,
      safetyGapMinutes: gap ?? 10,
    );
  }

  /// Re-read the site's rules from the server and cache them.
  ///
  /// The full settings record sits behind an admin-only permission, so the app
  /// asks the scanner-side endpoint instead. Until this existed the device used
  /// a hardcoded 30-second cooldown and ignored the admin panel entirely.
  Future<void> refreshPolicy(String siteId) async {
    try {
      final res = await _api.dio
          .get('/attendance/site-config', queryParameters: {'siteId': siteId})
          .timeout(_stateTimeout);
      final data = res.data;
      if (data is! Map) return;
      final p = ScanPolicy.fromMap(data);
      await _db.setMeta('policy:cooldownSeconds', '${p.cooldownSeconds}');
      await _db.setMeta('policy:safetyGapMinutes', '${p.safetyGapMinutes}');
    } catch (_) {
      // Offline — keep the cached policy; retried on the next cycle.
    }
  }

  /// Pull one worker's live login state from the server into the local meta, so
  /// the in/out decision below reflects taps made on other devices, and Super
  /// Admin repairs made in the panel.
  ///
  /// Best-effort and time-boxed: offline, or a server too slow to wait on at the
  /// gate, just leaves the local meta alone.
  ///
  /// Skipped only while THIS worker has punches still sitting in the outbox —
  /// the server hasn't seen those, so its answer for them would be staler than
  /// what this device already knows. It used to skip whenever the outbox held
  /// anything at all, for anybody, which is how a phone could end up permanently
  /// ignoring the server: one event the server would never accept sat unsent for
  /// good, and from then on a worker a Super Admin had logged out in the panel
  /// was still offered LOGOUT here, because the only history consulted was this
  /// handset's own.
  ///
  /// Returns false when the local view could not be confirmed, so the caller can
  /// tell the operator that LOGIN/LOGOUT is a guess rather than let him find out
  /// from a toast that contradicts the screen he just pressed OK on.
  Future<bool> _refreshWorkerState(WorkerCard worker) async {
    final workerId = worker.id;
    try {
      final unsentForThisWorker = await _db.pendingCountForIdentifiers([
        worker.workerCode,
        if (worker.nfcUid != null) worker.nfcUid!,
        if (worker.qrIdentifier != null) worker.qrIdentifier!,
      ]);
      if (unsentForThisWorker > 0) return false;

      final res = await _api.dio
          .get('/attendance/worker-state', queryParameters: {'workerId': workerId})
          .timeout(_stateTimeout);
      final data = res.data;
      if (data is! Map) return false;
      await _db.setMeta('opensession:$workerId', (data['openSessionId'] as String?) ?? '');
      await _db.setMeta('loginat:$workerId', (data['loginAt'] as String?) ?? '');
      await _db.setMeta('lasttaptype:$workerId', (data['lastTapType'] as String?) ?? '');
      // A hand-typed punch still waiting on a Safety Officer. Held locally so
      // the scanner can say why this person is not on the list yet, instead of
      // silently offering to enter them a second time.
      final pending = data['pendingManual'];
      await _db.setMeta(
        'pendingmanual:$workerId',
        pending is Map ? (pending['tapType'] as String? ?? '') : '',
      );
      await _mergeLastTap(workerId, data['lastTapAt'] as String?);
      return true;
    } catch (_) {
      // Offline/slow/unauthorised — keep the local view and decide from it.
      return false;
    }
  }

  /// Keep whichever last-tap is later. Devices' clocks differ slightly, and the
  /// cooldown is there to swallow a double scan — erring later never loses a
  /// punch, it only asks the operator to wait a moment longer.
  Future<void> _mergeLastTap(String workerId, String? serverIso) async {
    if (serverIso == null || serverIso.isEmpty) return;
    final server = DateTime.tryParse(serverIso)?.toUtc();
    if (server == null) return;
    final localIso = await _db.getMeta('lasttap:$workerId');
    final local = localIso == null ? null : DateTime.tryParse(localIso)?.toUtc();
    if (local != null && local.isAfter(server)) return;
    await _db.setMeta('lasttap:$workerId', server.toIso8601String());
  }

  /// Replace the cached login state for every worker in one shot. Called when
  /// the device warms its worker cache, so a handset that then goes offline can
  /// still scan out people logged in by other devices.
  Future<void> refreshOpenSessions() async {
    try {
      if (await _db.pendingCount() > 0) return;
      final res = await _api.dio.get('/attendance/open-sessions');
      final rows = (res.data['data'] as List).cast<Map<String, dynamic>>();
      await _db.replaceOpenSessions([
        for (final r in rows)
          if (r['workerId'] is String && r['sessionId'] is String)
            (
              workerId: r['workerId'] as String,
              sessionId: r['sessionId'] as String,
              loginAt: r['loginAt'] as String?,
            ),
      ]);
    } catch (_) {
      // Offline — the per-scan refresh picks this up once there's a network.
    }
  }

  /// Work out what a scan would do — who the worker is, and whether the tap is
  /// a LOGIN, a LOGOUT, a DUPLICATE or a refused EXPIRED card. Writes nothing.
  ///
  /// [preview] and [tap] both go through this, so the action the operator
  /// confirms on screen is the action that gets recorded.
  Future<TapOutcome> _evaluate({
    required String siteId,
    required TapSource source,
    required String identifier,
    required ScanPolicy policy,
    required DateTime now,
    String? overrideReason,
    bool manualBackup = false,
  }) async {
    final worker = await resolve(source, identifier);

    // Whoever scanned them IN may have been a different device, whose login
    // this one never saw. Refresh from the server first so the local meta is
    // the org-wide truth, not just this handset's history — otherwise a worker
    // logged in at gate A gets offered another LOGIN at gate B.
    final fresh = worker == null ? false : await _refreshWorkerState(worker);

    // Decide locally using the last tap recorded for this worker.
    final lastTapIso = worker == null ? null : await _db.getMeta('lasttap:${worker.id}');
    final lastTapType = worker == null ? null : await _db.getMeta('lasttaptype:${worker.id}');
    final openSessionId = worker == null ? null : await _db.getMeta('opensession:${worker.id}');
    final loginAtIso = worker == null ? null : await _db.getMeta('loginat:${worker.id}');
    final hasOpenSession = openSessionId != null && openSessionId.isNotEmpty;

    final decision = decideTap(
      tapTime: now,
      cooldownSeconds: policy.cooldownSeconds,
      openSession: !hasOpenSession
          ? null
          : OpenSession(
              id: openSessionId,
              // No cached login time means the session predates this build or
              // came from a device that never recorded one. Falling back to
              // `now` reads as "just changed", which would refuse a legitimate
              // logout; treating it as long ago lets the scan through and
              // leaves the server — which does know — to have the final word.
              loginAt: DateTime.tryParse(loginAtIso ?? '')?.toUtc() ??
                  now.subtract(const Duration(days: 1)),
              siteId: siteId,
            ),
      lastTapTime: lastTapIso == null ? null : DateTime.tryParse(lastTapIso),
      lastTapType: lastTapType == null || lastTapType.isEmpty ? null : lastTapType,
      safetyGapSeconds: _safetyGapSecondsFor(worker, policy, overrideReason),
    );

    if (decision.action == TapAction.duplicate) {
      return TapOutcome(
        action: TapAction.duplicate,
        worker: worker,
        cooldownRemainingSeconds: decision.cooldownRemainingSeconds,
        stateIsStale: !fresh,
      );
    }

    if (decision.action == TapAction.tooSoon) {
      return TapOutcome(
        action: TapAction.tooSoon,
        worker: worker,
        blocked: decision.blocked,
        remainingSeconds: decision.remainingSeconds,
        elapsedMinutes: decision.elapsedMinutes,
        stateIsStale: !fresh,
      );
    }

    // An expired ID card may not start a shift. Refused before the durable
    // write, so nothing is queued and nothing is ever synced — the server
    // enforces the same rule for taps that reach it another way.
    // A logout is always allowed: never trap a worker inside the gate.
    if (decision.action == TapAction.login &&
        worker != null &&
        isCardExpired(worker.validityTill, now.toLocal())) {
      final on = worker.validityTill!.toIso8601String().substring(0, 10);
      return TapOutcome(
        action: TapAction.expired,
        worker: worker,
        message: "${worker.fullName}'s ID card expired on $on. Renew the card before logging in.",
        stateIsStale: !fresh,
      );
    }

    // Someone already typed this person in and the Safety Officer has not ruled
    // on it. A second hand-typed entry would stack two un-reviewed punches
    // against one man, so it is refused here rather than at the server.
    final waiting = worker == null ? null : await _db.getMeta('pendingmanual:${worker.id}');
    if (manualBackup && waiting != null && waiting.isNotEmpty) {
      return TapOutcome(
        action: TapAction.awaitingReview,
        worker: worker,
        message:
            'A manual ${waiting == 'LOGIN' ? 'login' : 'logout'} for ${worker!.fullName} is '
            'already waiting for the Safety Officer to accept it.',
        stateIsStale: !fresh,
      );
    }

    // Typed in by hand: this says what the punch MEANS, not what it records.
    // Nothing goes on the register until someone with review rights accepts it.
    if (manualBackup) {
      return TapOutcome(
        action: TapAction.pendingApproval,
        worker: worker,
        blocked: decision.action,
        stateIsStale: !fresh,
      );
    }

    return TapOutcome(
      action: decision.action,
      worker: worker,
      message: worker == null ? 'Unknown card — will resolve on sync' : null,
      stateIsStale: !fresh,
    );
  }

  /// The safety gap in force for this scan, mirroring the server's rule.
  ///
  /// Visitors are exempt: a day pass is recorded for the register, and a
  /// ten-minute visit is a normal visit. An override lifts it for one scan —
  /// the watchman has read the refusal and given a reason.
  int _safetyGapSecondsFor(WorkerCard? worker, ScanPolicy policy, String? overrideReason) {
    if (overrideReason != null && overrideReason.isNotEmpty) return 0;
    if (worker?.category == 'VISITOR') return 0;
    return policy.safetyGapSeconds;
  }

  /// Dry run of [tap] for the confirmation prompt: says what the scan would
  /// record without recording it. Nothing is queued, no session is opened or
  /// closed — call [tap] once the operator presses OK.
  Future<TapOutcome> preview({
    required String siteId,
    required TapSource source,
    required String identifier,
    required ScanPolicy policy,
  }) {
    return _evaluate(
      siteId: siteId,
      source: source,
      identifier: identifier,
      policy: policy,
      now: DateTime.now().toUtc(),
    );
  }

  /// Core offline-first tap: resolve locally → decide → persist to outbox →
  /// (best-effort) push to server. Cooldown + duplicate handled locally too.
  Future<TapOutcome> tap({
    required String siteId,
    required String deviceId,
    required TapSource source,
    required String identifier,
    required ScanPolicy policy,
    bool manualBackup = false,
    String? manualReason,
    String? overrideReason,
  }) async {
    final now = DateTime.now().toUtc();
    final outcome = await _evaluate(
      siteId: siteId,
      source: source,
      identifier: identifier,
      policy: policy,
      now: now,
      overrideReason: overrideReason,
      manualBackup: manualBackup,
    );
    // Refusals (duplicate tap, safety gap, expired card, a manual entry already
    // waiting on review) never reach the outbox.
    if (outcome.action == TapAction.duplicate ||
        outcome.action == TapAction.tooSoon ||
        outcome.action == TapAction.expired ||
        outcome.action == TapAction.awaitingReview) {
      return outcome;
    }
    final worker = outcome.worker;

    GeoFix? geo;
    try {
      geo = await _location.current();
    } catch (_) {
      geo = null;
    }

    final event = OutboxEvent(
      eventId: _uuid.v4(),
      siteId: siteId,
      deviceId: deviceId,
      source: source,
      identifier: identifier,
      clientEventTime: now,
      lat: geo?.lat,
      lng: geo?.lng,
      accuracyM: geo?.accuracyM,
      isManualBackup: manualBackup,
      manualReason: manualReason,
      overrideReason: overrideReason,
    );

    // What this device believed before the tap. Kept so a server refusal can
    // put it back — otherwise the phone would go on showing a worker as logged
    // out when the server never accepted the logout.
    final previous = worker == null
        ? null
        : (
            openSession: await _db.getMeta('opensession:${worker.id}') ?? '',
            loginAt: await _db.getMeta('loginat:${worker.id}') ?? '',
            lastTap: await _db.getMeta('lasttap:${worker.id}') ?? '',
            lastTapType: await _db.getMeta('lasttaptype:${worker.id}') ?? '',
            pendingManual: await _db.getMeta('pendingmanual:${worker.id}') ?? '',
          );

    // 1) DURABLE write FIRST — this is what guarantees "no attendance loss".
    await _db.enqueue(event);
    if (worker != null) {
      await _db.setMeta('lasttap:${worker.id}', now.toIso8601String());
      if (manualBackup) {
        // A hand-typed punch changes nothing until a Safety Officer accepts it,
        // so this phone's view of who is on site must not move either. Only the
        // last-tap time is kept, so the cooldown still swallows a double entry.
        await _db.setMeta('pendingmanual:${worker.id}',
            outcome.blocked == TapAction.logout ? 'LOGOUT' : 'LOGIN');
      } else if (outcome.action == TapAction.login) {
        await _db.setMeta('lasttaptype:${worker.id}', 'LOGIN');
        await _db.setMeta('opensession:${worker.id}', event.eventId);
        // The safety gap runs from here until the server says otherwise.
        await _db.setMeta('loginat:${worker.id}', now.toIso8601String());
      } else {
        await _db.setMeta('lasttaptype:${worker.id}', 'LOGOUT');
        await _db.setMeta('opensession:${worker.id}', '');
        await _db.setMeta('loginat:${worker.id}', '');
      }
    }

    // 2) Best-effort immediate push; failures are fine — the sync engine retries.
    var recorded = outcome;
    try {
      final res = await _api.dio.post('/attendance/tap', data: event.toJson());
      // MANUAL verification sites defer the session until the device confirms.
      // Scanning the badge IS the verification here, so confirm right away —
      // otherwise the login never becomes a session on the server.
      final data = res.data;
      if (data is Map && data['result'] == 'LOGIN_PENDING_CONFIRM') {
        await _api.dio.post('/attendance/confirm', data: {'eventId': event.eventId});
      }
      await _db.markSynced(event.eventId);
      // The server decides in/out from every device's taps, not just this one.
      // If it disagrees with the local guess, it wins — both in the local meta
      // and in what the operator is told was recorded.
      if (data is Map && worker != null) {
        recorded = await _reconcile(outcome, worker, data);
      }
    } on DioException catch (e) {
      final refusal = await _handleRefusal(e, event, worker, previous);
      if (refusal != null) return refusal;
      // Stays pending — the sync engine retries and the server auto-confirms
      // offline-ingested logins.
      await _db.recordFailure(event.eventId, e.message ?? 'network');
    }

    return recorded;
  }

  /// The server said no to a tap this device had already accepted locally.
  ///
  /// Three answers mean that: the tap fell inside the duplicate cooldown, inside
  /// the safety gap, or a hand-typed punch for this person is already waiting on
  /// a Safety Officer. All are final — retrying cannot change them — so the
  /// event is dropped rather than left to the sync engine, and the local view is
  /// wound back to what it was before the scan. Returns null for anything else
  /// (a network blip, a 5xx), which the caller retries as before.
  Future<TapOutcome?> _handleRefusal(
    DioException e,
    OutboxEvent event,
    WorkerCard? worker,
    ({
      String openSession,
      String loginAt,
      String lastTap,
      String lastTapType,
      String pendingManual,
    })? previous,
  ) async {
    final body = e.response?.data;
    final code = body is Map ? body['code'] : null;
    if (code != 'TAP_TOO_SOON' && code != 'DUPLICATE_TAP' && code != 'MANUAL_REVIEW_PENDING') {
      return null;
    }

    await _db.discard(event.eventId);
    if (worker != null && previous != null) {
      await _db.setMeta('opensession:${worker.id}', previous.openSession);
      await _db.setMeta('loginat:${worker.id}', previous.loginAt);
      await _db.setMeta('lasttap:${worker.id}', previous.lastTap);
      await _db.setMeta('lasttaptype:${worker.id}', previous.lastTapType);
      await _db.setMeta('pendingmanual:${worker.id}', previous.pendingManual);
    }

    final meta = body is Map && body['meta'] is Map ? body['meta'] as Map : const {};
    if (code == 'DUPLICATE_TAP') {
      return TapOutcome(
        action: TapAction.duplicate,
        worker: worker,
        cooldownRemainingSeconds: (meta['cooldownRemainingSeconds'] as num?)?.toInt() ?? 0,
      );
    }
    if (code == 'MANUAL_REVIEW_PENDING') {
      // The other gate got there first. Remember it, so this phone refuses the
      // next one without a round trip.
      if (worker != null) {
        await _db.setMeta('pendingmanual:${worker.id}', (meta['tapType'] as String?) ?? 'LOGIN');
      }
      return TapOutcome(
        action: TapAction.awaitingReview,
        worker: worker,
        message: body is Map ? body['detail'] as String? : null,
      );
    }
    return TapOutcome(
      action: TapAction.tooSoon,
      worker: worker,
      blocked: meta['blocked'] == 'LOGIN' ? TapAction.login : TapAction.logout,
      remainingSeconds: (meta['remainingSeconds'] as num?)?.toInt() ?? 0,
      elapsedMinutes: (meta['elapsedMinutes'] as num?)?.toInt() ?? 0,
      message: body is Map ? body['detail'] as String? : null,
    );
  }

  /// Align the local view with what the server actually recorded for this tap.
  /// Returns the outcome to show the operator — corrected when the server made
  /// the opposite call (a login this device never saw makes the scan a LOGOUT).
  Future<TapOutcome> _reconcile(
    TapOutcome local,
    WorkerCard worker,
    Map<dynamic, dynamic> data,
  ) async {
    final result = data['result'];
    final sessionId = data['sessionId'];
    if (result == 'MANUAL_PENDING_APPROVAL') {
      // Filed, not recorded. Attendance has not moved, so neither does the local
      // view — only the note that this person is waiting on a decision.
      await _db.setMeta('pendingmanual:${worker.id}', (data['tapType'] as String?) ?? 'LOGIN');
      return TapOutcome(
        action: TapAction.pendingApproval,
        worker: worker,
        blocked: data['tapType'] == 'LOGOUT' ? TapAction.logout : TapAction.login,
      );
    }
    if (result == 'LOGOUT_RECORDED') {
      await _db.setMeta('opensession:${worker.id}', '');
      await _db.setMeta('loginat:${worker.id}', '');
      await _db.setMeta('lasttaptype:${worker.id}', 'LOGOUT');
      if (local.action == TapAction.logout) return local;
      return local.copyWith(action: TapAction.logout, worker: worker);
    }
    if (result == 'LOGIN_RECORDED' || result == 'LOGIN_PENDING_CONFIRM') {
      if (sessionId is String) await _db.setMeta('opensession:${worker.id}', sessionId);
      if (data['loginAt'] is String) {
        await _db.setMeta('loginat:${worker.id}', data['loginAt'] as String);
      }
      await _db.setMeta('lasttaptype:${worker.id}', 'LOGIN');
      if (local.action == TapAction.login) return local;
      return local.copyWith(action: TapAction.login, worker: worker);
    }
    return local;
  }

  /// Manual-backup search. Hits the server (finds any worker in the org, not
  /// just the site cache) and falls back to the offline cache when there's no
  /// network — so a name/code always resolves when online.
  Future<List<WorkerCard>> search(String q) async {
    try {
      final res = await _api.dio.get('/workers/search', queryParameters: {'q': q});
      final data = res.data;
      if (data is List) {
        return data.cast<Map<String, dynamic>>().map(WorkerCard.fromMap).toList();
      }
    } catch (_) {
      // Offline or error — use the cached site list.
    }
    return _db.search(q);
  }

  Future<int> pendingCount() => _db.pendingCount();
}
