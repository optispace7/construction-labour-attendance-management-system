/// Build-time configuration. Override with --dart-define=API_BASE_URL=...
class Env {
  static const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000/api/v1',
  );

  /// Where Better Auth answers.
  ///
  /// It is mounted outside the versioned API — it builds its own paths from
  /// its basePath and knows nothing about URI versioning — so its routes sit
  /// at /api/better-auth rather than under /api/v1. Derived from the one base
  /// URL above rather than being a second --dart-define, because two settings
  /// that must agree are two chances to ship an APK pointing half at one
  /// environment and half at another.
  static String get betterAuthBaseUrl =>
      apiBaseUrl.replaceFirst(RegExp(r'/api/v\d+/?$'), '/api/better-auth');
}
