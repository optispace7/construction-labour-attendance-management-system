import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../app/theme.dart';
import '../../core/providers.dart';

/// One tracked safety item for a day.
class SafetyItem {
  SafetyItem({
    required this.metric,
    required this.label,
    required this.kind,
    required this.group,
    this.value,
    this.comment,
    this.entryId,
  });

  final String metric;
  final String label;
  final String kind; // AUTOMATED | MANUAL
  final String group;
  final int? value;
  final String? comment;
  final String? entryId;

  bool get isAutomated => kind == 'AUTOMATED';

  factory SafetyItem.fromMap(Map<String, dynamic> m) => SafetyItem(
        metric: m['metric'] as String,
        label: (m['label'] as String?) ?? '',
        kind: (m['kind'] as String?) ?? 'MANUAL',
        group: (m['group'] as String?) ?? 'Other',
        value: (m['value'] as num?)?.toInt(),
        comment: m['comment'] as String?,
        entryId: m['entryId'] as String?,
      );
}

/// The Safety Officer's daily task sheet, on the phone.
///
/// Three figures come from attendance and are shown read-only; the rest are the
/// officer's own count. Every item — derived ones included — takes an optional
/// comment, which is where the context that a number cannot carry ends up.
///
/// Writes always go to the active site: the figures belong to a site, and there
/// is no company-wide row to save into.
class SafetyDailyScreen extends ConsumerStatefulWidget {
  const SafetyDailyScreen({super.key});

  @override
  ConsumerState<SafetyDailyScreen> createState() => _SafetyDailyScreenState();
}

class _SafetyDailyScreenState extends ConsumerState<SafetyDailyScreen> {
  static final _dayLabel = DateFormat('EEE, d MMM yyyy');

  DateTime _date = DateTime.now();
  String? _siteId;
  String _siteName = '';
  List<SafetyItem> _items = const [];

  /// Pending edits keyed by metric. Absent means untouched.
  final Map<String, String> _values = {};
  final Map<String, String> _comments = {};

  bool _loading = true;
  bool _saving = false;
  String? _error;

  String get _dateParam =>
      '${_date.year}-${_date.month.toString().padLeft(2, '0')}-${_date.day.toString().padLeft(2, '0')}';

  bool get _isToday {
    final now = DateTime.now();
    return _date.year == now.year && _date.month == now.month && _date.day == now.day;
  }

  bool get _dirty => _values.isNotEmpty || _comments.isNotEmpty;

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
        '/safety/daily',
        queryParameters: {if (_siteId != null) 'siteId': _siteId, 'date': _dateParam},
      );
      final m = (res.data as Map).cast<String, dynamic>();
      if (!mounted) return;
      setState(() {
        _items = ((m['items'] as List?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map(SafetyItem.fromMap)
            .toList();
        _values.clear();
        _comments.clear();
        _loading = false;
      });
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.response?.data is Map
            ? ((e.response!.data as Map)['detail'] as String? ?? 'Could not load the sheet')
            : (e.message ?? 'Could not load the sheet');
        _loading = false;
      });
    }
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(now.year - 1, now.month, now.day),
      lastDate: now,
    );
    if (picked == null || !mounted) return;
    setState(() => _date = picked);
    await _load();
  }

  Future<void> _save() async {
    if (_siteId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Pick a site first, from Change site.')),
      );
      return;
    }
    setState(() => _saving = true);
    try {
      final touched = <String>{..._values.keys, ..._comments.keys};
      final payload = _items.where((i) => touched.contains(i.metric)).map((i) {
        final raw = _values[i.metric] ?? (i.value?.toString() ?? '');
        final comment = _comments[i.metric] ?? i.comment ?? '';
        return {
          'metric': i.metric,
          // Blank clears back to "not filled in", which is not the same as zero.
          'value': i.isAutomated || raw.trim().isEmpty ? null : int.tryParse(raw.trim()),
          'comment': comment.trim().isEmpty ? null : comment.trim(),
        };
      }).toList();

      await ref.read(apiClientProvider).dio.put(
        '/safety/daily',
        data: {'siteId': _siteId, 'date': _dateParam, 'items': payload},
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved.')));
      await _load();
    } on DioException catch (e) {
      if (!mounted) return;
      final detail = e.response?.data is Map
          ? ((e.response!.data as Map)['detail'] as String?)
          : null;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(detail ?? e.message ?? 'Could not save.')),
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Preserve the catalogue's order within each group.
    final groups = <String, List<SafetyItem>>{};
    for (final i in _items) {
      groups.putIfAbsent(i.group, () => []).add(i);
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Daily task'),
        actions: [
          IconButton(
            tooltip: 'Change date',
            onPressed: _loading ? null : _pickDate,
            icon: const Icon(Icons.calendar_today_outlined),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: (_loading || _saving || !_dirty) ? null : _save,
        backgroundColor:
            (_loading || _saving || !_dirty) ? ClamsColors.border : ClamsColors.primary,
        icon: _saving
            ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
              )
            : const Icon(Icons.save_outlined),
        label: Text(_saving ? 'Saving…' : 'Save'),
      ),
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
              : ListView(
                  padding: const EdgeInsets.fromLTRB(
                    ClamsSpacing.lg,
                    ClamsSpacing.lg,
                    ClamsSpacing.lg,
                    96,
                  ),
                  children: [
                    _dateBar(),
                    if (_dirty) ...[
                      ClamsSpacing.gapMd,
                      Container(
                        padding: const EdgeInsets.all(ClamsSpacing.md),
                        decoration: BoxDecoration(
                          color: ClamsColors.infoTint,
                          borderRadius: BorderRadius.circular(ClamsRadius.card),
                        ),
                        child: const Row(
                          children: [
                            Icon(Icons.info_outline, size: 18, color: ClamsColors.info),
                            SizedBox(width: ClamsSpacing.sm),
                            Expanded(
                              child: Text(
                                'Nothing is recorded until you press Save.',
                                style: TextStyle(fontSize: 13, color: ClamsColors.textSecondary),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    for (final entry in groups.entries) ...[
                      ClamsSpacing.gapXl,
                      Text(
                        entry.key.toUpperCase(),
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.8,
                          color: ClamsColors.textSecondary,
                        ),
                      ),
                      ClamsSpacing.gapSm,
                      ...entry.value.map(_itemCard),
                    ],
                  ],
                ),
    );
  }

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

  Widget _itemCard(SafetyItem it) {
    return Padding(
      padding: const EdgeInsets.only(bottom: ClamsSpacing.sm),
      child: Container(
        padding: const EdgeInsets.all(ClamsSpacing.md),
        decoration: BoxDecoration(
          color: ClamsColors.surface,
          border: Border.all(color: ClamsColors.border),
          borderRadius: BorderRadius.circular(ClamsRadius.card),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    it.label,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: it.isAutomated ? ClamsColors.successTint : ClamsColors.background,
                    borderRadius: BorderRadius.circular(ClamsRadius.control),
                    border: Border.all(
                      color: it.isAutomated ? ClamsColors.success : ClamsColors.border,
                    ),
                  ),
                  child: Text(
                    it.isAutomated ? 'Automated' : 'Manual',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w600,
                      color: it.isAutomated ? ClamsColors.success : ClamsColors.textSecondary,
                    ),
                  ),
                ),
              ],
            ),
            ClamsSpacing.gapSm,
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 110,
                  child: it.isAutomated
                      ? InputDecorator(
                          decoration: const InputDecoration(
                            labelText: 'From attendance',
                            isDense: true,
                          ),
                          child: Text(
                            it.value?.toString() ?? '—',
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                        )
                      : TextFormField(
                          initialValue: it.value?.toString() ?? '',
                          keyboardType: TextInputType.number,
                          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                          decoration: const InputDecoration(labelText: 'Count'),
                          onChanged: (v) => setState(() => _values[it.metric] = v),
                        ),
                ),
                const SizedBox(width: ClamsSpacing.md),
                Expanded(
                  child: TextFormField(
                    initialValue: it.comment ?? '',
                    minLines: 1,
                    maxLines: 3,
                    decoration: const InputDecoration(labelText: 'Comment (optional)'),
                    onChanged: (v) => setState(() => _comments[it.metric] = v),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
