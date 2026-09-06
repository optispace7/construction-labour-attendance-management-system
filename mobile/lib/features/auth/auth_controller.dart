import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config/env.dart';
import '../../core/providers.dart';
import '../../core/push/push_service.dart';
import '../../core/storage/secure_store.dart';

class AuthState {
  const AuthState({
    this.initialized = false,
    this.loading = false,
    this.authenticated = false,
    this.role,
    this.fullName,
    this.email,
    this.error,
  });

  /// Whether startup bootstrap has finished (so the router can stop showing splash).
  final bool initialized;
  final bool loading;
  final bool authenticated;
  final String? role;
  final String? fullName;
  final String? email;
  final String? error;

  AuthState copyWith({
    bool? initialized,
    bool? loading,
    bool? authenticated,
    String? role,
    String? fullName,
    String? email,
    String? error,
  }) =>
      AuthState(
        initialized: initialized ?? this.initialized,
        loading: loading ?? this.loading,
        authenticated: authenticated ?? this.authenticated,
        role: role ?? this.role,
        fullName: fullName ?? this.fullName,
        email: email ?? this.email,
        error: error,
      );
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._ref) : super(const AuthState());
  final Ref _ref;

  SecureStore get _store => _ref.read(secureStoreProvider);
  Dio get _dio => _ref.read(apiClientProvider).dio;

  /// Send this device's FCM token to the backend so SOS push can reach it.
  Future<void> _registerPush() async {
    try {
      final deviceUid = await _ref.read(localDbProvider).getMeta('device_uid');
      await PushService.registerToken(_dio, deviceUid: deviceUid);
    } catch (_) {
      // Best-effort; retried on next login/start.
    }
  }

  /// On app start: if a token is stored, validate it via /auth/me (the API
  /// client auto-refreshes on 401), restoring the session + role across restarts.
  ///
  /// EVERYTHING here is guarded — bootstrap must always end with
  /// `initialized: true`, otherwise the router keeps showing the splash
  /// spinner forever (secure-storage reads can throw after app upgrades, and
  /// network calls can stall).
  Future<void> bootstrap() async {
    try {
      final token = await _store.accessToken.timeout(const Duration(seconds: 5));
      if (token == null) {
        state = state.copyWith(initialized: true, authenticated: false);
        return;
      }
      final me = await _dio.get('/auth/me').timeout(const Duration(seconds: 15));
      state = state.copyWith(
        initialized: true,
        authenticated: true,
        role: me.data['role'] as String?,
        fullName: me.data['fullName'] as String?,
        email: me.data['email'] as String?,
      );
      unawaited(_registerPush());
    } on DioException catch (e) {
      // The server explicitly rejected the session — drop tokens but KEEP
      // device credentials so this phone stays authorized after re-login.
      // On pure network errors the tokens are kept for the next start.
      if (e.response != null) {
        try {
          await _store.clearAuth();
        } catch (_) {}
      }
      state = state.copyWith(initialized: true, authenticated: false, role: null);
    } catch (_) {
      try {
        await _store.clearAuth();
      } catch (_) {}
      state = state.copyWith(initialized: true, authenticated: false, role: null);
    }
  }

  /// Sign in. EVERY failure path must end with `loading: false` and an error to
  /// show — otherwise the button sticks on "Signing in…" forever with no clue
  /// why. The keystore write is the dangerous one: it is not a DioException, so
  /// an unguarded throw (or a platform channel that never answers) used to
  /// escape this method and wedge the screen.
  Future<bool> login(String identifier, String password) async {
    state = state.copyWith(loading: true, error: null);
    try {
      // Dio's connectTimeout does not reliably cover a stalled DNS lookup on
      // Android: on a captive-portal/blocked network the request future can
      // hang with nothing ever thrown, leaving the button on "Signing in…"
      // forever. This outer bound guarantees the screen always comes back.
      // Better Auth splits sign-in across two endpoints rather than accepting
      // either credential at one. Watchmen have no mailbox — a user ID is the
      // only way in for them — so which one to call is decided here.
      final byEmail = identifier.contains('@');
      final res = await Dio(BaseOptions(baseUrl: Env.betterAuthBaseUrl))
          .post(
            byEmail ? '/sign-in/email' : '/sign-in/username',
            data: byEmail
                ? {'email': identifier, 'password': password}
                : {'username': identifier, 'password': password},
          )
          .timeout(const Duration(seconds: 30));

      // The session token comes back in a header for clients that do not keep
      // cookies, which is this one: cookie handling across an app restart and
      // a long offline stretch is not something to depend on at a site gate.
      final session = (res.headers.value('set-auth-token') ??
              res.data['token'] as String?)
          ?.trim();
      if (session == null || session.isEmpty) {
        state = state.copyWith(
          loading: false,
          error: 'Server did not return a session token — try again.',
        );
        return false;
      }

      // Secure storage lives behind a platform channel and can stall or throw
      // (keystore trouble on some Android builds). Bound it, so a broken
      // keystore surfaces as a message instead of an endless spinner.
      await _store.saveSession(session).timeout(const Duration(seconds: 10));

      // Who they are comes from Better Auth; what they may do does not. Role
      // and site scopes live in our own users table, so they are read from the
      // API with the session just obtained. Reading `role` off the sign-in
      // reply yields null and would leave the app with no idea which screens
      // to show.
      Map<String, dynamic>? me;
      try {
        final profile = await _dio
            .get(
              '/auth/me',
              options: Options(headers: {'authorization': 'Bearer $session'}),
            )
            .timeout(const Duration(seconds: 15));
        me = (profile.data as Map).cast<String, dynamic>();
      } catch (_) {
        // Signed in, but the profile call failed. Better to continue with what
        // is known than to refuse a login that actually succeeded; the guarded
        // screens re-check the role against the API anyway.
        me = null;
      }

      state = state.copyWith(
        initialized: true,
        loading: false,
        authenticated: true,
        role: me?['role'] as String?,
        fullName: me?['fullName'] as String?,
        email: (me?['email'] as String?) ?? identifier,
      );
      unawaited(_registerPush());
      return true;
    } on DioException catch (e) {
      final detail = e.response?.data is Map
          ? (e.response?.data['detail'] ?? e.response?.data['title'])
          : null;
      state = state.copyWith(
        loading: false,
        error: (detail as String?) ?? _networkMessage(e),
      );
      return false;
    } on TimeoutException {
      state = state.copyWith(
        loading: false,
        error: 'Sign-in timed out. The phone could not reach the server — check '
            'that this network allows the internet, then try again.',
      );
      return false;
    } catch (e) {
      // Anything else — a keystore PlatformException, a bad response shape.
      // Never leave the screen spinning; say what happened.
      state = state.copyWith(loading: false, error: 'Login failed: $e');
      return false;
    }
  }

  String _networkMessage(DioException e) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.connectionError:
        return 'Cannot reach the server — check the internet connection.';
      default:
        return 'Login failed';
    }
  }

  Future<void> logout() async {
    // Keep device_id/device_token: the device authorization belongs to the
    // phone, not the user session. Wiping them forced admins to re-authorize
    // the device after every logout/login.
    await _store.clearAuth();
    state = const AuthState(initialized: true, authenticated: false);
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) => AuthController(ref));
