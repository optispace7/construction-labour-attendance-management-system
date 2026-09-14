import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/providers.dart';
import '../attendance/attendance_providers.dart';
import '../auth/auth_controller.dart';
import '../device/device_service.dart';

/// Watchman selects the active site. Only the choice is kept on the phone;
/// everything a scan needs is asked of the server at the moment of the scan.
class SiteSelectionScreen extends ConsumerStatefulWidget {
  const SiteSelectionScreen({super.key});

  @override
  ConsumerState<SiteSelectionScreen> createState() => _SiteSelectionScreenState();
}

class _SiteSelectionScreenState extends ConsumerState<SiteSelectionScreen> {
  List<Map<String, dynamic>> _sites = [];
  bool _loading = true;
  bool _devicePending = false;
  String? _deviceUid;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _devicePending = false;
      _error = null;
    });

    // The API rejects every call from non-super-admin users until this device
    // is approved — register it and hold here until an admin authorizes it.
    final role = ref.read(authControllerProvider).role;
    if (role != 'SUPER_ADMIN') {
      final DeviceStatus st;
      try {
        st = await ref
            .read(deviceServiceProvider)
            .ensureRegisteredAndAuthorized()
            .timeout(const Duration(seconds: 30));
      } catch (e) {
        // Never strand the operator on a spinner: show the failure and let
        // them retry or sign out.
        if (!mounted) return;
        setState(() {
          _error = 'Could not check this device: $e';
          _loading = false;
        });
        return;
      }
      if (!mounted) return;
      if (st.state == DeviceState.pending) {
        final uid = await ref.read(localDbProvider).getMeta('device_uid');
        if (!mounted) return;
        setState(() {
          _devicePending = true;
          _deviceUid = uid;
          _loading = false;
        });
        return;
      }
    }

    try {
      final dio = ref.read(apiClientProvider).dio;
      final res = await dio.get('/sites', queryParameters: {'active': 'true'});
      if (!mounted) return;
      setState(() {
        _sites = (res.data as List).cast<Map<String, dynamic>>();
        _error = null;
        _loading = false;
      });
    } on DioException catch (e) {
      if (!mounted) return;
      final code = e.response?.data is Map ? e.response?.data['code'] : null;
      if (e.response?.statusCode == 403 && code == 'DEVICE_NOT_AUTHORIZED') {
        final uid = await ref.read(localDbProvider).getMeta('device_uid');
        if (!mounted) return;
        setState(() {
          _devicePending = true;
          _deviceUid = uid;
          _loading = false;
        });
        return;
      }
      setState(() {
        _error = e.message ?? 'Could not load sites';
        _loading = false;
      });
    }
  }

  Future<void> _select(Map<String, dynamic> site) async {
    final db = ref.read(localDbProvider);
    final siteId = site['id'] as String;

    await db.setMeta('active_site', siteId);
    await db.setMeta('active_site_name', site['name'] as String);
    ref.read(activeSiteProvider.notifier).state = siteId;

    if (!mounted) return;
    final role = ref.read(authControllerProvider).role;
    context.go(role == 'SUPERVISOR' ? '/supervisor' : '/attendance');
  }

  Widget _devicePendingView() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(ClamsSpacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.phonelink_lock_outlined,
                size: 48, color: ClamsColors.warning),
            ClamsSpacing.gapMd,
            const Text(
              'Waiting for device approval',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              textAlign: TextAlign.center,
            ),
            ClamsSpacing.gapSm,
            Text(
              'Ask your Admin or Super Admin to approve this device in the '
              'Devices page.${_deviceUid != null ? '\nDevice: $_deviceUid' : ''}',
              style: const TextStyle(color: ClamsColors.textSecondary),
              textAlign: TextAlign.center,
            ),
            ClamsSpacing.gapLg,
            FilledButton.icon(
              onPressed: _load,
              icon: const Icon(Icons.refresh),
              label: const Text('Check again'),
            ),
            TextButton(
              onPressed: () => ref.read(authControllerProvider.notifier).logout(),
              child: const Text('Sign out'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Select site'),
        actions: [
          IconButton(
            tooltip: 'Refresh sites',
            icon: const Icon(Icons.refresh),
            onPressed: _load,
          ),
        ],
      ),
      body: _devicePending
          ? _devicePendingView()
          : _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: _error != null
                  ? ListView(children: [
                      Padding(
                        padding: const EdgeInsets.all(32),
                        child: Center(child: Text(_error!)),
                      ),
                    ])
                  : ListView.separated(
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.all(ClamsSpacing.lg),
                      itemCount: _sites.length,
                      separatorBuilder: (_, __) => ClamsSpacing.gapSm,
                      itemBuilder: (_, i) {
                        final s = _sites[i];
                        return Card(
                          child: ListTile(
                            leading: const Icon(Icons.location_city,
                                color: ClamsColors.primary),
                            title: Text(
                              s['name'] as String,
                              style: const TextStyle(fontWeight: FontWeight.w500),
                            ),
                            subtitle: Text(
                              s['code'] as String,
                              style:
                                  const TextStyle(color: ClamsColors.textSecondary),
                            ),
                            trailing: const Icon(Icons.chevron_right,
                                color: ClamsColors.textSecondary),
                            onTap: () => _select(s),
                          ),
                        );
                      },
                    ),
            ),
    );
  }
}
