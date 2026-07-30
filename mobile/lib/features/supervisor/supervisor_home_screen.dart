import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/providers.dart';
import '../../core/widgets/api_image.dart';
import '../aadhaar/aadhaar_verify_screen.dart';
import '../attendance/attendance_providers.dart';
import '../attendance/domain/models.dart';
import '../auth/auth_controller.dart';
import '../device/device_service.dart';
import '../printing/badge_printer.dart';
import '../printing/bulk_print_screen.dart';
import '../printing/print_cards.dart';
import '../safety/safety_daily_screen.dart';
import '../sos/notification_watcher.dart';
import '../sos/sos_button.dart';
import 'day_summary_screen.dart';
import 'manual_approvals_screen.dart';
import 'supervisor_summary_screen.dart';
import 'worker_edit_screen.dart';

/// Safety Officer view: manage workers at the active site — register new
/// workers/staff/visitors (with photo + QR badge), check monthly summaries,
/// print badges (single or bulk for today's entries) and verify Aadhaar QRs.
class SupervisorHomeScreen extends ConsumerStatefulWidget {
  const SupervisorHomeScreen({super.key});

  @override
  ConsumerState<SupervisorHomeScreen> createState() => _SupervisorHomeScreenState();
}

class _SupervisorHomeScreenState extends ConsumerState<SupervisorHomeScreen> {
  String _siteName = '';
  String? _siteId;
  List<WorkerCard> _workers = [];
  bool _loading = true;
  String? _error;
  String _q = '';

  /// Device approval gate — supervisors are blocked server-side until an admin
  /// authorizes this phone, so no worker data may load before that.
  bool _deviceBlocked = false;
  String? _deviceUid;

  /// Hand-typed punches waiting on this officer. Every one of these is a person
  /// who is NOT on the register — and so not in the fire headcount — until it is
  /// reviewed, which is why it gets a banner rather than a menu item alone.
  int _pendingManual = 0;

  @override
  void initState() {
    super.initState();
    Future.microtask(_load);
  }

  static bool _isDeviceNotAuthorized(DioException e) {
    if (e.response?.statusCode != 403) return false;
    final data = e.response?.data;
    return data is Map && data['code'] == 'DEVICE_NOT_AUTHORIZED';
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final db = ref.read(localDbProvider);
    _siteId = await db.getMeta('active_site');
    _siteName = await db.getMeta('active_site_name') ?? '';

    // Register this device (idempotent) and try to obtain a device token —
    // granted only once an admin AUTHORIZES the device.
    final st = await ref.read(deviceServiceProvider).ensureRegisteredAndAuthorized();
    _deviceUid = await db.getMeta('device_uid');
    if (!mounted) return;
    if (st.state != DeviceState.authorized) {
      setState(() {
        _deviceBlocked = true;
        _loading = false;
      });
      return;
    }

    try {
      final dio = ref.read(apiClientProvider).dio;
      final res = await dio.get('/workers/by-site', queryParameters: {'siteId': _siteId});
      final data = (res.data['data'] as List).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() {
        _deviceBlocked = false;
        _workers = data.map(WorkerCard.fromMap).toList();
        _loading = false;
        _error = null;
      });
      await _loadPendingManual();
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        if (_isDeviceNotAuthorized(e)) {
          _deviceBlocked = true;
        } else {
          _error = e.message ?? 'Could not load workers';
        }
        _loading = false;
      });
    }
  }

  /// Best-effort: a queue this officer cannot count right now must not stop the
  /// worker list from loading.
  Future<void> _loadPendingManual() async {
    try {
      final res = await ref.read(apiClientProvider).dio.get('/manual-approvals/pending-count');
      final n = (res.data is Map ? (res.data as Map)['pending'] as num? : null)?.toInt() ?? 0;
      if (mounted) setState(() => _pendingManual = n);
    } catch (_) {
      // Offline or not permitted — leave the count as it was.
    }
  }

  Future<void> _openManualApprovals() async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const ManualApprovalsScreen()),
    );
    await _loadPendingManual();
  }

  Widget _deviceBlockedScreen() {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.phonelink_lock,
                      size: 96, color: ClamsColors.accent),
                  ClamsSpacing.gapXl,
                  Text(
                    'Waiting for device approval',
                    textAlign: TextAlign.center,
                    style: Theme.of(context)
                        .textTheme
                        .titleLarge
                        ?.copyWith(fontWeight: FontWeight.w600),
                  ),
                  ClamsSpacing.gapMd,
                  Text(
                    'Ask your Admin or Super Admin to approve this device in the '
                    'Devices page.\n\nDevice: ${_deviceUid ?? 'unknown'}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: ClamsColors.textSecondary),
                  ),
                  ClamsSpacing.gapXl,
                  FilledButton.icon(
                    onPressed: _load,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Retry'),
                  ),
                  ClamsSpacing.gapMd,
                  OutlinedButton.icon(
                    onPressed: () => ref.read(authControllerProvider.notifier).logout(),
                    icon: const Icon(Icons.logout),
                    label: const Text('Sign out'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _openSummary(WorkerCard w) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SupervisorSummaryScreen(worker: w)),
    );
  }

  /// Ask what kind of person is being registered, then open the form on that
  /// category. The form can add staff and visitors too — this makes it reachable
  /// instead of hiding it behind a "Type" dropdown labelled "Add worker".
  Future<void> _addPerson() async {
    final category = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Who are you adding?',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            ),
            ListTile(
              leading: const Icon(Icons.engineering, color: ClamsColors.primary),
              title: const Text('Labour / worker'),
              subtitle: const Text('Contractor worker with an induction card'),
              onTap: () => Navigator.pop(ctx, 'WORKER'),
            ),
            ListTile(
              leading: const Icon(Icons.badge_outlined, color: ClamsColors.primary),
              title: const Text('Staff'),
              subtitle: const Text('Company employee — minimum details only'),
              onTap: () => Navigator.pop(ctx, 'STAFF'),
            ),
            ListTile(
              leading: const Icon(Icons.person_outline, color: ClamsColors.primary),
              title: const Text('Visitor'),
              subtitle: const Text('Short visit — escort and ID proof'),
              onTap: () => Navigator.pop(ctx, 'VISITOR'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (category == null || !mounted) return;
    final created = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => WorkerEditScreen(initialCategory: category)),
    );
    if (created == true) _load();
  }

  Future<void> _editWorker(WorkerCard w) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => WorkerEditScreen(workerId: w.id)),
    );
    if (changed == true) _load();
  }

  Future<void> _printBadge(WorkerCard w) async {
    await printWorkerCards(context, ref, [
      BadgeData(
        fullName: w.fullName,
        workerCode: w.workerCode,
        designation: w.designationName,
        vendor: w.vendorName,
        siteName: _siteName.isEmpty ? null : _siteName,
        bloodGroup: w.bloodGroup,
        emergencyName: w.emergencyContactName,
        emergencyNumber: w.emergencyContactNumber,
        photoUrl: w.photoUrl,
        isVisitor: w.category == 'VISITOR',
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    if (_deviceBlocked && !_loading) return _deviceBlockedScreen();

    final filtered = _q.isEmpty
        ? _workers
        : _workers
            .where((w) =>
                w.fullName.toLowerCase().contains(_q.toLowerCase()) ||
                w.workerCode.toLowerCase().contains(_q.toLowerCase()))
            .toList();

    return Scaffold(
      appBar: AppBar(
        title: Text(_siteName.isEmpty ? 'Safety Officer' : 'Safety Officer · $_siteName'),
        actions: [
          const SosButton(compact: true),
          IconButton(
            tooltip: 'Manual entries waiting for approval',
            onPressed: _openManualApprovals,
            icon: Badge(
              isLabelVisible: _pendingManual > 0,
              label: Text('$_pendingManual'),
              child: const Icon(Icons.rule),
            ),
          ),
          PopupMenuButton<String>(
            onSelected: (v) {
              switch (v) {
                case 'manual':
                  _openManualApprovals();
                  break;
                case 'safety-daily':
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const SafetyDailyScreen()));
                  break;
                case 'day-summary':
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const DaySummaryScreen()));
                  break;
                case 'bulk-print':
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const BulkPrintScreen()));
                  break;
                case 'aadhaar':
                  Navigator.of(context)
                      .push(MaterialPageRoute(builder: (_) => const AadhaarVerifyScreen()));
                  break;
                case 'site':
                  context.go('/site');
                  break;
                case 'logout':
                  ref.read(authControllerProvider.notifier).logout();
                  break;
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(
                value: 'manual',
                child: ListTile(
                  leading: Icon(Icons.rule),
                  title: Text('Manual entries'),
                  subtitle: Text('Accept or decline hand-typed punches'),
                ),
              ),
              PopupMenuItem(
                value: 'safety-daily',
                child: ListTile(
                  leading: Icon(Icons.health_and_safety_outlined),
                  title: Text('Daily task'),
                  subtitle: Text("Today's safety figures"),
                ),
              ),
              PopupMenuItem(
                value: 'day-summary',
                child: ListTile(
                  leading: Icon(Icons.summarize_outlined),
                  title: Text('Attendance summary'),
                  subtitle: Text('By designation and contractor · PDF'),
                ),
              ),
              PopupMenuItem(
                value: 'bulk-print',
                child: ListTile(
                  leading: Icon(Icons.print),
                  title: Text("Print today's badges"),
                ),
              ),
              PopupMenuItem(
                value: 'aadhaar',
                child: ListTile(
                  leading: Icon(Icons.verified_user),
                  title: Text('Verify Aadhaar QR'),
                ),
              ),
              PopupMenuItem(
                value: 'site',
                child: ListTile(
                  leading: Icon(Icons.location_city),
                  title: Text('Change site'),
                ),
              ),
              PopupMenuItem(
                value: 'logout',
                child: ListTile(leading: Icon(Icons.logout), title: Text('Logout')),
              ),
            ],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _addPerson,
        icon: const Icon(Icons.person_add),
        label: const Text('Add person'),
      ),
      body: NotificationWatcher(
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
                ? Center(child: Text(_error!))
                : RefreshIndicator(
                    onRefresh: _load,
                    child: Column(
                      children: [
                        // These people are not on the register until this is
                        // cleared, so it sits above the worker list rather than
                        // behind a menu.
                        if (_pendingManual > 0)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(
                                ClamsSpacing.md, ClamsSpacing.md, ClamsSpacing.md, 0),
                            child: Material(
                              color: ClamsColors.warningTint,
                              borderRadius: BorderRadius.circular(ClamsRadius.card),
                              child: InkWell(
                                borderRadius: BorderRadius.circular(ClamsRadius.card),
                                onTap: _openManualApprovals,
                                child: Padding(
                                  padding: const EdgeInsets.all(ClamsSpacing.md),
                                  child: Row(
                                    children: [
                                      const Icon(Icons.hourglass_top,
                                          color: ClamsColors.warning),
                                      const SizedBox(width: 12),
                                      Expanded(
                                        child: Text(
                                          '$_pendingManual manual '
                                          '${_pendingManual == 1 ? 'entry is' : 'entries are'} '
                                          'waiting for you. Until you accept them, those '
                                          'people are not counted as on site.',
                                          style: const TextStyle(
                                              color: ClamsColors.textSecondary),
                                        ),
                                      ),
                                      const Icon(Icons.chevron_right,
                                          color: ClamsColors.textSecondary),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ),
                        Padding(
                          padding: const EdgeInsets.all(ClamsSpacing.md),
                          child: TextField(
                            decoration: const InputDecoration(
                              labelText: 'Search worker',
                              prefixIcon: Icon(Icons.search),
                            ),
                            onChanged: (v) => setState(() => _q = v),
                          ),
                        ),
                        Expanded(
                          child: Container(
                            color: ClamsColors.surface,
                            child: ListView.separated(
                            physics: const AlwaysScrollableScrollPhysics(),
                            itemCount: filtered.length,
                            separatorBuilder: (_, __) => const Divider(height: 1),
                            itemBuilder: (_, i) {
                              final w = filtered[i];
                              return ListTile(
                                leading: ApiCircleAvatar(photoUrl: w.photoUrl),
                                title: Text(w.fullName,
                                    style:
                                        const TextStyle(fontWeight: FontWeight.w500)),
                                subtitle: Text(
                                  [
                                    w.workerCode,
                                    if (w.designationName != null) w.designationName!,
                                    if (w.category != null && w.category != 'WORKER') w.category!,
                                  ].join(' · '),
                                  style: const TextStyle(
                                      color: ClamsColors.textSecondary),
                                ),
                                onTap: () => _openSummary(w),
                                trailing: PopupMenuButton<String>(
                                  onSelected: (v) {
                                    switch (v) {
                                      case 'summary':
                                        _openSummary(w);
                                        break;
                                      case 'edit':
                                        _editWorker(w);
                                        break;
                                      case 'print':
                                        _printBadge(w);
                                        break;
                                    }
                                  },
                                  itemBuilder: (_) => const [
                                    PopupMenuItem(
                                      value: 'summary',
                                      child: ListTile(
                                        leading: Icon(Icons.bar_chart),
                                        title: Text('Attendance summary'),
                                      ),
                                    ),
                                    PopupMenuItem(
                                      value: 'edit',
                                      child: ListTile(
                                        leading: Icon(Icons.edit),
                                        title: Text('Edit details'),
                                      ),
                                    ),
                                    PopupMenuItem(
                                      value: 'print',
                                      child: ListTile(
                                        leading: Icon(Icons.print),
                                        title: Text('Print QR badge'),
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            },
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
      ),
    );
  }
}
