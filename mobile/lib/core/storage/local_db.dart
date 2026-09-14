import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

/// The phone's own small store of settings: the active site, this phone's
/// device uid, the badge print size, the notifications already shown.
///
/// Attendance is not kept here. Every scan goes to the server or is not
/// recorded at all, so there is no second copy of who is on site to fall out of
/// step with the real one. The outbox and worker cache that an offline build of
/// the app created are only read once, to send what they still hold — see
/// [LegacyOutboxDrain] — and are then dropped.
class LocalDb {
  LocalDb._(this._db);
  final Database _db;

  static Future<LocalDb> open() async {
    final dir = await getApplicationDocumentsDirectory();
    final path = p.join(dir.path, 'clams.db');
    final db = await openDatabase(
      path,
      // Unchanged from the offline build, so an existing install opens its
      // file as it is and keeps the tables the drain still has to read.
      version: 4,
      onCreate: (db, _) async {
        await db.execute('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)');
      },
    );
    return LocalDb._(db);
  }

  // ---- Meta ----------------------------------------------------------------
  Future<void> setMeta(String key, String value) async {
    await _db.insert('meta', {'k': key, 'v': value},
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<String?> getMeta(String key) async {
    final rows = await _db.query('meta', where: 'k = ?', whereArgs: [key], limit: 1);
    return rows.isEmpty ? null : rows.first['v'] as String?;
  }

  // ---- Left behind by the offline build ------------------------------------
  // Delete with LegacyOutboxDrain once no phone is left on an offline build.

  Future<bool> _hasTable(String name) async {
    final rows = await _db.rawQuery(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return rows.isNotEmpty;
  }

  /// Scans the offline build saved and never sent, oldest first.
  Future<List<Map<String, Object?>>> legacyUnsent({int limit = 200}) async {
    if (!await _hasTable('outbox')) return const [];
    return _db.query(
      'outbox',
      where: 'synced = 0',
      orderBy: 'client_event_time ASC',
      limit: limit,
    );
  }

  Future<int> legacyUnsentCount() async {
    if (!await _hasTable('outbox')) return 0;
    final r = await _db.rawQuery('SELECT COUNT(*) c FROM outbox WHERE synced = 0');
    return Sqflite.firstIntValue(r) ?? 0;
  }

  Future<void> removeLegacy(String eventId) async {
    await _db.delete('outbox', where: 'event_id = ?', whereArgs: [eventId]);
  }

  /// Everything the offline build kept about attendance: the outbox, the worker
  /// cache, and its copy of each worker's state and the site's scan rules.
  /// Only called once the outbox is empty.
  Future<void> dropOfflineData() async {
    await _db.transaction((txn) async {
      await txn.execute('DROP TABLE IF EXISTS outbox');
      await txn.execute('DROP TABLE IF EXISTS cached_workers');
      for (final prefix in const [
        'opensession:',
        'loginat:',
        'lasttap:',
        'lasttaptype:',
        'pendingmanual:',
        'policy:',
      ]) {
        await txn.delete('meta', where: 'k LIKE ?', whereArgs: ['$prefix%']);
      }
    });
  }
}
