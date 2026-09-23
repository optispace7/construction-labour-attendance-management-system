import 'dart:async';

import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

import '../../../core/geo/location_service.dart';
import '../../../core/network/api_client.dart';
import '../domain/models.dart';

/// What a scan did — or, from [AttendanceRepository.preview], would do. Every
/// field comes from the server's answer; nothing is decided on the phone.
class TapOutcome {
  const TapOutcome({
    required this.action,
    this.worker,
    this.cooldownRemainingSeconds = 0,
    this.message,
    this.blocked,
    this.remainingSeconds = 0,
    this.elapsedMinutes = 0,
  });
  final TapAction action;
  final WorkerCard? worker;
  final int cooldownRemainingSeconds;
  final String? message;

  /// For [TapAction.tooSoon] and [TapAction.pendingApproval]: the LOGIN or
  /// LOGOUT the scan is about. For too-soon, also how long the worker has been
  /// in their current state and how long until the scan would be accepted.
  final TapAction? blocked;
  final int remainingSeconds;
  final int elapsedMinutes;
}

/// The gate's calls to the server. The phone keeps no attendance of its own: a
/// scan is previewed by the server, recorded by the server, or not recorded.
class AttendanceRepository {
  AttendanceRepository(this._api, this._location);
  final ApiClient _api;
  final LocationService _location;
  final _uuid = const Uuid();

  /// How long the gate waits on the server before calling it no connection.
  /// Long enough for a slow site network, short enough that nobody is left
  /// standing at the gate wondering.
  static const _timeout = Duration(seconds: 10);

  /// What scanning this badge would record, asked before the confirm screen
  /// opens. Writes nothing.
  Future<TapOutcome> preview({
    required String siteId,
    required TapSource source,
    required String identifier,
  }) async {
    try {
      final res = await _api.dio.post('/attendance/tap/preview', data: {
        'siteId': siteId,
        'source': source.wire,
        'identifier': identifier,
      }).timeout(_timeout);
      return outcomeFromPreview(res.data);
    } on DioException catch (e) {
      return outcomeFromError(e.response?.statusCode, e.response?.data);
    } on TimeoutException {
      return const TapOutcome(action: TapAction.offline);
    }
  }

  /// Record a scan. The server decides LOGIN or LOGOUT again as it writes: if
  /// another gate scanned the same person since the preview, its answer is the
  /// one returned, and the one the watchman is shown.
  ///
  /// A request that gets no answer is sent once more with the same event id.
  /// The server treats a repeated id as the same scan, so one that did land but
  /// lost its reply comes back as recorded rather than as a second punch.
  Future<TapOutcome> tap({
    required String siteId,
    required String deviceId,
    required TapSource source,
    required String identifier,
    WorkerCard? worker,
    bool manualBackup = false,
    String? manualReason,
    bool overridden = false,
    TapAction? expected,
  }) async {
    GeoFix? geo;
    try {
      geo = await _location.current();
    } catch (_) {
      geo = null;
    }

    final eventId = _uuid.v4();
    final body = <String, dynamic>{
      'eventId': eventId,
      'siteId': siteId,
      'deviceId': deviceId,
      'source': source.wire,
      'identifier': identifier,
      'clientEventTime': DateTime.now().toUtc().toIso8601String(),
      if (geo != null) 'geo': {'lat': geo.lat, 'lng': geo.lng, 'accuracyM': geo.accuracyM},
      'manual': {'isBackup': manualBackup, 'reason': manualReason},
      if (overridden) 'override': <String, dynamic>{},
      // What the watchman confirmed. The server records the scan only if it is
      // still that, so a late copy of a double read cannot flip the worker
      // back the other way.
      if (expected == TapAction.login) 'expected': 'LOGIN',
      if (expected == TapAction.logout) 'expected': 'LOGOUT',
    };

    for (var attempt = 1;; attempt++) {
      try {
        final res = await _api.dio.post('/attendance/tap', data: body).timeout(_timeout);
        var data = res.data;
        // A site on manual verification holds a login until the device confirms
        // it. Scanning the badge is the verification, so confirm at once —
        // otherwise the login never becomes a session. A replayed login is
        // confirmed too: the first attempt may have landed and lost its confirm.
        if (!manualBackup && data is Map && _needsConfirm(data)) {
          final confirmed = await _api.dio
              .post('/attendance/confirm', data: {'eventId': eventId})
              .timeout(_timeout);
          data = confirmed.data;
        }
        return outcomeFromTap(data, worker: worker, manualBackup: manualBackup);
      } on DioException catch (e) {
        if (e.response == null && attempt == 1) continue;
        return outcomeFromError(
          e.response?.statusCode,
          e.response?.data,
          worker: worker,
          unsure: attempt > 1,
        );
      } on TimeoutException {
        if (attempt == 1) continue;
        return TapOutcome(action: TapAction.offline, worker: worker, message: _noAnswer);
      }
    }
  }

  bool _needsConfirm(Map<dynamic, dynamic> data) =>
      data['result'] == 'LOGIN_PENDING_CONFIRM' ||
      (data['result'] == 'IDEMPOTENT_REPLAY' && data['tapType'] == 'LOGIN');

  /// Manual-entry search, on the server. Null when it could not be reached, so
  /// the sheet can say so rather than show an empty list as "nobody found".
  Future<List<WorkerCard>?> search(String q) async {
    try {
      final res = await _api.dio
          .get('/workers/search', queryParameters: {'q': q})
          .timeout(_timeout);
      final data = res.data;
      if (data is! List) return const [];
      return data
          .whereType<Map<dynamic, dynamic>>()
          .map((m) => WorkerCard.fromMap(Map<String, dynamic>.from(m)))
          .toList();
    } catch (_) {
      return null;
    }
  }
}

const _unexpected = TapOutcome(
  action: TapAction.failed,
  message: 'Unexpected reply from the server. Nothing was recorded.',
);

const _noAnswer = 'The server did not answer. When the connection is back, scan again — '
    'a scan that did get through shows as scanned a moment ago.';

/// The preview's answer, as the confirm screen needs it.
TapOutcome outcomeFromPreview(Object? data) {
  if (data is! Map) return _unexpected;
  final worker = _workerIn(data);
  return switch (data['action']) {
    'LOGIN' when worker != null => TapOutcome(action: TapAction.login, worker: worker),
    'LOGOUT' when worker != null => TapOutcome(action: TapAction.logout, worker: worker),
    'DUPLICATE' => TapOutcome(
        action: TapAction.duplicate,
        worker: worker,
        blocked: _direction(data['blocked']),
        cooldownRemainingSeconds: _int(data['cooldownRemainingSeconds']),
      ),
    'TOO_SOON' => TapOutcome(
        action: TapAction.tooSoon,
        worker: worker,
        blocked: _direction(data['blocked']),
        remainingSeconds: _int(data['remainingSeconds']),
        elapsedMinutes: _int(data['elapsedMinutes']),
      ),
    'CARD_EXPIRED' =>
      TapOutcome(action: TapAction.expired, worker: worker, message: data['detail'] as String?),
    'UNKNOWN_WORKER' => const TapOutcome(action: TapAction.notFound),
    _ => _unexpected,
  };
}

/// What the scan recorded, from the tap (or confirm) reply.
TapOutcome outcomeFromTap(Object? data, {WorkerCard? worker, bool manualBackup = false}) {
  if (data is! Map) return _unexpected;
  final card = _workerIn(data) ?? worker;
  final result = data['result'];
  if (result == 'MANUAL_PENDING_APPROVAL' || (manualBackup && result == 'IDEMPOTENT_REPLAY')) {
    return TapOutcome(
      action: TapAction.pendingApproval,
      worker: card,
      blocked: _direction(data['tapType']),
    );
  }
  return switch (result) {
    'LOGIN_RECORDED' => TapOutcome(action: TapAction.login, worker: card),
    'LOGOUT_RECORDED' => TapOutcome(action: TapAction.logout, worker: card),
    'IDEMPOTENT_REPLAY' when _direction(data['tapType']) != null =>
      TapOutcome(action: _direction(data['tapType'])!, worker: card),
    _ => _unexpected,
  };
}

/// A refusal, or no answer at all ([status] null). [unsure] is set when the
/// scan was already sent once without a reply, so it may have landed.
TapOutcome outcomeFromError(
  int? status,
  Object? body, {
  WorkerCard? worker,
  bool unsure = false,
}) {
  if (status == null) {
    return TapOutcome(
      action: TapAction.offline,
      worker: worker,
      message: unsure ? _noAnswer : null,
    );
  }
  final Map<dynamic, dynamic> map = body is Map ? body : const {};
  final Map<dynamic, dynamic> meta = map['meta'] is Map ? map['meta'] as Map : const {};
  final detail = (map['detail'] as String?) ?? (map['title'] as String?);
  switch (map['code']) {
    case 'DUPLICATE_TAP':
      return TapOutcome(
        action: TapAction.duplicate,
        worker: worker,
        cooldownRemainingSeconds: _int(meta['cooldownRemainingSeconds']),
      );
    case 'TAP_TOO_SOON':
      return TapOutcome(
        action: TapAction.tooSoon,
        worker: worker,
        blocked: _direction(meta['blocked']) ?? TapAction.logout,
        remainingSeconds: _int(meta['remainingSeconds']),
        elapsedMinutes: _int(meta['elapsedMinutes']),
        message: detail,
      );
    case 'MANUAL_REVIEW_PENDING':
      return TapOutcome(action: TapAction.awaitingReview, worker: worker, message: detail);
    case 'CARD_EXPIRED':
      return TapOutcome(action: TapAction.expired, worker: worker, message: detail);
    case 'WORKER_NOT_FOUND':
      return TapOutcome(action: TapAction.notFound, worker: worker);
    // Already logged in/out by the time the scan arrived. Nothing was changed,
    // and the server's sentence says so in the watchman's terms.
    case 'TAP_STATE_CHANGED':
      return TapOutcome(action: TapAction.failed, worker: worker, message: detail);
  }
  return TapOutcome(
    action: TapAction.failed,
    worker: worker,
    message: detail ?? 'The server refused this scan (HTTP $status). Nothing was recorded.',
  );
}

WorkerCard? _workerIn(Map<dynamic, dynamic> data) {
  final w = data['worker'];
  return w is Map ? WorkerCard.fromMap(Map<String, dynamic>.from(w)) : null;
}

int _int(Object? v) => v is num ? v.toInt() : 0;

TapAction? _direction(Object? v) => switch (v) {
      'LOGIN' => TapAction.login,
      'LOGOUT' => TapAction.logout,
      _ => null,
    };
