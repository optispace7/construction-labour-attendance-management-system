import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../config/env.dart';
import '../storage/secure_store.dart';

/// Dio-based API client. Attaches the bearer + device headers and transparently
/// refreshes the access token on 401.
/// Timeouts keep the app responsive when the server is slow/unreachable —
/// without them a dead connection spins forever (e.g. splash never leaving).
final _baseOptions = BaseOptions(
  baseUrl: Env.apiBaseUrl,
  connectTimeout: const Duration(seconds: 12),
  receiveTimeout: const Duration(seconds: 20),
  sendTimeout: const Duration(seconds: 20),
);

class ApiClient {
  ApiClient(this._store) : _dio = Dio(_baseOptions) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          // These reads sit in front of EVERY request. The keystore is a
          // platform channel and on some devices (seen on MIUI) a read can
          // stall forever — with no timeout here the request is never sent,
          // nothing throws, and the screen hangs (e.g. login stuck on
          // "Signing in…"). A missing header is recoverable; a hang is not.
          final token = await _read(() => _store.accessToken, 'accessToken');
          if (token != null) options.headers['authorization'] = 'Bearer $token';
          final deviceId = await _read(() => _store.deviceId, 'deviceId');
          final deviceToken = await _read(() => _store.deviceToken, 'deviceToken');
          if (deviceId != null) options.headers['x-device-id'] = deviceId;
          if (deviceToken != null) options.headers['x-device-token'] = deviceToken;
          handler.next(options);
        },
        // No retry on 401. A Better Auth session is extended by the server as
        // it is used and carries no refresh token to present, so a 401 means
        // the session is genuinely over. Retrying the same request with the
        // same credential can only produce the same 401 — and at a gate, a
        // silent retry loop is worse than being asked to sign in.
        onError: (e, handler) => handler.next(e),
      ),
    );
  }

  final Dio _dio;
  final SecureStore _store;

  Dio get dio => _dio;

  /// Read one credential, never blocking the request for more than 3s.
  /// A stalled/broken keystore yields null (request goes out unauthenticated
  /// and the server answers 401) instead of freezing the app.
  static Future<String?> _read(Future<String?> Function() get, String key) async {
    try {
      return await get().timeout(const Duration(seconds: 3));
    } catch (e) {
      if (kDebugMode) debugPrint('[api_client] secure-storage read "$key" failed: $e');
      return null;
    }
  }



}
