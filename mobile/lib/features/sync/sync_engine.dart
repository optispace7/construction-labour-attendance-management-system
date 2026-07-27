import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/local_db.dart';

/// Drains the durable outbox to the server. Idempotent: every event carries a
/// stable eventId so replays never create duplicates. Conflicts are surfaced,
/// never silently dropped.
class SyncEngine {
  SyncEngine(this._db, this._api);
  final LocalDb _db;
  final ApiClient _api;
  bool _running = false;

  Future<SyncReport> syncNow() async {
    if (_running) return const SyncReport(skipped: true);
    _running = true;
    try {
      final connectivity = await Connectivity().checkConnectivity();
      if (connectivity.contains(ConnectivityResult.none)) {
        return const SyncReport(offline: true);
      }

      final pending = await _db.unsynced(limit: 200);
      if (pending.isEmpty) return const SyncReport();

      final deviceId = pending.first['device_id'] as String;
      final events = pending.map(_rowToEvent).toList();

      try {
        final res = await _api.dio.post('/attendance/sync', data: {
          'deviceId': deviceId,
          'events': events,
        });
        final results = (res.data['results'] as List).cast<Map<String, dynamic>>();
        var accepted = 0, duplicates = 0, conflicts = 0;
        for (final r in results) {
          final status = r['status'] as String;
          final eventId = r['eventId'] as String;
          if (status == 'ACCEPTED' || status == 'DUPLICATE') {
            await _db.markSynced(eventId);
            status == 'ACCEPTED' ? accepted++ : duplicates++;
          } else if (status == 'CONFLICT') {
            await _db.recordFailure(eventId, 'CONFLICT: ${r['detail'] ?? ''}');
            conflicts++;
          } else {
            await _db.recordFailure(eventId, 'REJECTED: ${r['detail'] ?? ''}');
          }
        }
        return SyncReport(accepted: accepted, duplicates: duplicates, conflicts: conflicts);
      } on DioException catch (e) {
        return SyncReport(error: e.message ?? 'sync failed');
      }
    } finally {
      _running = false;
    }
  }

  Map<String, dynamic> _rowToEvent(Map<String, dynamic> row) {
    final lat = row['lat'] as double?;
    final lng = row['lng'] as double?;
    return {
      'eventId': row['event_id'],
      'siteId': row['site_id'],
      'deviceId': row['device_id'],
      'source': row['source'],
      'identifier': row['identifier'],
      'clientEventTime': row['client_event_time'],
      if (lat != null && lng != null)
        'geo': {'lat': lat, 'lng': lng, if (row['accuracy_m'] != null) 'accuracyM': row['accuracy_m']},
      'manual': {
        'isBackup': (row['is_manual_backup'] as int) == 1,
        'reason': row['manual_reason'],
      },
      // A tap the watchman waved past the safety gap carries his reason all the
      // way to the server, however long it sits in the outbox first.
      if (row['override_reason'] != null)
        'override': {'reason': row['override_reason']},
    };
  }
}

class SyncReport {
  const SyncReport({
    this.accepted = 0,
    this.duplicates = 0,
    this.conflicts = 0,
    this.offline = false,
    this.skipped = false,
    this.error,
  });
  final int accepted;
  final int duplicates;
  final int conflicts;
  final bool offline;
  final bool skipped;
  final String? error;
}
