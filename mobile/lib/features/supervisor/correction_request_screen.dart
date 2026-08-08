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
  static const _types = ['LOGIN', 'LOGOUT', 'MISSING', 'WRONG_SITE'];
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
  TimeOfDay? _time = TimeOfDay.now();
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

  bool get _needsTime => _type == 'LOGIN' || _type == 'LOGOUT' || _type == 'MISSING';

  /// Calendar date as the supervisor picked it, with no timezone shift.
  String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final siteId = await ref.read(localDbProvider).getMeta('active_site');
      final items = <Map<String, dynamic>>[];
      if (_needsTime && _time != null) {
        final dt = DateTime(_date.year, _date.month, _date.day, _time!.hour, _time!.minute);
        final field = _type == 'LOGOUT' ? 'logout_at' : 'login_at';
        items.add({'field': field, 'proposedValue': dt.toUtc().toIso8601String()});
      }
      await ref.read(apiClientProvider).dio.post('/corrections', data: {
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
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Correction request submitted for approval')),
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
            decoration: const InputDecoration(labelText: 'Correction type'),
            items: _types.map((t) => DropdownMenuItem(value: t, child: Text(_label(t)))).toList(),
            onChanged: (v) => setState(() => _type = v!),
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
            shape: const RoundedRectangleBorder(
              side: BorderSide(color: ClamsColors.border),
              borderRadius:
                  BorderRadius.all(Radius.circular(ClamsRadius.control)),
            ),
            // Named for the stamp being corrected, not "work date": a night
            // shift logs out the *next* morning, and the approval finds the
            // session from this date and time, so the 5th and the 6th are two
            // different requests.
            title: Text(_type == 'LOGOUT' ? 'Date they went out' : 'Date they came in'),
            subtitle: Text('${_date.year}-${_date.month.toString().padLeft(2, '0')}-${_date.day.toString().padLeft(2, '0')}'),
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
          if (_needsTime) ...[
            ClamsSpacing.gapMd,
            ListTile(
              tileColor: ClamsColors.surface,
              shape: const RoundedRectangleBorder(
                side: BorderSide(color: ClamsColors.border),
                borderRadius:
                    BorderRadius.all(Radius.circular(ClamsRadius.control)),
              ),
              title: Text(_type == 'LOGOUT' ? 'Proposed logout time' : 'Proposed login time'),
              subtitle: Text(_time?.format(context) ?? 'Not set'),
              trailing: const Icon(Icons.access_time),
              onTap: () async {
                final picked = await showTimePicker(
                    context: context, initialTime: _time ?? TimeOfDay.now());
                if (picked != null) setState(() => _time = picked);
              },
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
            onPressed: _busy ? null : _submit,
            child: Text(_busy ? 'Submitting…' : 'Submit request'),
          ),
        ],
      ),
    );
  }
}
