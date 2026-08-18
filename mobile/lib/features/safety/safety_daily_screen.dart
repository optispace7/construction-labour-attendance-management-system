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

/// The metric whose figure is the total of the waste breakdown, not typed.
const _wasteMetric = 'WASTE_DISPOSAL';

/// Add, rename and remove the waste types the dropdown offers.
///
/// Removing one that already has figures behind it retires it rather than
/// deleting it — it leaves the dropdown, and the days that counted it keep
/// their numbers. The API decides which of the two happened and says so.
class _WasteTypesSheet extends StatefulWidget {
  const _WasteTypesSheet({required this.types, required this.api});

  final List<WasteTypeOption> types;
  final Dio api;

  @override
  State<_WasteTypesSheet> createState() => _WasteTypesSheetState();
}

class _WasteTypesSheetState extends State<_WasteTypesSheet> {
  late List<WasteTypeOption> _types = [...widget.types];
  final _adding = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _adding.dispose();
    super.dispose();
  }

  void _say(String message) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
    }
  }

  /// Runs one catalogue change and refreshes the list from the server, so the
  /// sheet always shows what was actually saved rather than what was typed.
  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      final res = await widget.api.get('/safety/waste-types');
      if (!mounted) return;
      setState(() {
        _types = (res.data as List)
            .cast<Map<String, dynamic>>()
            .map(WasteTypeOption.fromMap)
            .toList();
      });
    } on DioException catch (e) {
      final detail = e.response?.data is Map ? (e.response!.data as Map)['meta'] : null;
      _say((detail is Map ? detail['message'] as String? : null) ??
          e.message ??
          'That did not work.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _add() async {
    final name = _adding.text.trim();
    if (name.isEmpty) return;
    await _run(() async {
      await widget.api.post('/safety/waste-types', data: {'name': name});
      _adding.clear();
    });
  }

  Future<void> _rename(WasteTypeOption t) async {
    final controller = TextEditingController(text: t.name);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(t.isActive ? 'Rename waste type' : 'Restore waste type'),
        content: TextField(
          controller: controller,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(labelText: 'Name'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (name == null || name.isEmpty) return;
    await _run(() async {
      await widget.api.patch('/safety/waste-types/${t.id}', data: {'name': name});
    });
  }

  Future<void> _remove(WasteTypeOption t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove this waste type?'),
        content: Text(
          '"${t.name}" comes off the dropdown. Any day it has already been recorded '
          'against keeps its figure.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (ok != true) return;
    await _run(() async {
      final res = await widget.api.delete('/safety/waste-types/${t.id}');
      final body = (res.data as Map?)?.cast<String, dynamic>();
      if (body?['retired'] == true) {
        _say('Retired — ${body?['entriesKept']} recorded entries keep their figures.');
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: ClamsSpacing.lg,
          right: ClamsSpacing.lg,
          top: ClamsSpacing.lg,
          // Clear of the keyboard when the add field has focus.
          bottom: MediaQuery.of(context).viewInsets.bottom + ClamsSpacing.lg,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Waste types', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            ClamsSpacing.gapMd,
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _adding,
                    textCapitalization: TextCapitalization.words,
                    decoration: const InputDecoration(labelText: 'Add a waste type'),
                    onSubmitted: (_) => _busy ? null : _add(),
                  ),
                ),
                const SizedBox(width: ClamsSpacing.sm),
                FilledButton(onPressed: _busy ? null : _add, child: const Text('Add')),
              ],
            ),
            ClamsSpacing.gapMd,
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: _types.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final t = _types[i];
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(t.isActive ? t.name : '${t.name} · retired'),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        TextButton(
                          onPressed: _busy ? null : () => _rename(t),
                          child: Text(t.isActive ? 'Rename' : 'Restore'),
                        ),
                        if (t.isActive)
                          IconButton(
                            tooltip: 'Remove',
                            onPressed: _busy ? null : () => _remove(t),
                            icon: const Icon(Icons.delete_outline, size: 20),
                          ),
                      ],
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One kind of waste the site sends out, as the dropdown offers it.
class WasteTypeOption {
  const WasteTypeOption({required this.id, required this.name, required this.isActive});

  final String id;
  final String name;

  /// Retired types keep their history and their existing lines, but cannot be
  /// picked for a new one.
  final bool isActive;

  factory WasteTypeOption.fromMap(Map<String, dynamic> m) => WasteTypeOption(
        id: m['id'] as String,
        name: (m['name'] as String?) ?? '',
        isActive: (m['isActive'] as bool?) ?? true,
      );
}

/// A line of the breakdown while it is being edited.
class _WasteLine {
  _WasteLine({required this.typeId, required this.count});

  /// Empty on a line just added, until a type is picked.
  String typeId;
  final TextEditingController count;
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

  /// The waste dropdown, and the day's breakdown behind the waste figure.
  List<WasteTypeOption> _wasteTypes = const [];
  List<_WasteLine> _wasteLines = [];

  /// What the server last said the breakdown was, for the dirty check.
  Map<String, String> _serverWaste = const {};

  /// The picker above the list: a type and a count waiting to be added.
  String? _pickedType;
  final TextEditingController _pickedCount = TextEditingController();

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

  /// The breakdown as a comparable map, so "has it changed" is one string test.
  Map<String, String> get _wasteNow => {
        for (final l in _wasteLines)
          if (l.typeId.isNotEmpty) l.typeId: l.count.text.trim(),
      };

  bool get _wasteChanged {
    final now = _wasteNow;
    if (now.length != _serverWaste.length) return true;
    for (final e in now.entries) {
      if (_serverWaste[e.key] != e.value) return true;
    }
    return false;
  }

  /// The waste figure as it will read once saved. Null when nothing has been
  /// said about waste at all, which is a blank rather than a zero.
  int? get _wasteTotal {
    final filled = _wasteLines.where((l) => l.typeId.isNotEmpty && l.count.text.trim().isNotEmpty);
    if (filled.isEmpty) return null;
    return filled.fold(0, (sum, l) => sum! + (int.tryParse(l.count.text.trim()) ?? 0));
  }

  /// Rebuild only when the answer actually flips, so an ordinary keystroke
  /// costs no rebuild at all.
  void _syncDirty() {
    // A reload writes every controller in turn and settles the flag itself;
    // reacting to each write would flip it on and off down the list.
    if (_resetting) return;
    final now = _items.any(_changed) || _wasteChanged;
    // The waste total is drawn from these fields, so a keystroke there has to
    // repaint even when the dirty flag was already set.
    if (now != _dirty || _wasteChanged) {
      setState(() => _dirty = now);
    }
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
    for (final l in _wasteLines) {
      l.count.dispose();
    }
    _pickedCount.dispose();
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

  /// Point the waste section at what the server just returned.
  void _resetWaste(Map<String, dynamic>? waste) {
    for (final l in _wasteLines) {
      l.count.dispose();
    }
    _wasteTypes = ((waste?['types'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .map(WasteTypeOption.fromMap)
        .toList();
    final rows = ((waste?['rows'] as List?) ?? const []).cast<Map<String, dynamic>>();
    _serverWaste = {
      for (final r in rows) r['wasteTypeId'] as String: '${(r['value'] as num?)?.toInt() ?? 0}',
    };
    _wasteLines = _serverWaste.entries
        .map((e) => _WasteLine(
              typeId: e.key,
              count: TextEditingController(text: e.value)..addListener(_syncDirty),
            ))
        .toList();
    _pickedType = null;
    _pickedCount.clear();
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
        _resetWaste((m['waste'] as Map?)?.cast<String, dynamic>());
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

      // The breakdown, only when it has been touched. A line taken off the
      // sheet has to be sent as null rather than simply left out: the API
      // replaces what it is given, and saying nothing about a type means
      // "leave it alone", not "delete it".
      List<Map<String, dynamic>>? waste;
      if (_wasteChanged) {
        final now = _wasteNow;
        waste = [
          for (final e in now.entries)
            {'wasteTypeId': e.key, 'value': e.value.isEmpty ? null : int.tryParse(e.value)},
          for (final id in _serverWaste.keys)
            if (!now.containsKey(id)) {'wasteTypeId': id, 'value': null},
        ];
      }

      await ref.read(apiClientProvider).dio.put(
        '/safety/daily',
        data: {
          'siteId': _siteId,
          'date': _dateParam,
          'items': payload,
          if (waste != null) 'waste': waste,
        },
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
                      // Waste sits in its own group position, as one card with
                      // a dropdown rather than a Count box: its figure is the
                      // total of the lines inside it.
                      ...entry.value
                          .map((i) => i.metric == _wasteMetric ? _wasteCard() : _itemCard(i)),
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

  // ---------------------------------------------------------------------------
  // Waste disposal
  // ---------------------------------------------------------------------------

  /// Types that may still be picked for a new line — one already on the sheet
  /// would split the same stream into two figures.
  List<WasteTypeOption> get _spareWasteTypes {
    final used = _wasteLines.map((l) => l.typeId).toSet();
    return _wasteTypes.where((t) => t.isActive && !used.contains(t.id)).toList();
  }

  /// Move what the picker is holding onto the day's list.
  void _addWasteLine() {
    if (_pickedType == null || _pickedCount.text.trim().isEmpty) return;
    setState(() {
      _wasteLines.add(_WasteLine(
        typeId: _pickedType!,
        count: TextEditingController(text: _pickedCount.text.trim())..addListener(_syncDirty),
      ));
      _pickedType = null;
      _pickedCount.clear();
    });
    _syncDirty();
  }

  void _removeWasteLine(int i) {
    setState(() => _wasteLines.removeAt(i).count.dispose());
    _syncDirty();
  }

  /// Waste disposal as one card: a dropdown, a count and an add button, with
  /// what has already been recorded listed underneath.
  ///
  /// Its figure is never typed — it is the total of those lines, which is why
  /// there is no Count box on the card itself.
  Widget _wasteCard() {
    final spare = _spareWasteTypes;
    final total = _wasteTotal;
    final byId = {for (final t in _wasteTypes) t.id: t};

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
                const Text('Waste disposal', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(width: ClamsSpacing.sm),
                Text(
                  'total ${total ?? '—'}',
                  style: const TextStyle(fontSize: 12, color: ClamsColors.textSecondary),
                ),
                const Spacer(),
                if (_canEdit)
                  TextButton(onPressed: _manageWasteTypes, child: const Text('Manage types')),
              ],
            ),
            ClamsSpacing.gapSm,
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: _pickedType,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: 'Waste type',
                      helperText: spare.isEmpty ? 'All types recorded today' : null,
                    ),
                    items: [
                      for (final t in spare)
                        DropdownMenuItem(
                          value: t.id,
                          child: Text(t.name, overflow: TextOverflow.ellipsis),
                        ),
                    ],
                    onChanged: _canEdit && spare.isNotEmpty
                        ? (v) => setState(() => _pickedType = v)
                        : null,
                  ),
                ),
                const SizedBox(width: ClamsSpacing.sm),
                SizedBox(
                  width: 84,
                  child: TextFormField(
                    controller: _pickedCount,
                    enabled: _canEdit,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(labelText: 'Count'),
                    onChanged: (_) => setState(() {}),
                    onFieldSubmitted: (_) => _addWasteLine(),
                  ),
                ),
                IconButton(
                  tooltip: 'Add',
                  onPressed:
                      _canEdit && _pickedType != null && _pickedCount.text.trim().isNotEmpty
                          ? _addWasteLine
                          : null,
                  icon: const Icon(Icons.add_circle_outline),
                ),
              ],
            ),
            for (var i = 0; i < _wasteLines.length; i++) ...[
              const Divider(height: 1),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      byId[_wasteLines[i].typeId]?.isActive == false
                          ? '${byId[_wasteLines[i].typeId]?.name} · retired'
                          : byId[_wasteLines[i].typeId]?.name ?? 'Unknown type',
                      style: const TextStyle(fontSize: 13),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  SizedBox(
                    width: 72,
                    child: TextFormField(
                      controller: _wasteLines[i].count,
                      enabled: _canEdit,
                      keyboardType: TextInputType.number,
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      decoration: const InputDecoration(isDense: true),
                    ),
                  ),
                  if (_canEdit)
                    IconButton(
                      tooltip: 'Remove',
                      onPressed: () => _removeWasteLine(i),
                      icon: const Icon(Icons.delete_outline, size: 20),
                    ),
                ],
              ),
            ],
            // The waste row's comment, which stays the sheet's to write even
            // though its figure is now derived.
            if (_commentCtrls[_wasteMetric] != null)
              Padding(
                padding: const EdgeInsets.only(top: ClamsSpacing.sm),
                child: TextFormField(
                  controller: _commentCtrls[_wasteMetric],
                  enabled: _canEdit,
                  minLines: 1,
                  maxLines: 3,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: const InputDecoration(labelText: 'Comment (optional)'),
                ),
              ),
          ],
        ),
      ),
    );
  }


  /// Add, rename and remove the types the dropdown offers.
  Future<void> _manageWasteTypes() async {
    // Managing the catalogue reloads the sheet afterwards, which overwrites the
    // fields — so ask first if there is anything in them.
    if (_dirty && !await _confirmDiscard()) return;
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _WasteTypesSheet(
        types: _wasteTypes,
        api: ref.read(apiClientProvider).dio,
      ),
    );
    // The sheet edits the catalogue rather than the day, so reload to pick the
    // new list up — the figures on screen are unchanged by it.
    if (mounted) await _load();
  }

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
