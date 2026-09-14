import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../device/device_service.dart';
import '../sync/legacy_outbox_drain.dart';
import 'data/attendance_repository.dart';

final deviceServiceProvider = Provider<DeviceService>(
  (ref) => DeviceService(
    ref.watch(apiClientProvider),
    ref.watch(secureStoreProvider),
    ref.watch(localDbProvider),
  ),
);

final attendanceRepositoryProvider = Provider<AttendanceRepository>(
  (ref) => AttendanceRepository(
    ref.watch(apiClientProvider),
    ref.watch(locationServiceProvider),
  ),
);

final legacyOutboxDrainProvider = Provider<LegacyOutboxDrain>(
  (ref) => LegacyOutboxDrain(ref.watch(localDbProvider), ref.watch(apiClientProvider)),
);

/// Currently selected active site (persisted in meta).
final activeSiteProvider = StateProvider<String?>((ref) => null);
