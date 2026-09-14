import 'dart:io';

import 'package:android_id/android_id.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

import '../../core/network/api_client.dart';
import '../../core/storage/local_db.dart';
import '../../core/storage/secure_store.dart';

enum DeviceState { authorized, pending, error }

class DeviceStatus {
  const DeviceStatus(this.state, {this.deviceId, this.message});
  final DeviceState state;
  final String? deviceId;
  final String? message;
}

/// Handles the device registration handshake:
///  1. ensure a stable deviceUid (persisted)
///  2. register with the backend (idempotent) -> deviceId
///  3. request a device token; succeeds only once an admin AUTHORIZES the device
/// The token + deviceId are stored for the API client to send on attendance calls.
class DeviceService {
  DeviceService(this._api, this._store, this._db);
  final ApiClient _api;
  final SecureStore _store;
  final LocalDb _db;

  /// Best-effort human-friendly device name (e.g. "samsung SM-A525F") used as the
  /// initial label so the admin panel shows something meaningful instead of the
  /// random UID. Admins can rename it afterwards; we never overwrite that rename.
  Future<String> _deviceName() async {
    try {
      final plugin = DeviceInfoPlugin();
      if (Platform.isAndroid) {
        final info = await plugin.androidInfo;
        final name = '${info.manufacturer} ${info.model}'.trim();
        if (name.isNotEmpty) return name;
      } else if (Platform.isIOS) {
        final info = await plugin.iosInfo;
        return '${info.name} (${info.model})';
      }
    } catch (_) {}
    return 'CLAMS terminal';
  }

  /// A device id that survives app reinstalls (so the device stays authorized
  /// without re-approval). Uses Android's ANDROID_ID — stable per device for a
  /// given signing key. Falls back to a random UUID if unavailable.
  Future<String> _stableDeviceUid() async {
    try {
      if (Platform.isAndroid) {
        final id = await const AndroidId().getId();
        if (id != null && id.trim().isNotEmpty) return 'and-${id.trim()}';
      }
    } catch (_) {}
    return const Uuid().v4();
  }

  Future<DeviceStatus> ensureRegisteredAndAuthorized() async {
    // Credentials from a previous session (they survive logout).
    final storedId = await _store.deviceId;
    final storedToken = await _store.deviceToken;
    try {
      var uid = await _db.getMeta('device_uid');
      if (uid == null) {
        uid = await _stableDeviceUid();
        await _db.setMeta('device_uid', uid);
      }

      final reg = await _api.dio.post('/auth/device/register', data: {
        'deviceUid': uid,
        'platform': Platform.isIOS ? 'ios' : 'android',
        'label': await _deviceName(),
      });
      final deviceId = reg.data['deviceId'] as String;
      await _db.setMeta('device_id', deviceId);
      await _store.saveDeviceId(deviceId);

      // Try to obtain a token — only granted when the device is AUTHORIZED.
      try {
        final t = await _api.dio.post('/auth/device/token', data: {'deviceId': deviceId});
        await _store.saveDeviceToken(t.data['deviceToken'] as String);
        return DeviceStatus(DeviceState.authorized, deviceId: deviceId);
      } on DioException catch (e) {
        if (e.response?.statusCode == 403) {
          return DeviceStatus(DeviceState.pending, deviceId: deviceId);
        }
        rethrow;
      }
    } on DioException catch (e) {
      // Server unreachable — if this phone already holds device credentials,
      // open the gate screen anyway. Nothing can be recorded until the
      // connection is back, and each scan says so, but the watchman sees the
      // screen he knows rather than a failure to start.
      if (storedId != null && storedToken != null) {
        return DeviceStatus(DeviceState.authorized, deviceId: storedId);
      }
      return DeviceStatus(DeviceState.error, message: e.message ?? 'network error');
    } catch (e) {
      // Anything else (a keystore write that timed out, an unexpected response
      // shape) must still return a state. Letting it throw would leave the site
      // page spinning forever with no way out but clearing app data.
      return DeviceStatus(DeviceState.error, message: e.toString());
    }
  }
}
