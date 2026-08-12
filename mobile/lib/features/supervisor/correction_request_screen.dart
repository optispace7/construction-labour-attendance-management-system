import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/providers.dart';
import '../attendance/domain/models.dart';

/// Supervisor raises an attendance-correction request (admin approves it).
/// Mirrors the backend CorrectionType / CorrectionReason enums.
class CorrectionRequestScreen extends ConsumerStatefulWidget {
  const CorrectionRequestScreen({super.key, required this.worker});
  final WorkerCard worker;

  @override
  ConsumerState<CorrectionRequestScreen> createState() => _CorrectionRequestScreenState();
}

class _CorrectionRequestScreenState extends ConsumerState<CorrectionRequestScreen> {
  // Spelled out rather than title-cased from the enum: an officer picking
  // "Login" for a day that was never scanned files a request that cannot be
  // approved, because a login-only correction has no logout to close the
  // session it would have to create.
  static const _types = <String, String>{
    'LOGIN': 'Wrong login time',
    'LOGOUT': 'Wrong or missing logout time',
    'MISSING': 'Never scanned at all',
    'WRONG_SITE': 'Recorded at the wrong site',
  };
  static const _typeHelp = <String, String>{
    'LOGIN': 'They were scanned in, at the wrong time.',
    'LOGOUT': 'They left, but the logout was never scanned or was scanned at the wrong time.',
    'MISSING': 'They worked the day but there is no record of it. This creates the record.',
    'WRONG_SITE': 'The times are right; the day is filed against the wrong site.',
  };
  static const _reasons = [
    'FORGOT_CARD',
    'DEVICE_ISSUE',
    'NETWORK_ISSUE',
    'WRONG_SITE',
    'SUPERVISOR_MISTAKE',
    'OTHER',
  ];

  String _type = 'LOGOUT';
  String _reason = 'FORGOT_CARD';
  DateTime _date = DateTime.now();
  TimeOfDay? _loginTime;
  TimeOfDay? _logoutTime = TimeOfDay.now();
  bool _nextDay = false;
  final _notes = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  String _label(String s) =>
      s.split('_').map((w) => w[0] + w.substring(1).toLowerCase()).join(' ');

  /// Which stamp this kind of correction cannot be filed without.
  bool get _needsLogin => _type == 'LOGIN' || _type == 'MISSING';
  bool get _needsLogout => _type == 'LOGOUT';

  /// Both ends are offered for every time-based correction — a day that was
  /// never scanned needs its logout as much as its login, and one visit to the
  /// form should be able to fix a session that is wrong at both ends.
  bool get _showsTimes => _type != 'WRONG_SITE';

  int _minutes(TimeOfDay t) => t.hour * 60 + t.minute;

  /// A night shift goes out the following morning, so an out time at or before
  /// the in time can only mean the next day.
  bool get _crossesMidnight =>
      _loginTime != null && _logoutTime != null && _minutes(_logoutTime!) <= _minutes(_loginTime!);

  /// Calendar date as the supervisor picked it, with no timezone shift.
  String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  String _instant(DateTime day, TimeOfDay t) =>
      DateTime(day.year, day.month, day.day, t.hour, t.minute).toUtc().toIso8601String();

  /// The day the logout lands on. Only meaningful next to a login time: a
  /// logout-only correction carries its own date already (the morning they
  /// walked out), which is how the approval finds the session running into it.
  DateTime get _outDay =>
      _loginTime != null && _nextDay ? DateTime(_date.year, _date.month, _date.day + 1) : _date;

  String? get _blocker {
    if (_needsLogin && _loginTime == null) return 'Set the login time.';
    if (_needsLogout && _logoutTime == null) return 'Set the logout time.';
    if (_loginTime != null && _logoutTime != null && !_nextDay && _crossesMidnight) {
      return 'The logout time must be later than the login time — tick "went out the next day" '
          'if they worked through the night.';
    }
    return null;
  }

  Future<void> _submit() async {
    final blocker = _blocker;
    if (blocker != null) {
      setState(() => _error = blocker);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final siteId = await ref.read(localDbProvider).getMeta('active_site');
      final items = <Map<String, dynamic>>[];
      if (_showsTimes && _loginTime != null) {
        items.add({'field': 'login_at', 'proposedValue': _instant(_date, _loginTime!)});
      }
      if (_showsTimes && _logoutTime != null) {
        items.add({'field': 'logout_at', 'proposedValue': _instant(_outDay, _logoutTime!)});
      }
      final res = await ref.read(apiClientProvider).dio.post('/corrections', data: {
        'workerId': widget.worker.id,
        'siteId': siteId,
        // Plain calendar date, NOT a UTC-converted local midnight: at +05:30 the
        // latter lands at 18:30Z the day before and the server's Date column
        // truncates it to the wrong day.
        'workDate': _ymd(_date),
        'type': _type,
        'reason': _reason,
        'notes': _notes.text.trim(),
        'items': items,
      });
      if (!mounted) return;
      // Some officers are cleared to apply their own corrections, in which case
      // the server has already changed attendance and comes back APPROVED. Only
      // the server knows — the grant is per person and can be taken back — so
      // the message is read off the response rather than assumed.
      final applied = res.data is Map && res.data['status'] == 'APPROVED';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            applied
                ? 'Correction applied — attendance updated'
                : 'Correction request submitted for approval',
          ),
        ),
      );
      Navigator.of(context).pop();
    } on DioException catch (e) {
      final detail = e.response?.data is Map
          ? (e.response?.data['detail'] ?? e.response?.data['title'])
          : null;
      setState(() => _error = (detail as String?) ?? 'Failed to submit request');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// "06 Aug" — the short day label the overnight tick-box carries.
  String _dayLabel(DateTime d) =>
      '${d.day.toString().padLeft(2, '0')} ${const [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec'
      ][d.month - 1]}';

  ShapeBorder get _tileShape => const RoundedRectangleBorder(
        side: BorderSide(color: ClamsColors.border),
        borderRadius: BorderRadius.all(Radius.circular(ClamsRadius.control)),
      );

  Widget _timeTile({
    required String title,
    required String subtitle,
    required TimeOfDay? value,
    required ValueChanged<TimeOfDay> onPicked,
    VoidCallback? onClear,
  }) {
    return ListTile(
      tileColor: ClamsColors.surface,
      shape: _tileShape,
      title: Text(title),
      subtitle: Text(value?.format(context) ?? subtitle),
      trailing: value != null && onClear != null
          ? IconButton(icon: const Icon(Icons.close), onPressed: onClear)
          : const Icon(Icons.access_time),
      onTap: () async {
        final picked =
            await showTimePicker(context: context, initialTime: value ?? TimeOfDay.now());
        if (picked != null) onPicked(picked);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Correction · ${widget.worker.fullName}')),
      body: ListView(
        padding: const EdgeInsets.all(ClamsSpacing.lg),
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: ClamsSpacing.md),
              child: Text(_error!, style: const TextStyle(color: ClamsColors.error)),
            ),
          DropdownButtonFormField<String>(
            initialValue: _type,
            decoration: InputDecoration(
              labelText: 'What is wrong?',
              helperText: _typeHelp[_type],
              helperMaxLines: 3,
            ),
            items: _types.entries
                .map((e) => DropdownMenuItem(value: e.key, child: Text(e.value)))
                .toList(),
            onChanged: (v) => setState(() {
              _type = v!;
              // Prefill whichever stamp this kind of correction cannot be filed
              // without, the way the form used to prefill its single time field.
              if (_needsLogin && _loginTime == null) _loginTime = TimeOfDay.now();
              if (_needsLogout && _logoutTime == null) _logoutTime = TimeOfDay.now();
              _nextDay = _crossesMidnight;
            }),
          ),
          ClamsSpacing.gapLg,
          DropdownButtonFormField<String>(
            initialValue: _reason,
            decoration: const InputDecoration(labelText: 'Reason'),
            items: _reasons.map((r) => DropdownMenuItem(value: r, child: Text(_label(r)))).toList(),
            onChanged: (v) => setState(() => _reason = v!),
          ),
          ClamsSpacing.gapLg,
          ListTile(
            tileColor: ClamsColors.surface,
            shape: _tileShape,
            // Named for the stamp being corrected, not "work date": a night
            // shift logs out the *next* morning, and the approval finds the
            // session from this date and time, so the 5th and the 6th are two
            // different requests.
            title: Text(_loginTime != null ? 'Date they came in' : 'Date they went out'),
            subtitle: Text(_ymd(_date)),
            trailing: const Icon(Icons.calendar_today),
            onTap: () async {
              final picked = await showDatePicker(
                context: context,
                initialDate: _date,
                firstDate: DateTime(2024),
                lastDate: DateTime.now().add(const Duration(days: 1)),
              );
              if (picked != null) setState(() => _date = picked);
            },
          ),
          if (_showsTimes) ...[
            ClamsSpacing.gapMd,
            _timeTile(
              title: _needsLogin ? 'Login time' : 'Login time (optional)',
              subtitle: 'Not set — leave it as it is',
              value: _loginTime,
              onPicked: (t) => setState(() {
                _loginTime = t;
                _nextDay = _crossesMidnight;
              }),
              onClear: _needsLogin
                  ? null
                  : () => setState(() {
                        _loginTime = null;
                        _nextDay = false;
                      }),
            ),
            ClamsSpacing.gapMd,
            _timeTile(
              title: _needsLogout ? 'Logout time' : 'Logout time (optional)',
              subtitle: _type == 'MISSING'
                  ? 'Not set — leave blank only if they are still on site now'
                  : 'Not set — leave it as it is',
              value: _logoutTime,
              onPicked: (t) => setState(() {
                _logoutTime = t;
                _nextDay = _crossesMidnight;
              }),
              onClear: _needsLogout ? null : () => setState(() => _logoutTime = null),
            ),
            // Night shift: in at 9:30 pm, out at 8 am the following morning.
            // Only offered next to a login time, because a logout-only
            // correction already carries the day the logout happened.
            if (_loginTime != null && _logoutTime != null)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _nextDay,
                onChanged: (v) => setState(() => _nextDay = v ?? false),
                title: Text(
                  'They went out the next day '
                  '(${_dayLabel(DateTime(_date.year, _date.month, _date.day + 1))})',
                ),
              ),
          ],
          ClamsSpacing.gapLg,
          TextField(
            controller: _notes,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Notes'),
          ),
          ClamsSpacing.gapXl,
          FilledButton(
            onPressed: _busy || _blocker != null ? null : _submit,
            child: Text(_busy ? 'Submitting…' : 'Submit request'),
          ),
        ],
      ),
    );
  }
}
