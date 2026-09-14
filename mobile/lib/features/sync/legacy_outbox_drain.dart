import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/local_db.dart';

/// Sends the scans an offline build of the app saved on this phone, then
/// removes the tables they were kept in.
///
/// The app no longer stores attendance: a scan reaches the server or is not
/// recorded. A phone updated from an offline build may still hold scans that
/// never got through, and dropping them with the table would lose real punches,
/// so they are sent first. The gate stays closed until they have been: a new
/// scan for someone with an older punch still on this phone would be decided
/// against a state the server does not know about yet.
///
/// Delete, with the legacy methods on [LocalDb], once no phone is left on an
/// offline build.
class LegacyOutboxDrain {
  LegacyOutboxDrain(this._db, this._api);
  final LocalDb _db;
  final ApiClient _api;

  static final _uuid = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );

  /// Returns how many saved scans are still unsent: 0 once all of them have
  /// gone and the old tables are dropped, more when the server could not be
  /// reached. [deviceId] is this phone's current id — scans saved before the
  /// phone was registered were stored without a usable one.
  Future<int> drain(String deviceId) async {
    while (true) {
      final pending = await _db.legacyUnsent();
      if (pending.isEmpty) {
        await _db.dropOfflineData();
        return 0;
      }
      try {
        final res = await _api.dio.post('/attendance/sync', data: {
          'deviceId': deviceId,
          'events': pending.map((row) => _rowToEvent(row, deviceId)).toList(),
        });
        final results = (res.data['results'] as List).cast<Map<String, dynamic>>();
        // Every status is the server's final word — ACCEPTED and DUPLICATE are
        // on record, CONFLICT and REJECTED never will be, and the server has
        // kept its own note of what arrived either way. Nothing is retried.
        final sent = results.map((r) => r['eventId'] as String).toSet();
        for (final row in pending) {
          final id = row['event_id'] as String;
          if (sent.contains(id)) await _db.removeLegacy(id);
        }
        // An answer that names none of what was sent would loop forever.
        if (sent.isEmpty) return await _db.legacyUnsentCount();
      } on DioException catch (e) {
        final status = e.response?.statusCode;
        // The batch itself was malformed — a scan saved with a field the server
        // will never accept. The offline build could not send it either and
        // would have held the queue forever; holding the gate forever is worse.
        if (status == 400 || status == 422) {
          for (final row in pending) {
            await _db.removeLegacy(row['event_id'] as String);
          }
          continue;
        }
        // No network, no longer authorised, or the server is down: keep them.
        return _db.legacyUnsentCount();
      }
    }
  }

  Map<String, dynamic> _rowToEvent(Map<String, Object?> row, String deviceId) {
    final lat = row['lat'] as double?;
    final lng = row['lng'] as double?;
    final saved = row['device_id'] as String?;
    return {
      'eventId': row['event_id'],
      'siteId': row['site_id'],
      'deviceId': saved != null && _uuid.hasMatch(saved) ? saved : deviceId,
      'source': row['source'],
      'identifier': row['identifier'],
      'clientEventTime': row['client_event_time'],
      if (lat != null && lng != null)
        'geo': {
          'lat': lat,
          'lng': lng,
          if (row['accuracy_m'] != null) 'accuracyM': row['accuracy_m'],
        },
      'manual': {
        'isBackup': (row['is_manual_backup'] as int? ?? 0) == 1,
        'reason': row['manual_reason'],
      },
      // A scan the watchman waved past a refusal stays overridden, however
      // long it waited — otherwise it would be refused again for the reason he
      // already answered. Absent on outboxes older than the column.
      if (row['override_reason'] != null) 'override': <String, dynamic>{},
    };
  }
}
