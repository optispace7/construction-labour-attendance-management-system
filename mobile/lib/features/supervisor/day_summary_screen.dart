import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../app/theme.dart';
import '../../core/providers.dart';
import '../../core/widgets/section_header.dart';
import 'day_summary_image.dart';

/// One row of a breakdown: a designation or a contractor, how many of them
/// logged in, and how many of those are still on site.
class _Group {
  const _Group(this.name, this.count, this.active);
  final String name;
  final int count;
  final int active;

  static _Group from(Map<String, dynamic> m, String key) => _Group(
        (m[key] as String?) ?? '—',
        ((m['count'] as num?) ?? 0).toInt(),
        ((m['active'] as num?) ?? 0).toInt(),
      );
}

/// The Safety Officer's day sheet: who logged in on the active site and who is
/// still on it, split by designation and by contractor.
///
/// Opens on today because that is the question at a gate, but any earlier date
/// can be picked — "how many did we have on Tuesday" is asked constantly and the
/// officer should not have to ring the office for it. The PDF is rendered by the
/// API from these same figures, so the sheet handed over cannot disagree with
/// the screen it was read from.
class DaySummaryScreen extends ConsumerStatefulWidget {
  const DaySummaryScreen({super.key});

  @override
  ConsumerState<DaySummaryScreen> createState() => _DaySummaryScreenState();
}

class _DaySummaryScreenState extends ConsumerState<DaySummaryScreen> {
  static final _dayLabel = DateFormat('EEE, d MMM yyyy');

  DateTime _date = DateTime.now();
  String? _siteId;
  String _siteName = '';

  int _total = 0;
  int _activeNow = 0;
  List<_Group> _byDesignation = const [];
  List<_Group> _byVendor = const [];

  bool _loading = true;
  bool _downloading = false;
  String? _error;
  SummaryOrg? _orgHeader;

  /// Date-only, in the device's calendar — the API keys the day off this.
  String get _dateParam =>
      '${_date.year}-${_date.month.toString().padLeft(2, '0')}-${_date.day.toString().padLeft(2, '0')}';

  bool get _isToday {
    final now = DateTime.now();
    return _date.year == now.year && _date.month == now.month && _date.day == now.day;
  }

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
    final db = ref.read(localDbProvider);
    _siteId = await db.getMeta('active_site');
    _siteName = await db.getMeta('active_site_name') ?? '';

    try {
      final res = await ref.read(apiClientProvider).dio.get(
        '/attendance/day-summary',
        queryParameters: {
          if (_siteId != null) 'siteId': _siteId,
          'date': _dateParam,
        },
      );
      final m = (res.data as Map).cast<String, dynamic>();
      if (!mounted) return;
      setState(() {
        _total = ((m['total'] as num?) ?? 0).toInt();
        _activeNow = ((m['activeNow'] as num?) ?? 0).toInt();
        _byDesignation = ((m['byDesignation'] as List?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map((e) => _Group.from(e, 'designation'))
            .toList();
        _byVendor = ((m['byVendor'] as List?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map((e) => _Group.from(e, 'vendor'))
            .toList();
        _loading = false;
      });
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.response?.data is Map
            ? ((e.response!.data as Map)['detail'] as String? ?? 'Could not load the summary')
            : (e.message ?? 'Could not load the summary');
        _loading = false;
      });
    }
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      // Attendance cannot exist in the future, and a year back covers any
      // question that is not really a report request.
      firstDate: DateTime(now.year - 1, now.month, now.day),
      lastDate: now,
    );
    if (picked == null || !mounted) return;
    setState(() => _date = picked);
    await _load();
  }

  /// Company name and logo for the sheet header, fetched once per screen.
  /// Best-effort: a sheet without the letterhead still carries the numbers.
  Future<SummaryOrg> _org() async {
    final cached = _orgHeader;
    if (cached != null) return cached;
    final dio = ref.read(apiClientProvider).dio;
    try {
      final res = await dio.get('/organizations/current');
      final m = (res.data as Map).cast<String, dynamic>();
      final logoUrl = m['logoUrl'] as String?;
      Uint8List? logo;
      if (logoUrl != null && logoUrl.isNotEmpty) {
        final img = await dio.get<List<int>>(
          logoUrl,
          options: Options(responseType: ResponseType.bytes),
        );
        final b = Uint8List.fromList(img.data ?? const []);
        if (b.isNotEmpty) logo = b;
      }
      return _orgHeader = SummaryOrg(
        name: m['name'] as String?,
        logoBytes: logo,
        logoScale: (m['logoScale'] as num?)?.toDouble() ?? 1.0,
      );
    } catch (_) {
      return _orgHeader = const SummaryOrg();
    }
  }

  /// Render the day as a picture and hand it to the OS share sheet, which is
  /// where WhatsApp, mail and "save to the phone" all live on Android.
  ///
  /// The image is drawn from the figures already on this screen, so what gets
  /// sent cannot disagree with what the officer read before sending it.
  Future<void> _shareImage(SummaryAudience audience) async {
    setState(() => _downloading = true);
    try {
      final org = await _org();
      if (!mounted) return;
      await precacheSummaryLogo(context, org.logoBytes);
      if (!mounted) return;

      final png = await renderSummaryPng(
        context,
        DaySummarySheet(
          audience: audience,
          org: org,
          siteName: _siteName,
          dateLabel: _dayLabel.format(_date),
          byDesignation: [
            for (final g in _byDesignation) SummaryLine(g.name, g.count),
          ],
          byVendor: [
            for (final g in _byVendor) SummaryLine(g.name, g.count),
          ],
        ),
      );

      final suffix = audience == SummaryAudience.client ? 'client' : 'internal';
      final file = File(
        '${(await getTemporaryDirectory()).path}/manpower-$_dateParam-$suffix.png',
      );
      await file.writeAsBytes(png, flush: true);

      final site = _siteName.isEmpty ? '' : '$_siteName · ';
      await Share.shareXFiles(
        [XFile(file.path, mimeType: 'image/png')],
        text: 'Daily manpower — $site${_dayLabel.format(_date)}',
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not build the image. $e')),
      );
    } finally {
      if (mounted) setState(() => _downloading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasRows = _byDesignation.isNotEmpty || _byVendor.isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Attendance summary'),
        actions: [
          IconButton(
            tooltip: 'Change date',
            onPressed: _loading ? null : _pickDate,
            icon: const Icon(Icons.calendar_today_outlined),
          ),
        ],
      ),
      // Two buttons rather than one with a chooser: the difference between them
      // is who may see the contractor split, and a label you read before tapping
      // is a better guard against sending the wrong one than a menu you dismiss.
      bottomNavigationBar: _shareBar(enabled: !_loading && !_downloading && hasRows),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(ClamsSpacing.xl),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(_error!, textAlign: TextAlign.center),
                        ClamsSpacing.gapLg,
                        FilledButton.icon(
                          onPressed: _load,
                          icon: const Icon(Icons.refresh),
                          label: const Text('Retry'),
                        ),
                      ],
                    ),
                  ),
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(
                      ClamsSpacing.lg,
                      ClamsSpacing.lg,
                      ClamsSpacing.lg,
                      96,
                    ),
                    children: [
                      _dateBar(),
                      ClamsSpacing.gapLg,
                      _headline(),
                      ClamsSpacing.gapXl,
                      const SectionHeader('By designation'),
                      ClamsSpacing.gapSm,
                      _table('Designation', _byDesignation),
                      ClamsSpacing.gapXl,
                      const SectionHeader('By vendor / contractor'),
                      ClamsSpacing.gapSm,
                      _table('Vendor', _byVendor),
                    ],
                  ),
                ),
    );
  }

  /// The two things this screen is for once the numbers have been read: send
  /// the trades to the client, or the whole picture to the internal group.
  Widget _shareBar({required bool enabled}) => SafeArea(
        top: false,
        child: Container(
          padding: const EdgeInsets.fromLTRB(
            ClamsSpacing.lg,
            ClamsSpacing.md,
            ClamsSpacing.lg,
            ClamsSpacing.md,
          ),
          decoration: const BoxDecoration(
            color: ClamsColors.surface,
            border: Border(top: BorderSide(color: ClamsColors.border)),
          ),
          child: Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: enabled ? () => _shareImage(SummaryAudience.client) : null,
                  icon: _downloading
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.image_outlined, size: 20),
                  label: const Text('For client'),
                ),
              ),
              const SizedBox(width: ClamsSpacing.md),
              Expanded(
                child: FilledButton.icon(
                  onPressed: enabled ? () => _shareImage(SummaryAudience.internal) : null,
                  icon: const Icon(Icons.groups_outlined, size: 20),
                  label: const Text('Internal'),
                ),
              ),
            ],
          ),
        ),
      );

  Widget _dateBar() => Material(
        color: ClamsColors.surface,
        borderRadius: BorderRadius.circular(ClamsRadius.card),
        child: InkWell(
          borderRadius: BorderRadius.circular(ClamsRadius.card),
          onTap: _pickDate,
          child: Container(
            padding: const EdgeInsets.all(ClamsSpacing.lg),
            decoration: BoxDecoration(
              border: Border.all(color: ClamsColors.border),
              borderRadius: BorderRadius.circular(ClamsRadius.card),
            ),
            child: Row(
              children: [
                const Icon(Icons.event, size: 20, color: ClamsColors.textSecondary),
                const SizedBox(width: ClamsSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _isToday ? 'Today · ${_dayLabel.format(_date)}' : _dayLabel.format(_date),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                      if (_siteName.isNotEmpty)
                        Text(
                          _siteName,
                          style: const TextStyle(
                            fontSize: 12,
                            color: ClamsColors.textSecondary,
                          ),
                        ),
                    ],
                  ),
                ),
                const Icon(Icons.expand_more, color: ClamsColors.textSecondary),
              ],
            ),
          ),
        ),
      );

  /// The two numbers the gate actually asks for, side by side: how many came,
  /// and how many are still here.
  Widget _headline() => Row(
        children: [
          Expanded(child: _stat('Logged in', _total, ClamsColors.text)),
          const SizedBox(width: ClamsSpacing.md),
          Expanded(child: _stat('On site now', _activeNow, ClamsColors.primary)),
        ],
      );

  Widget _stat(String label, int value, Color color) => Container(
        padding: const EdgeInsets.all(ClamsSpacing.lg),
        decoration: BoxDecoration(
          color: ClamsColors.surface,
          border: Border.all(color: ClamsColors.border),
          borderRadius: BorderRadius.circular(ClamsRadius.card),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label.toUpperCase(),
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.8,
                color: ClamsColors.textSecondary,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '$value',
              style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: color),
            ),
          ],
        ),
      );

  Widget _table(String groupHeader, List<_Group> rows) {
    if (rows.isEmpty) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(ClamsSpacing.lg),
        decoration: BoxDecoration(
          color: ClamsColors.surface,
          border: Border.all(color: ClamsColors.border),
          borderRadius: BorderRadius.circular(ClamsRadius.card),
        ),
        child: const Text(
          'No logins recorded on this day.',
          style: TextStyle(color: ClamsColors.textSecondary),
        ),
      );
    }

    final totalCount = rows.fold<int>(0, (a, b) => a + b.count);
    final totalActive = rows.fold<int>(0, (a, b) => a + b.active);

    return Container(
      decoration: BoxDecoration(
        color: ClamsColors.surface,
        border: Border.all(color: ClamsColors.border),
        borderRadius: BorderRadius.circular(ClamsRadius.card),
      ),
      child: Column(
        children: [
          _row(
            groupHeader.toUpperCase(),
            'LOGGED IN',
            'ON SITE',
            header: true,
          ),
          for (final r in rows)
            _row(r.name, '${r.count}', '${r.active}', highlight: r.active > 0),
          const Divider(height: 1),
          _row('Total', '$totalCount', '$totalActive', bold: true),
        ],
      ),
    );
  }

  Widget _row(
    String name,
    String count,
    String active, {
    bool header = false,
    bool bold = false,
    bool highlight = false,
  }) {
    final labelStyle = header
        ? const TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.6,
            color: ClamsColors.textSecondary,
          )
        : TextStyle(
            fontSize: 14,
            fontWeight: bold ? FontWeight.w700 : FontWeight.w400,
            color: ClamsColors.text,
          );
    final numStyle = header
        ? labelStyle
        : TextStyle(
            fontSize: 14,
            fontWeight: bold ? FontWeight.w700 : FontWeight.w500,
            color: ClamsColors.textSecondary,
          );
    final activeStyle = header
        ? labelStyle
        : TextStyle(
            fontSize: 14,
            fontWeight: (bold || highlight) ? FontWeight.w700 : FontWeight.w500,
            color: highlight || bold ? ClamsColors.primary : ClamsColors.textSecondary,
          );

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: ClamsSpacing.lg,
        vertical: header ? ClamsSpacing.md : ClamsSpacing.md - 2,
      ),
      child: Row(
        children: [
          Expanded(child: Text(name, style: labelStyle, overflow: TextOverflow.ellipsis)),
          SizedBox(width: 76, child: Text(count, style: numStyle, textAlign: TextAlign.right)),
          SizedBox(width: 66, child: Text(active, style: activeStyle, textAlign: TextAlign.right)),
        ],
      ),
    );
  }
}
