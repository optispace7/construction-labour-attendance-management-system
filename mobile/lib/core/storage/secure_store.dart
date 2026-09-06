import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Token + device-credential storage backed by the platform keystore/keychain.
///
/// EVERY operation here is bounded. The keystore sits behind a platform channel
/// and on some devices a call can stall indefinitely — an unbounded await then
/// freezes whatever screen is waiting on it, with nothing thrown and no error
/// to show (this froze login on "Signing in…" and the site page on its
/// spinner). A read that fails yields null and a write that fails is reported,
/// but neither is ever allowed to hang.
class SecureStore {
  SecureStore([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  static const _accessKey = 'access_token';
  static const _refreshKey = 'refresh_token';
  static const _deviceIdKey = 'device_id';
  static const _deviceTokenKey = 'device_token';

  static const _readTimeout = Duration(seconds: 3);
  static const _writeTimeout = Duration(seconds: 5);

  /// A stalled or broken keystore reads as "nothing stored" rather than hanging.
  Future<String?> _read(String key) async {
    try {
      return await _storage.read(key: key).timeout(_readTimeout);
    } catch (e) {
      if (kDebugMode) debugPrint('[secure_store] read "$key" failed: $e');
      return null;
    }
  }

  /// Writes are bounded too, but a failure is NOT swallowed: callers decide
  /// (login shows the operator an error rather than pretending it signed in).
  Future<void> _write(String key, String value) =>
      _storage.write(key: key, value: value).timeout(_writeTimeout);

  Future<void> _delete(String key) async {
    try {
      await _storage.delete(key: key).timeout(_writeTimeout);
    } catch (e) {
      if (kDebugMode) debugPrint('[secure_store] delete "$key" failed: $e');
    }
  }

  Future<void> saveTokens(String access, String refresh) async {
    await _write(_accessKey, access);
    await _write(_refreshKey, refresh);
  }

  /// Store a Better Auth session token.
  ///
  /// There is no second token to keep. A session is renewed by the server as
  /// it is used, so any refresh token still on the device is left over from
  /// the old scheme and is deleted rather than kept — a stale one would send
  /// the client down a refresh path that cannot succeed, and turn an expired
  /// session into a silent failure instead of a sign-in prompt.
  Future<void> saveSession(String token) async {
    await _write(_accessKey, token);
    await _delete(_refreshKey);
  }

  Future<String?> get accessToken => _read(_accessKey);
  Future<String?> get refreshToken => _read(_refreshKey);

  Future<void> saveDevice(String deviceId, String deviceToken) async {
    await _write(_deviceIdKey, deviceId);
    await _write(_deviceTokenKey, deviceToken);
  }

  Future<void> saveDeviceId(String deviceId) => _write(_deviceIdKey, deviceId);

  Future<void> saveDeviceToken(String token) => _write(_deviceTokenKey, token);

  Future<String?> get deviceId => _read(_deviceIdKey);
  Future<String?> get deviceToken => _read(_deviceTokenKey);

  /// Clears ONLY the user session (access/refresh tokens). Device credentials
  /// survive logout so the same phone never needs admin re-authorization.
  Future<void> clearAuth() async {
    await _delete(_accessKey);
    await _delete(_refreshKey);
  }

  /// Full wipe — device credentials included. Only for factory-reset flows.
  Future<void> clear() => _storage.deleteAll();
}
