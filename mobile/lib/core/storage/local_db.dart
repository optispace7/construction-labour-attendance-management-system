import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import '../../features/attendance/domain/models.dart';

/// Local SQLite store (the offline-first backbone). Every tap is written here
/// durably BEFORE any success UI, then synced. Nothing is ever lost.
class LocalDb {
  LocalDb._(this._db);
  final Database _db;

  static Future<LocalDb> open() async {
    final dir = await getApplicationDocumentsDirectory();
    final path = p.join(dir.path, 'clams.db');
    final db = await openDatabase(
      path,
      version: 4,
      onUpgrade: (db, oldVersion, _) async {
        if (oldVersion < 2) {
          await db.execute('ALTER TABLE cached_workers ADD COLUMN vendor_name TEXT');
          await db.execute('ALTER TABLE cached_workers ADD COLUMN designation_name TEXT');
          await db.execute('ALTER TABLE cached_workers ADD COLUMN category TEXT');
        }
        if (oldVersion < 3) {
          // Null for every existing row, i.e. "no expiry", until the next
          // roster sync fills it in. Never locks anyone out on upgrade.
          await db.execute('ALTER TABLE cached_workers ADD COLUMN validity_till TEXT');
        }
        if (oldVersion < 4) {
          // Null on every queued event, i.e. "not overridden" — an upgrade must
          // never change what an already-recorded punch means.
          await db.execute('ALTER TABLE outbox ADD COLUMN override_reason TEXT');
        }
      },
      onCreate: (db, _) async {
        await db.execute('''
          CREATE TABLE outbox (
            event_id TEXT PRIMARY KEY,
            site_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            source TEXT NOT NULL,
            identifier TEXT NOT NULL,
            client_event_time TEXT NOT NULL,
            lat REAL, lng REAL, accuracy_m REAL,
            is_manual_backup INTEGER NOT NULL DEFAULT 0,
            manual_reason TEXT,
            override_reason TEXT,
            synced INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
          )''');
        await db.execute('''
          CREATE TABLE cached_workers (
            id TEXT PRIMARY KEY,
            worker_code TEXT,
            full_name TEXT,
            photo_url TEXT,
            blood_group TEXT,
            emergency_contact_name TEXT,
            emergency_contact_number TEXT,
            nfc_uid TEXT,
            qr_identifier TEXT,
            vendor_name TEXT,
            designation_name TEXT,
            category TEXT,
            validity_till TEXT
          )''');
        await db.execute(
          'CREATE INDEX ix_cached_uid ON cached_workers(nfc_uid)',
        );
        await db.execute('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)');
      },
    );
    return LocalDb._(db);
  }

  // ---- Outbox --------------------------------------------------------------
  Future<void> enqueue(OutboxEvent e) async {
    await _db.insert(
      'outbox',
      {
        'event_id': e.eventId,
        'site_id': e.siteId,
        'device_id': e.deviceId,
        'source': e.source.wire,
        'identifier': e.identifier,
        'client_event_time': e.clientEventTime.toUtc().toIso8601String(),
        'lat': e.lat,
        'lng': e.lng,
        'accuracy_m': e.accuracyM,
        'is_manual_backup': e.isManualBackup ? 1 : 0,
        'manual_reason': e.manualReason,
        'override_reason': e.overridden ? '1' : null,
        'synced': 0,
        'attempts': 0,
      },
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
  }

  Future<List<Map<String, dynamic>>> unsynced({int limit = 100}) {
    return _db.query('outbox', where: 'synced = 0', orderBy: 'client_event_time ASC', limit: limit);
  }

  Future<void> markSynced(String eventId) async {
    await _db.update('outbox', {'synced': 1}, where: 'event_id = ?', whereArgs: [eventId]);
  }

  Future<void> recordFailure(String eventId, String error) async {
    await _db.rawUpdate(
      'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE event_id = ?',
      [error, eventId],
    );
  }

  /// Drop an event the server has finally refused.
  ///
  /// Marking it synced would be a lie, and leaving it pending is worse than it
  /// looks: a single event the server will never accept keeps [pendingCount]
  /// above zero for good, and this device stops asking the server who is on site
  /// — so every later scan is decided from its own history alone.
  Future<void> discard(String eventId) async {
    await _db.delete('outbox', where: 'event_id = ?', whereArgs: [eventId]);
  }

  Future<int> pendingCount() async {
    final r = await _db.rawQuery('SELECT COUNT(*) c FROM outbox WHERE synced = 0');
    return Sqflite.firstIntValue(r) ?? 0;
  }

  /// Unsent punches for one particular person.
  ///
  /// The server's view of a worker is only staler than this device's while this
  /// device is holding punches for *that* worker. Anyone else's queue says
  /// nothing about them, so the in/out decision asks this rather than
  /// [pendingCount] — otherwise one stuck event anywhere blinds the device to
  /// every other gate and to Super Admin fixes in the panel.
  Future<int> pendingCountForIdentifiers(List<String> identifiers) async {
    final ids = identifiers.where((s) => s.isNotEmpty).toList();
    if (ids.isEmpty) return 0;
    final placeholders = List.filled(ids.length, '?').join(',');
    final r = await _db.rawQuery(
      'SELECT COUNT(*) c FROM outbox WHERE synced = 0 AND identifier IN ($placeholders)',
      ids,
    );
    return Sqflite.firstIntValue(r) ?? 0;
  }

  // ---- Cached workers ------------------------------------------------------
  Future<void> cacheWorkers(List<WorkerCard> workers) async {
    final batch = _db.batch();
    for (final w in workers) {
      batch.insert('cached_workers', w.toCacheRow(),
          conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  /// Full cache refresh: clears stale entries (deleted/edited workers) and
  /// replaces them with the fresh server list, atomically.
  Future<void> replaceWorkers(List<WorkerCard> workers) async {
    await _db.transaction((txn) async {
      await txn.delete('cached_workers');
      final batch = txn.batch();
      for (final w in workers) {
        batch.insert('cached_workers', w.toCacheRow(),
            conflictAlgorithm: ConflictAlgorithm.replace);
      }
      await batch.commit(noResult: true);
    });
  }

  Future<WorkerCard?> findByUid(String uid) =>
      _findOne('nfc_uid = ?', [uid]);
  Future<WorkerCard?> findByQr(String qr) =>
      _findOne('qr_identifier = ?', [qr]);
  Future<WorkerCard?> findByCode(String code) =>
      _findOne('worker_code = ?', [code]);

  Future<List<WorkerCard>> search(String q) async {
    final rows = await _db.query(
      'cached_workers',
      where: 'full_name LIKE ? OR worker_code LIKE ?',
      whereArgs: ['%$q%', '%$q%'],
      limit: 25,
    );
    return rows.map(_toCard).toList();
  }

  Future<WorkerCard?> _findOne(String where, List<Object?> args) async {
    final rows = await _db.query('cached_workers', where: where, whereArgs: args, limit: 1);
    if (rows.isEmpty) return null;
    return _toCard(rows.first);
  }

  WorkerCard _toCard(Map<String, dynamic> m) => WorkerCard.fromMap(m);

  // ---- Meta ----------------------------------------------------------------
  Future<void> setMeta(String key, String value) async {
    await _db.insert('meta', {'k': key, 'v': value},
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<String?> getMeta(String key) async {
    final rows = await _db.query('meta', where: 'k = ?', whereArgs: [key], limit: 1);
    return rows.isEmpty ? null : rows.first['v'] as String?;
  }

  /// Swap the whole open-session set for the server's list, in one transaction.
  /// Dropping the old keys is the point: a worker scanned out on another device
  /// must stop looking logged in here.
  ///
  /// The login time rides along with the session id because the safety gap is
  /// measured from it — without it the device cannot tell a worker who arrived
  /// two minutes ago from one who has been on site since dawn.
  Future<void> replaceOpenSessions(
    List<({String workerId, String sessionId, String? loginAt})> rows,
  ) async {
    await _db.transaction((txn) async {
      await txn.delete('meta', where: "k LIKE 'opensession:%'");
      await txn.delete('meta', where: "k LIKE 'loginat:%'");
      final batch = txn.batch();
      for (final r in rows) {
        batch.insert('meta', {'k': 'opensession:${r.workerId}', 'v': r.sessionId},
            conflictAlgorithm: ConflictAlgorithm.replace);
        if (r.loginAt != null) {
          batch.insert('meta', {'k': 'loginat:${r.workerId}', 'v': r.loginAt!},
              conflictAlgorithm: ConflictAlgorithm.replace);
        }
      }
      await batch.commit(noResult: true);
    });
  }
}
