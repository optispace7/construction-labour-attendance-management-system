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
        onError: (e, handler) async {
          if (e.response?.statusCode == 401 && !_isRefreshCall(e.requestOptions)) {
            final refreshed = await _tryRefresh();
            if (refreshed) {
              final clone = await _retry(e.requestOptions);
              return handler.resolve(clone);
            }
          }
          handler.next(e);
        },
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

  bool _isRefreshCall(RequestOptions o) => o.path.contains('/auth/refresh');

  /// Renew the credential after a 401.
  ///
  /// Only the old scheme can be renewed. A Better Auth session carries no
  /// refresh token — the server extends it as it is used — so there is nothing
  /// to present here and a 401 means the session is genuinely finished. The
  /// absent refresh token is the signal, and the honest answer is to fail and
  /// let the app ask for a sign-in rather than retry something that cannot
  /// work.
  Future<bool> _tryRefresh() async {
    final refresh = await _store.refreshToken;
    if (refresh == null) return false;
    try {
      final res =
          await Dio(_baseOptions).post('/auth/refresh', data: {'refreshToken': refresh});
      await _store.saveTokens(
        res.data['accessToken'] as String,
        res.data['refreshToken'] as String,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<Response<dynamic>> _retry(RequestOptions o) async {
    final token = await _store.accessToken;
    return _dio.request(
      o.path,
      data: o.data,
      queryParameters: o.queryParameters,
      options: Options(method: o.method, headers: {...o.headers, 'authorization': 'Bearer $token'}),
    );
  }
}
