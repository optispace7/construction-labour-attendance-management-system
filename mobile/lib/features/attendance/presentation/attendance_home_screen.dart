import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/theme.dart';
import '../../../core/providers.dart';
import '../../../core/time/clock_guard.dart';
import '../../../core/widgets/section_header.dart';
import '../attendance_providers.dart';
import '../data/attendance_repository.dart';
import '../../auth/auth_controller.dart';
import '../../device/device_service.dart';
import '../domain/models.dart';
import '../domain/tap_decision.dart';
import '../../sos/notification_watcher.dart';
import '../../sos/sos_button.dart';
import 'worker_card_sheet.dart';
import 'manual_search_sheet.dart';
import 'confirm_tap_dialog.dart';
import 'qr_scan_screen.dart';
import 'too_soon_dialog.dart';

class AttendanceHomeScreen extends ConsumerStatefulWidget {
  const AttendanceHomeScreen({super.key});

  @override
  ConsumerState<AttendanceHomeScreen> createState() => _AttendanceHomeScreenState();
}

class _AttendanceHomeScreenState extends ConsumerState<AttendanceHomeScreen> {
  String? _siteId;
  String _siteName = '';
  bool _busy = false;
  String _status = 'Scan a worker QR badge to begin';

  /// The site's scanning rules from the admin panel — duplicate cooldown and
  /// safety gap. Loaded from the local cache on entry and refreshed from the
  /// server, so an admin changing them takes effect without a new build. The
  /// initial value only stands until [_init] reads the cache.
  ScanPolicy _policy = const ScanPolicy();

  DeviceState? _deviceState;
  String? _deviceId;
  Timer? _syncTimer;
  DateTime _lastCacheRefresh = DateTime.fromMillisecondsSinceEpoch(0);

  static const _cacheRefreshEvery = Duration(hours: 4);

  @override
  void initState() {
    super.initState();
    Future.microtask(_init);
    // Drain the outbox in the background so punches reach the server even if
    // the immediate push failed (network blip, server briefly down).
    _syncTimer = Timer.periodic(const Duration(seconds: 60), (_) => _backgroundSync());
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    super.dispose();
  }

  Future<void> _backgroundSync() async {
    await ref.read(syncEngineProvider).syncNow();
    if (mounted) ref.invalidate(pendingCountProvider);
    // Periodic worker-cache refresh so deleted/edited workers don't go stale.
    if (DateTime.now().difference(_lastCacheRefresh) > _cacheRefreshEvery) {
      await _refreshWorkerCache();
    }
  }

  /// Re-pulls the site's worker list and replaces the offline cache, dropping
  /// entries for deleted/exited people.
  Future<void> _refreshWorkerCache() async {
    if (_siteId == null) return;
    try {
      final dio = ref.read(apiClientProvider).dio;
      final res = await dio.get('/workers/by-site', queryParameters: {'siteId': _siteId});
      final data = (res.data['data'] as List).cast<Map<String, dynamic>>();
      await ref.read(localDbProvider).replaceWorkers(data.map(WorkerCard.fromMap).toList());
      // Who is already logged in, org-wide — including logins recorded on other
      // devices. Without this a handset that goes offline would offer a fresh
      // LOGIN to someone another gate already scanned in.
      await ref.read(attendanceRepositoryProvider).refreshOpenSessions();
      await _refreshPolicy();
      _lastCacheRefresh = DateTime.now();
    } catch (_) {
      // Offline — keep the existing cache; retried on the next cycle.
    }
  }

  /// Re-read the site's cooldown and safety gap, then hold them for the scans
  /// this screen makes. Cached, so a device that loses the network keeps
  /// enforcing the last rules the admin set rather than falling back to guesses.
  Future<void> _refreshPolicy() async {
    if (_siteId == null) return;
    final repo = ref.read(attendanceRepositoryProvider);
    await repo.refreshPolicy(_siteId!);
    final policy = await repo.policy();
    if (mounted) setState(() => _policy = policy);
  }

  Future<void> _init() async {
    final db = ref.read(localDbProvider);
    final siteId = await db.getMeta('active_site');
    final name = await db.getMeta('active_site_name') ?? '';
    final policy = await ref.read(attendanceRepositoryProvider).policy();
    setState(() {
      _siteId = siteId;
      _siteName = name;
      _policy = policy;
    });
    await _ensureDevice();
    // Kick a sync + fresh worker cache on entry (app start).
    ref.read(syncEngineProvider).syncNow();
    unawaited(_refreshWorkerCache());
  }

  Future<void> _ensureDevice() async {
    final st = await ref.read(deviceServiceProvider).ensureRegisteredAndAuthorized();
    if (!mounted) return;
    setState(() {
      _deviceState = st.state;
      _deviceId = st.deviceId;
    });
  }

  Future<void> _onManual() async {
    final picked = await showModalBottomSheet<WorkerCard>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const ManualSearchSheet(),
    );
    if (picked == null) return;
    final reason = await _askReason();
    if (reason == null) return;
    await _handleTap(TapSource.manual, picked.workerCode,
        manualBackup: true, manualReason: reason);
  }

  Future<String?> _askReason() {
    final controller = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Reason required'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(hintText: 'e.g. Forgot card'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Confirm'),
          ),
        ],
      ),
    );
  }

  /// Continuous gate loop: the camera stays up and hands each new badge to
  /// [_reviewScan], so the watchman works a line of workers without tapping
  /// "Scan" between them. The only way out is the back button on the scanner.
  ///
  /// The scanner keeps one camera for the whole queue and skips the badge it
  /// just handled until it leaves the frame — see [QrScanScreen]. Pushing a
  /// fresh scanner per scan, as this used to, meant the worker still standing
  /// at the gate was read again and again until the cooldown lapsed, and the
  /// read that got through scanned him back out a minute after he arrived.
  Future<void> _onQr() async {
    if (_siteId == null) return;
    if (await _clockIsWrong()) return;
    if (!mounted) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => QrScanScreen(onCode: _reviewScan)),
    );
  }

  /// Handles one scanned badge: preview (writes nothing) → confirm → record.
  /// Returns what the camera screen should show the watchman.
  Future<ScanFeedback?> _reviewScan(String code) async {
    // QR badges are "CLAMS:<EMP-ID>"; accept a bare code too.
    final identifier = (code.startsWith('CLAMS:') ? code.substring(6) : code).trim();
    if (identifier.isEmpty) return null;

    setState(() => _busy = true);
    final outcome = await ref.read(attendanceRepositoryProvider).preview(
          siteId: _siteId!,
          source: TapSource.qr,
          identifier: identifier,
          policy: _policy,
        );
    if (!mounted) return null;
    setState(() => _busy = false);

    switch (outcome.action) {
      // A scan inside the cooldown used to be dropped on the floor. It is now a
      // question: the watchman can see whether that is one badge read twice or
      // a second man who has stepped up, and the camera cannot.
      case TapAction.duplicate:
        return _reviewTooSoon(identifier, outcome, isDuplicate: true);

      case TapAction.tooSoon:
        return _reviewTooSoon(identifier, outcome);

      case TapAction.expired:
        setState(() => _status = 'ID card expired — login not recorded');
        await _showExpired(outcome.message);
        return ScanFeedback.error(
          '${outcome.worker?.fullName ?? 'This card'} — ID expired',
          detail: 'Login not recorded. Renew the card.',
        );

      // Neither can arise from a badge scan — both belong to hand-typed entry,
      // which never comes through here. Listed so the switch stays exhaustive.
      case TapAction.pendingApproval:
      case TapAction.awaitingReview:
        return null;

      case TapAction.login:
      case TapAction.logout:
        // One screen: the worker's details AND the OK/Cancel decision.
        final ok = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (_) => ConfirmTapDialog(
            action: outcome.action,
            identifier: identifier,
            worker: outcome.worker,
            stateIsStale: outcome.stateIsStale,
          ),
        );
        if (ok != true) {
          if (mounted) setState(() => _status = 'Cancelled — nothing recorded');
          return const ScanFeedback.info('Cancelled', detail: 'Nothing was recorded.');
        }
        return _handleTap(TapSource.qr, identifier);
    }
  }

  /// The scan was refused for landing too close to the last one — either inside
  /// the duplicate cooldown or inside the site's safety gap. Show what happened
  /// and let the watchman record it anyway: a worker really can be sent home
  /// five minutes after arriving, and the rule must not make that unrecordable.
  ///
  /// No reason is collected. Watchmen were being asked to justify a decision
  /// they had no vocabulary for, so the prompt was dropped; the confirmation is
  /// the decision, and it is audited either way.
  Future<ScanFeedback?> _reviewTooSoon(
    String identifier,
    TapOutcome outcome, {
    bool isDuplicate = false,
    // Carried through so the retry is the same punch the watchman started.
    // Dropping the source would file a hand-typed entry as a badge scan, and
    // dropping the reason would lose what he typed and send it for approval
    // with nothing attached.
    TapSource source = TapSource.qr,
    bool manualBackup = false,
    String? manualReason,
  }) async {
    setState(() => _status = isDuplicate
        ? 'Scanned a moment ago — not recorded yet'
        : 'Too soon — nothing recorded');

    final confirmed = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => TooSoonDialog(
        blocked: outcome.blocked,
        worker: outcome.worker,
        elapsedMinutes: outcome.elapsedMinutes,
        remainingSeconds:
            isDuplicate ? outcome.cooldownRemainingSeconds : outcome.remainingSeconds,
        isDuplicate: isDuplicate,
      ),
    );

    if (confirmed != true || !mounted) {
      final name = outcome.worker?.fullName ?? 'This person';
      if (isDuplicate) {
        return ScanFeedback.info(
          '$name — scanned a moment ago',
          detail: 'Nothing recorded.',
        );
      }
      final mins = outcome.elapsedMinutes;
      return ScanFeedback.warning(
        '$name — too soon',
        detail: outcome.blocked == TapAction.login
            ? 'Logged out ${mins}m ago. Nothing recorded.'
            : 'Logged in ${mins}m ago. Nothing recorded.',
      );
    }
    return _handleTap(
      source,
      identifier,
      overridden: true,
      manualBackup: manualBackup,
      manualReason: manualReason,
    );
  }

  /// A wrong phone clock would record punches at the wrong time — refuse the
  /// scan while online with >10 min skew. (Offline punches are allowed.)
  Future<bool> _clockIsWrong() async {
    if (!await ref.read(clockGuardProvider).clockIsWrong()) return false;
    if (!mounted) return true;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.schedule, color: ClamsColors.error, size: 40),
        title: const Text('Phone clock is wrong'),
        content: const Text(
          'This phone\'s time differs from the server by more than 10 minutes, '
          'so punches would be recorded at the wrong time.\n\n'
          'Open Settings → Date & time and enable "Automatic date & time", '
          'then try again.',
        ),
        actions: [
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
        ],
      ),
    );
    return true;
  }

  /// Say plainly that nothing has been recorded yet. The watchman has just typed
  /// somebody in; if he walks away thinking it is done, that man is missing from
  /// the register — and from the fire headcount — until someone notices.
  Future<void> _showPendingApproval(String name, String verb) {
    return showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.hourglass_top, color: ClamsColors.warning, size: 40),
        title: const Text('Sent for approval'),
        content: Text(
          "$name's $verb was entered by hand, so it is not on the register yet.\n\n"
          'The Safety Officer has to accept it. Until they do, this person does '
          'not count as on site.',
        ),
        actions: [
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
        ],
      ),
    );
  }

  Future<void> _showAlreadyWaiting(String? message) {
    return showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.pending_actions, color: ClamsColors.warning, size: 40),
        title: const Text('Already waiting for approval'),
        content: Text(
          message ??
              'A manual entry for this person is already waiting for the Safety '
                  'Officer. Ask them to review it before entering another.',
        ),
        actions: [
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
        ],
      ),
    );
  }

  Future<void> _showExpired(String? message) {
    return showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.gpp_bad_outlined, color: Colors.red, size: 40),
        title: const Text('ID card expired'),
        content: Text(
          message ?? 'This ID card has expired. Renew it before logging in.',
        ),
        actions: [
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
        ],
      ),
    );
  }

  Future<ScanFeedback?> _handleTap(
    TapSource source,
    String identifier, {
    bool manualBackup = false,
    String? manualReason,
    bool overridden = false,
  }) async {
    if (_siteId == null) return null;
    if (source != TapSource.qr && await _clockIsWrong()) return null;

    setState(() => _busy = true);
    final repo = ref.read(attendanceRepositoryProvider);
    final outcome = await repo.tap(
      siteId: _siteId!,
      deviceId: (await ref.read(localDbProvider).getMeta('device_id')) ?? 'unregistered',
      source: source,
      identifier: identifier,
      policy: _policy,
      manualBackup: manualBackup,
      manualReason: manualReason,
      overridden: overridden,
    );
    ref.invalidate(pendingCountProvider);
    if (!mounted) return null;
    setState(() => _busy = false);

    switch (outcome.action) {
      // Both refusals below are offered to the watchman rather than ending the
      // attempt, exactly as a scan is — see [_reviewTooSoon].
      //
      // A hand-typed entry used to stop dead here. That was the worse dead end
      // of the two: he has already searched for the man, picked him and typed a
      // reason, so the entry is deliberate by definition and cannot be the
      // accidental double-read the gap exists to catch. Being told "too soon"
      // with no way forward left him with a man standing at the gate and
      // nothing he could do about it. The punch is held for the Safety Officer
      // either way, so there is a second pair of eyes regardless.
      //
      // `overridden` guards the recursion: the retry below comes back through
      // this same switch, and a refusal that survives an override is real.
      case TapAction.duplicate:
        if (!overridden) {
          return _reviewTooSoon(
            identifier,
            outcome,
            isDuplicate: true,
            source: source,
            manualBackup: manualBackup,
            manualReason: manualReason,
          );
        }
        setState(() => _status = 'Scanned a moment ago — nothing recorded');
        return ScanFeedback.info(
          '${outcome.worker?.fullName ?? 'This person'} — scanned a moment ago',
          detail: 'Nothing recorded. Scan again to confirm.',
        );

      case TapAction.tooSoon:
        if (!overridden) {
          return _reviewTooSoon(
            identifier,
            outcome,
            source: source,
            manualBackup: manualBackup,
            manualReason: manualReason,
          );
        }
        setState(() => _status = 'Too soon — nothing recorded');
        return ScanFeedback.warning(
          '${outcome.worker?.fullName ?? 'This person'} — too soon',
          detail: outcome.message ?? 'Nothing recorded.',
        );

      case TapAction.expired:
        // Nothing was queued: the login is refused outright, not "pending".
        setState(() => _status = 'ID card expired — login not recorded');
        await _showExpired(outcome.message);
        return ScanFeedback.error(
          '${outcome.worker?.fullName ?? 'This card'} — ID expired',
          detail: 'Login not recorded. Renew the card.',
        );

      case TapAction.pendingApproval:
        final verb = outcome.blocked == TapAction.logout ? 'logout' : 'login';
        final name = outcome.worker?.fullName ?? 'This person';
        setState(() => _status = 'Sent for approval — not recorded yet');
        await _showPendingApproval(name, verb);
        return ScanFeedback.warning(
          '$name — sent for approval',
          detail: 'The $verb is not on the register until the Safety Officer accepts it.',
        );

      case TapAction.awaitingReview:
        setState(() => _status = 'Already waiting for approval');
        await _showAlreadyWaiting(outcome.message);
        return ScanFeedback.warning(
          '${outcome.worker?.fullName ?? 'This person'} — already waiting',
          detail: 'Nothing was recorded.',
        );

      case TapAction.login:
      case TapAction.logout:
        final verb = outcome.action == TapAction.login ? 'LOGIN' : 'LOGOUT';
        final name = outcome.worker?.fullName;
        setState(() => _status =
            name == null ? (outcome.message ?? 'Recorded') : '$verb recorded: $name');
        // A QR scan already showed the worker's details on the confirm screen —
        // don't make the watchman dismiss the same person twice; the camera
        // banner tells him what was recorded. Manual entry has no such screen,
        // so it still gets the full card.
        if (source != TapSource.qr && outcome.worker != null) {
          await showModalBottomSheet(
            context: context,
            builder: (_) => WorkerCardSheet(worker: outcome.worker!, action: verb),
          );
          return null;
        }
        return outcome.action == TapAction.login
            ? ScanFeedback.success('LOGIN recorded', detail: name)
            : ScanFeedback.info('LOGOUT recorded', detail: name);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pending = ref.watch(pendingCountProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(_siteName.isEmpty ? 'Attendance' : _siteName),
        actions: [
          const SosButton(compact: true),
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: pending.when(
                data: (n) => ActionChip(
                  avatar: Icon(
                    n == 0 ? Icons.cloud_done : Icons.cloud_upload,
                    size: 18,
                    color: n == 0 ? ClamsColors.success : ClamsColors.warning,
                  ),
                  label: Text(
                    n == 0 ? 'Synced' : '$n to sync',
                    style: TextStyle(
                      color: n == 0 ? ClamsColors.success : ClamsColors.warning,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  backgroundColor:
                      n == 0 ? ClamsColors.successTint : ClamsColors.warningTint,
                  side: BorderSide.none,
                  tooltip: n == 0
                      ? 'All punches uploaded — tap to sync now'
                      : '$n punch(es) waiting to upload — tap to sync now',
                  onPressed: _backgroundSync,
                ),
                loading: () => const SizedBox.shrink(),
                error: (_, __) => const SizedBox.shrink(),
              ),
            ),
          ),
          IconButton(
            tooltip: 'Change site',
            icon: const Icon(Icons.location_city),
            onPressed: () => context.go('/site'),
          ),
          IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
      body: NotificationWatcher(
        child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_deviceState == DeviceState.pending || _deviceState == DeviceState.error)
              StatusBanner(
                color: ClamsColors.warning,
                icon: Icons.warning_amber,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _deviceState == DeviceState.pending
                          ? 'Device awaiting authorization'
                          : 'Could not reach server',
                      style: Theme.of(context)
                          .textTheme
                          .titleMedium
                          ?.copyWith(fontWeight: FontWeight.w500),
                    ),
                    ClamsSpacing.gapSm,
                    if (_deviceState == DeviceState.pending && _deviceId != null)
                      Text(
                        'Ask an admin to authorize this device in Admin → Devices, '
                        'then tap Retry.\nDevice ID: $_deviceId',
                        style: const TextStyle(color: ClamsColors.textSecondary),
                      ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: _ensureDevice,
                        style: TextButton.styleFrom(
                            foregroundColor: ClamsColors.accent),
                        child: const Text('Retry'),
                      ),
                    ),
                  ],
                ),
              ),
            // Unsent punches mean this device stops asking the server who is on
            // site — its answer would be older than what we already hold. Say so
            // plainly: while this shows, LOGIN/LOGOUT is decided from this
            // handset alone, and another gate's scans are invisible to it.
            pending.maybeWhen(
              data: (n) => n == 0
                  ? const SizedBox.shrink()
                  : StatusBanner(
                      color: ClamsColors.warning,
                      icon: Icons.cloud_off,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Working from this phone only',
                            style: Theme.of(context)
                                .textTheme
                                .titleMedium
                                ?.copyWith(fontWeight: FontWeight.w500),
                          ),
                          ClamsSpacing.gapSm,
                          Text(
                            '$n punch(es) still to upload. Until they do, this phone '
                            'cannot see scans made at other gates, so in/out may be '
                            'wrong for someone scanned there.',
                            style: const TextStyle(color: ClamsColors.textSecondary),
                          ),
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton(
                              onPressed: _backgroundSync,
                              style: TextButton.styleFrom(
                                  foregroundColor: ClamsColors.accent),
                              child: const Text('Sync now'),
                            ),
                          ),
                        ],
                      ),
                    ),
              orElse: () => const SizedBox.shrink(),
            ),
            ClamsSpacing.gapMd,
            const Icon(Icons.qr_code_scanner, size: 96, color: ClamsColors.primary),
            ClamsSpacing.gapXl,
            Text(_status, textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium),
            ClamsSpacing.gapXxl,
            FilledButton.icon(
              onPressed: _busy ? null : _onQr,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan QR code'),
            ),
            ClamsSpacing.gapMd,
            OutlinedButton.icon(
              onPressed: _busy ? null : _onManual,
              icon: const Icon(Icons.search),
              label: const Text('Manual / lost card'),
            ),
          ],
        ),
        ),
      ),
    );
  }
}
