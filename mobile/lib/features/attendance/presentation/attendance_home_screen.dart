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

  DeviceState? _deviceState;
  String? _deviceId;

  /// Scans an offline build of the app saved on this phone and has not sent
  /// yet. Null until checked, which happens once the device is approved.
  int? _unsent;

  /// Scanning waits for two things. An approved device, so the first scan is
  /// not refused on a device token still being set up — which is how the
  /// confirm screen once offered LOGIN to a worker the server logged out. And
  /// no saved scans left, so a new scan is never decided before an older one
  /// for the same person has reached the server.
  bool get _ready =>
      _siteId != null &&
      _deviceId != null &&
      _deviceState == DeviceState.authorized &&
      _unsent == 0;

  @override
  void initState() {
    super.initState();
    Future.microtask(_init);
  }

  Future<void> _init() async {
    final db = ref.read(localDbProvider);
    final siteId = await db.getMeta('active_site');
    final name = await db.getMeta('active_site_name') ?? '';
    if (!mounted) return;
    setState(() {
      _siteId = siteId;
      _siteName = name;
    });
    await _prepare();
  }

  Future<void> _prepare() async {
    final st = await ref.read(deviceServiceProvider).ensureRegisteredAndAuthorized();
    if (!mounted) return;
    setState(() {
      _deviceState = st.state;
      _deviceId = st.deviceId;
    });
    if (st.state == DeviceState.authorized) await _sendSaved();
  }

  Future<void> _sendSaved() async {
    final deviceId = _deviceId;
    if (deviceId == null) return;
    final left = await ref.read(legacyOutboxDrainProvider).drain(deviceId);
    if (mounted) setState(() => _unsent = left);
  }

  Future<void> _onManual() async {
    if (!_ready) return;
    final picked = await showModalBottomSheet<WorkerCard>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const ManualSearchSheet(),
    );
    if (picked == null) return;
    final reason = await _askReason();
    if (reason == null) return;
    await _handleTap(TapSource.manual, picked.workerCode,
        worker: picked, manualBackup: true, manualReason: reason);
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
    if (!_ready) return;
    if (await _clockIsWrong()) return;
    if (!mounted) return;
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => QrScanScreen(onCode: _reviewScan)),
    );
  }

  /// Handles one scanned badge: the server's preview (writes nothing) → confirm
  /// → record. Returns what the camera screen should show the watchman.
  Future<ScanFeedback?> _reviewScan(String code) async {
    // QR badges are "CLAMS:<EMP-ID>"; accept a bare code too.
    final identifier = (code.startsWith('CLAMS:') ? code.substring(6) : code).trim();
    if (identifier.isEmpty || !_ready) return null;

    setState(() => _busy = true);
    final outcome = await ref.read(attendanceRepositoryProvider).preview(
          siteId: _siteId!,
          source: TapSource.qr,
          identifier: identifier,
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

      case TapAction.notFound:
      case TapAction.offline:
      case TapAction.failed:
        return _notRecorded(outcome, asDialog: false);

      // Neither can arise from a badge scan — both belong to hand-typed entry,
      // which never comes through here. Listed so the switch stays exhaustive.
      case TapAction.pendingApproval:
      case TapAction.awaitingReview:
        return null;

      case TapAction.login:
      case TapAction.logout:
        final worker = outcome.worker;
        if (worker == null) return _notRecorded(outcome, asDialog: false);
        // One screen: the worker's details AND the OK/Cancel decision.
        final ok = await showDialog<bool>(
          context: context,
          barrierDismissible: false,
          builder: (_) => ConfirmTapDialog(action: outcome.action, worker: worker),
        );
        if (ok != true) {
          if (mounted) setState(() => _status = 'Cancelled — nothing recorded');
          return const ScanFeedback.info('Cancelled', detail: 'Nothing was recorded.');
        }
        return _handleTap(TapSource.qr, identifier, worker: worker);
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
      worker: outcome.worker,
      overridden: true,
      manualBackup: manualBackup,
      manualReason: manualReason,
    );
  }

  /// A wrong phone clock would record punches at the wrong time — refuse the
  /// scan while the phone and server disagree by more than 10 minutes.
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

  /// Nothing was recorded — no connection, a badge nobody owns, or a refusal
  /// the gate has no dialog for. Said in the camera banner for a scan, and in a
  /// dialog for a typed entry, which has no banner to say it in.
  Future<ScanFeedback> _notRecorded(TapOutcome outcome, {required bool asDialog}) async {
    final (title, detail) = switch (outcome.action) {
      TapAction.offline => (
          'No internet — nothing recorded',
          outcome.message ??
              'Write it in the paper register. It can be entered later as a correction.',
        ),
      TapAction.notFound => (
          'Unknown badge — nothing recorded',
          'This badge does not belong to anyone active on the register.',
        ),
      _ => ('Not recorded', outcome.message ?? 'The server refused this scan.'),
    };
    setState(() => _status = title);
    if (asDialog) {
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          icon: const Icon(Icons.cloud_off, color: ClamsColors.error, size: 40),
          title: Text(title),
          content: Text(detail),
          actions: [
            FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('OK')),
          ],
        ),
      );
    }
    return ScanFeedback.error(title, detail: detail);
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
    WorkerCard? worker,
    bool manualBackup = false,
    String? manualReason,
    bool overridden = false,
  }) async {
    if (!_ready) return null;
    if (source != TapSource.qr && await _clockIsWrong()) return null;

    setState(() => _busy = true);
    final outcome = await ref.read(attendanceRepositoryProvider).tap(
          siteId: _siteId!,
          deviceId: _deviceId!,
          source: source,
          identifier: identifier,
          worker: worker,
          manualBackup: manualBackup,
          manualReason: manualReason,
          overridden: overridden,
        );
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

      case TapAction.notFound:
      case TapAction.offline:
      case TapAction.failed:
        return _notRecorded(outcome, asDialog: source != TapSource.qr);

      case TapAction.login:
      case TapAction.logout:
        final verb = outcome.action == TapAction.login ? 'LOGIN' : 'LOGOUT';
        final name = outcome.worker?.fullName;
        setState(() => _status = name == null ? '$verb recorded' : '$verb recorded: $name');
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
    final unsent = _unsent ?? 0;
    return Scaffold(
      appBar: AppBar(
        title: Text(_siteName.isEmpty ? 'Attendance' : _siteName),
        actions: [
          const SosButton(compact: true),
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
                        onPressed: _prepare,
                        style: TextButton.styleFrom(
                            foregroundColor: ClamsColors.accent),
                        child: const Text('Retry'),
                      ),
                    ),
                  ],
                ),
              ),
            // Scans the offline build saved and never sent. Scanning stays off
            // until they have gone, and the watchman is told why and what to do.
            if (unsent > 0)
              StatusBanner(
                color: ClamsColors.warning,
                icon: Icons.cloud_upload,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Saved scans still to send',
                      style: Theme.of(context)
                          .textTheme
                          .titleMedium
                          ?.copyWith(fontWeight: FontWeight.w500),
                    ),
                    ClamsSpacing.gapSm,
                    Text(
                      '$unsent scan(s) saved on this phone by the older app have not '
                      'reached the server. Scanning starts once they are sent — '
                      'connect to the internet and tap Send.',
                      style: const TextStyle(color: ClamsColors.textSecondary),
                    ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: _sendSaved,
                        style: TextButton.styleFrom(
                            foregroundColor: ClamsColors.accent),
                        child: const Text('Send'),
                      ),
                    ),
                  ],
                ),
              ),
            ClamsSpacing.gapMd,
            const Icon(Icons.qr_code_scanner, size: 96, color: ClamsColors.primary),
            ClamsSpacing.gapXl,
            Text(_ready ? _status : 'Getting ready…', textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium),
            ClamsSpacing.gapXxl,
            FilledButton.icon(
              onPressed: _busy || !_ready ? null : _onQr,
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('Scan QR code'),
            ),
            ClamsSpacing.gapMd,
            OutlinedButton.icon(
              onPressed: _busy || !_ready ? null : _onManual,
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
