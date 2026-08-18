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
/// Only the figures somebody types appear here. Manpower, total manpower and
/// safe man-hours are computed from attendance and are read on the statistics
/// board — a field for them would either sit dead or invite an edit that gets
/// thrown away. Each item takes an optional comment, which is where the context
/// a number cannot carry ends up.
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

  /// A controller per field, keyed by metric.
  ///
  /// These used to be `initialValue` on the field plus a map of typed strings.
  /// That loses every keystroke: the first one flips `_dirty`, which inserts the
  /// "nothing is recorded until you press Save" banner into the same unkeyed
  /// ListView the fields sit in, so every child below it shifts position, is
  /// matched against the wrong widget, and is rebuilt from the server value.
  /// Holding the text out here — and keying the cards by metric — means the
  /// text belongs to the metric rather than to a position in a list.
  final Map<String, TextEditingController> _valueCtrls = {};
  final Map<String, TextEditingController> _commentCtrls = {};

  bool _loading = true;
  bool _saving = false;
  bool _dirty = false;
  /// True while a load is filling the controllers in; see [_syncDirty].
  bool _resetting = false;
  String? _error;

  String get _dateParam =>
      '${_date.year}-${_date.month.toString().padLeft(2, '0')}-${_date.day.toString().padLeft(2, '0')}';

  bool get _isToday {
    final now = DateTime.now();
    return _date.year == now.year && _date.month == now.month && _date.day == now.day;
  }

  /// The sheet belongs to a site, so with no site chosen there is nothing to
  /// write to and the fields say so rather than failing at Save.
  bool get _canEdit => _siteId != null;

  /// The count as it stands on the server, as the field would show it.
  String _serverValue(SafetyItem i) => i.value?.toString() ?? '';

  String _serverComment(SafetyItem i) => i.comment ?? '';

  /// Compared against what was loaded rather than "has been typed in", so
  /// typing a digit and taking it back leaves nothing to save.
  bool _changed(SafetyItem i) =>
      (_valueCtrls[i.metric]?.text.trim() ?? '') != _serverValue(i) ||
      (_commentCtrls[i.metric]?.text.trim() ?? '') != _serverComment(i);

  /// Rebuild only when the answer actually flips, so an ordinary keystroke
  /// costs no rebuild at all.
  void _syncDirty() {
    // A reload writes every controller in turn and settles the flag itself;
    // reacting to each write would flip it on and off down the list.
    if (_resetting) return;
    final now = _items.any(_changed);
    if (now != _dirty) setState(() => _dirty = now);
  }

  @override
  void initState() {
    super.initState();
    Future.microtask(_load);
  }

  @override
  void dispose() {
    for (final c in _valueCtrls.values) {
      c.dispose();
    }
    for (final c in _commentCtrls.values) {
      c.dispose();
    }
    super.dispose();
  }

  TextEditingController _controller() => TextEditingController()..addListener(_syncDirty);

  /// Point the controllers at what the server just returned, dropping any that
  /// no longer have a metric behind them.
  void _resetControllers(List<SafetyItem> items) {
    _resetting = true;
    final keep = items.map((i) => i.metric).toSet();
    for (final map in [_valueCtrls, _commentCtrls]) {
      for (final metric in map.keys.toList()) {
        if (!keep.contains(metric)) map.remove(metric)!.dispose();
      }
    }
    for (final i in items) {
      final value = _valueCtrls[i.metric] ??= _controller();
      final comment = _commentCtrls[i.metric] ??= _controller();
      // A fresh load is the server's word on the day, so it wins over whatever
      // is in the box — otherwise changing the date keeps yesterday's figures.
      value.text = _serverValue(i);
      comment.text = _serverComment(i);
    }
    _dirty = false;
    _resetting = false;
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
        // Manpower and safe man-hours are computed from attendance, so a field
        // for them would either be dead or would invite an edit that gets
        // thrown away. They are read on the statistics board instead.
        _items = ((m['items'] as List?) ?? const [])
            .cast<Map<String, dynamic>>()
            .map(SafetyItem.fromMap)
            .where((i) => !i.isAutomated)
            .toList();
        _resetControllers(_items);
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
    // Another day is another sheet, so the reload overwrites every field. Worth
    // asking first now that what is in them survives long enough to be lost.
    if (_dirty && !await _confirmDiscard()) return;
    if (!mounted) return;
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

  Future<bool> _confirmDiscard() async {
    final keep = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Leave this day?'),
        content: const Text('The figures you have typed in have not been saved.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Keep editing'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Discard'),
          ),
        ],
      ),
    );
    // Dismissed by tapping outside: the safe reading is "carry on editing".
    return keep == false;
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
      final payload = _items.where(_changed).map((i) {
        final raw = _valueCtrls[i.metric]?.text.trim() ?? '';
        final comment = _commentCtrls[i.metric]?.text.trim() ?? '';
        return {
          'metric': i.metric,
          // Blank clears back to "not filled in", which is not the same as zero.
          'value': raw.isEmpty ? null : int.tryParse(raw),
          'comment': comment.isEmpty ? null : comment,
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
    final canSave = !_loading && !_saving && _dirty && _canEdit;

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
        onPressed: canSave ? _save : null,
        backgroundColor: canSave ? ClamsColors.primary : ClamsColors.border,
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
                    if (!_canEdit) ...[
                      ClamsSpacing.gapMd,
                      _notice(
                        Icons.warning_amber_outlined,
                        'Pick a site from Change site before filling this in — the '
                        'figures are recorded against one site.',
                      ),
                    ] else if (_dirty) ...[
                      ClamsSpacing.gapMd,
                      _notice(Icons.info_outline, 'Nothing is recorded until you press Save.'),
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

  Widget _notice(IconData icon, String text) => Container(
        padding: const EdgeInsets.all(ClamsSpacing.md),
        decoration: BoxDecoration(
          color: ClamsColors.infoTint,
          borderRadius: BorderRadius.circular(ClamsRadius.card),
        ),
        child: Row(
          children: [
            Icon(icon, size: 18, color: ClamsColors.info),
            const SizedBox(width: ClamsSpacing.sm),
            Expanded(
              child: Text(
                text,
                style: const TextStyle(fontSize: 13, color: ClamsColors.textSecondary),
              ),
            ),
          ],
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

  Widget _itemCard(SafetyItem it) {
    return Padding(
      // Keyed by metric so a card keeps its fields — text, cursor and focus —
      // when the list around it changes length.
      key: ValueKey(it.metric),
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
            Text(
              it.label,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            ClamsSpacing.gapSm,
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 110,
                  child: TextFormField(
                    controller: _valueCtrls[it.metric],
                    enabled: _canEdit,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(labelText: 'Count'),
                  ),
                ),
                const SizedBox(width: ClamsSpacing.md),
                Expanded(
                  child: TextFormField(
                    controller: _commentCtrls[it.metric],
                    enabled: _canEdit,
                    minLines: 1,
                    maxLines: 3,
                    decoration: const InputDecoration(labelText: 'Comment (optional)'),
                    // Sent as typed, so the next reader gets the capitals and
                    // full stops the officer put in.
                    textCapitalization: TextCapitalization.sentences,
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
