import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/providers.dart';
import '../../core/widgets/api_image.dart';

/// One hand-typed punch waiting on a decision.
class ManualRequest {
  const ManualRequest({
    required this.id,
    required this.tapType,
    required this.recordedAt,
    required this.workerName,
    required this.workerCode,
    this.photoUrl,
    this.designation,
    this.vendor,
    this.siteName,
    this.reason,
  });

  final String id;
  final String tapType; // LOGIN | LOGOUT
  final DateTime recordedAt;
  final String workerName;
  final String workerCode;
  final String? photoUrl;
  final String? designation;
  final String? vendor;
  final String? siteName;
  final String? reason;

  bool get isLogin => tapType == 'LOGIN';

  factory ManualRequest.fromMap(Map<String, dynamic> m) {
    final worker = (m['worker'] as Map?) ?? const {};
    final site = (m['site'] as Map?) ?? const {};
    return ManualRequest(
      id: m['id'] as String,
      tapType: (m['tapType'] as String?) ?? 'LOGIN',
      recordedAt:
          DateTime.tryParse((m['recordedAt'] as String?) ?? '')?.toLocal() ?? DateTime.now(),
      workerName: (worker['fullName'] as String?) ?? 'Unknown',
      workerCode: (worker['workerCode'] as String?) ?? '',
      photoUrl: worker['photoUrl'] as String?,
      designation: (worker['designation'] as Map?)?['name'] as String?,
      vendor: (worker['vendor'] as Map?)?['name'] as String?,
      siteName: site['name'] as String?,
      reason: m['reason'] as String?,
    );
  }
}

/// The Safety Officer's queue: punches a watchman typed in by hand instead of
/// scanning a badge, each waiting to be accepted or declined.
///
/// Nothing in this list counts as attendance yet. Accepting is what puts the
/// person on the register — which is also what puts them in the fire headcount —
/// so the screen leads with how long each one has been waiting.
class ManualApprovalsScreen extends ConsumerStatefulWidget {
  const ManualApprovalsScreen({super.key});

  @override
  ConsumerState<ManualApprovalsScreen> createState() => _ManualApprovalsScreenState();
}

class _ManualApprovalsScreenState extends ConsumerState<ManualApprovalsScreen> {
  List<ManualRequest> _requests = [];
  bool _loading = true;
  String? _error;
  final _busy = <String>{};

  static final _time = DateFormat('d MMM, h:mm a');

  @override
  void initState() {
    super.initState();
    Future.microtask(_load);
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiClientProvider).dio.get('/manual-approvals');
      final data = (res.data as List).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() {
        _requests = data.map(ManualRequest.fromMap).toList();
        _loading = false;
      });
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.response?.data is Map
            ? ((e.response!.data as Map)['detail'] as String? ?? 'Could not load the queue')
            : (e.message ?? 'Could not load the queue');
        _loading = false;
      });
    }
  }

  Future<void> _review(ManualRequest r, {required bool accept}) async {
    final notes = await _askNotes(r, accept: accept);
    if (notes == null || !mounted) return;

    setState(() => _busy.add(r.id));
    try {
      await ref.read(apiClientProvider).dio.post(
        '/manual-approvals/${r.id}/${accept ? 'approve' : 'reject'}',
        data: {if (notes.isNotEmpty) 'reviewNotes': notes},
      );
      if (!mounted) return;
      setState(() => _requests.removeWhere((x) => x.id == r.id));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: accept ? ClamsColors.success : ClamsColors.textSecondary,
          content: Text(
            accept
                ? '${r.workerName} — ${r.isLogin ? 'login' : 'logout'} recorded'
                : '${r.workerName} — entry declined, attendance unchanged',
          ),
        ),
      );
    } on DioException catch (e) {
      if (!mounted) return;
      // The world may have moved since the watchman typed it in — the worker may
      // have turned up with their badge. The server says exactly what happened;
      // show that sentence rather than a generic failure.
      final body = e.response?.data;
      final message = body is Map
          ? (body['detail'] as String? ?? body['title'] as String? ?? 'Could not save')
          : 'Could not save — check your connection';
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            backgroundColor: ClamsColors.error,
            // The sentence names the badge scan that beat this entry and when —
            // several lines on a phone, and four seconds is not long enough to
            // read it before it disappears for good.
            duration: const Duration(seconds: 12),
            content: Text(message),
            action: SnackBarAction(
              label: 'Dismiss',
              textColor: Colors.white,
              onPressed: () => ScaffoldMessenger.of(context).hideCurrentSnackBar(),
            ),
          ),
        );
      await _load();
    } finally {
      if (mounted) setState(() => _busy.remove(r.id));
    }
  }

  Future<String?> _askNotes(ManualRequest r, {required bool accept}) {
    final controller = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(accept ? 'Accept this entry?' : 'Decline this entry?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              accept
                  ? '${r.workerName} will be recorded as ${r.isLogin ? 'logged in' : 'logged out'} '
                      'at ${_time.format(r.recordedAt)}.'
                  : "${r.workerName}'s attendance will be left exactly as it is. "
                      'Nothing is recorded.',
            ),
            ClamsSpacing.gapMd,
            TextField(
              controller: controller,
              decoration: InputDecoration(
                labelText: accept ? 'Note (optional)' : 'Reason (optional)',
                hintText: accept ? 'e.g. Saw him on site' : 'e.g. Not on site today',
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            style: accept
                ? null
                : FilledButton.styleFrom(backgroundColor: ClamsColors.error),
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: Text(accept ? 'Accept' : 'Decline'),
          ),
        ],
      ),
    );
  }

  /// How long this person has been off the register.
  String _waitingFor(DateTime since) {
    final mins = DateTime.now().difference(since).inMinutes;
    if (mins < 1) return 'just now';
    if (mins < 60) return '$mins min ago';
    final hours = mins ~/ 60;
    if (hours < 24) return '${hours}h ${mins % 60}m ago';
    return '${hours ~/ 24}d ago';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Manual entries'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: _load,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center),
                        ClamsSpacing.gapMd,
                        FilledButton(onPressed: _load, child: const Text('Try again')),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: _requests.isEmpty ? _emptyState() : _list(),
                ),
    );
  }

  Widget _emptyState() {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        const SizedBox(height: 120),
        const Icon(Icons.done_all, size: 72, color: ClamsColors.success),
        ClamsSpacing.gapXl,
        Text(
          'Nothing waiting',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        ClamsSpacing.gapSm,
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 32),
          child: Text(
            'Punches a watchman types in by hand appear here until you accept or '
            'decline them.',
            textAlign: TextAlign.center,
            style: TextStyle(color: ClamsColors.textSecondary),
          ),
        ),
      ],
    );
  }

  Widget _list() {
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(ClamsSpacing.md),
      itemCount: _requests.length,
      separatorBuilder: (_, __) => ClamsSpacing.gapMd,
      itemBuilder: (_, i) {
        final r = _requests[i];
        final busy = _busy.contains(r.id);
        return Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(ClamsSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    ApiCircleAvatar(photoUrl: r.photoUrl),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(r.workerName,
                              style: const TextStyle(fontWeight: FontWeight.w600)),
                          Text(
                            [
                              r.workerCode,
                              if (r.designation != null) r.designation!,
                              if (r.vendor != null) r.vendor!,
                            ].join(' · '),
                            style: const TextStyle(color: ClamsColors.textSecondary),
                          ),
                        ],
                      ),
                    ),
                    Chip(
                      visualDensity: VisualDensity.compact,
                      backgroundColor:
                          r.isLogin ? ClamsColors.successTint : ClamsColors.warningTint,
                      side: BorderSide.none,
                      label: Text(
                        r.isLogin ? 'LOGIN' : 'LOGOUT',
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          color: r.isLogin ? ClamsColors.success : ClamsColors.warning,
                        ),
                      ),
                    ),
                  ],
                ),
                ClamsSpacing.gapMd,
                _row(Icons.schedule, '${_time.format(r.recordedAt)} · '
                    'waiting ${_waitingFor(r.recordedAt)}'),
                if (r.siteName != null) _row(Icons.location_city, r.siteName!),
                if (r.reason != null && r.reason!.isNotEmpty)
                  _row(Icons.edit_note, 'Reason given: ${r.reason}'),
                ClamsSpacing.gapMd,
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(foregroundColor: ClamsColors.error),
                        onPressed: busy ? null : () => _review(r, accept: false),
                        icon: const Icon(Icons.close),
                        label: const Text('Decline'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: busy ? null : () => _review(r, accept: true),
                        icon: const Icon(Icons.check),
                        label: const Text('Accept'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _row(IconData icon, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: ClamsColors.textSecondary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: const TextStyle(color: ClamsColors.textSecondary)),
          ),
        ],
      ),
    );
  }
}
