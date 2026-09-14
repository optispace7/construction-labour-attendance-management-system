import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Compares the phone clock with the server clock (GET /health/time).
/// Returns the skew in milliseconds, or null when offline/unknown.
/// Cached for 5 minutes so punches don't pay a round-trip every time.
class ClockGuard {
  ClockGuard(this._dio);
  final Dio _dio;

  static const maxSkewMs = 10 * 60 * 1000; // 10 minutes

  DateTime? _checkedAt;
  int? _skewMs;

  Future<int?> skewMs() async {
    final now = DateTime.now();
    if (_checkedAt != null && now.difference(_checkedAt!) < const Duration(minutes: 5)) {
      return _skewMs;
    }
    try {
      final before = DateTime.now().toUtc();
      final res = await _dio.get(
        '/health/time',
        options: Options(
          sendTimeout: const Duration(seconds: 5),
          receiveTimeout: const Duration(seconds: 5),
        ),
      );
      final after = DateTime.now().toUtc();
      final server = DateTime.parse(res.data['now'] as String);
      // Compare against the midpoint of the request to cancel out latency.
      final midpoint = before.add(after.difference(before) ~/ 2);
      _skewMs = midpoint.difference(server).inMilliseconds;
      _checkedAt = now;
      return _skewMs;
    } catch (_) {
      // Offline — can't verify. Not a reason to refuse here: the scan itself
      // needs the server and will say there is no connection.
      return null;
    }
  }

  Future<bool> clockIsWrong() async {
    final skew = await skewMs();
    return skew != null && skew.abs() > maxSkewMs;
  }
}

final clockGuardProvider =
    Provider<ClockGuard>((ref) => ClockGuard(ref.watch(apiClientProvider).dio));
