import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../domain/models.dart';
import '../domain/tap_decision.dart';

/// Shown when a scan lands inside the site's safety gap: the badge is real, but
/// acting on it would flip the worker in or out minutes after they last moved.
///
/// This is the guard against the accident that used to happen every morning —
/// a watchman working a queue, a badge still in front of the lens, and a worker
/// scanned back out a minute after arriving. The gap is a rule, not a wall, so
/// the watchman can still record it; he just has to say why, and that reason
/// goes into the audit trail with the tap.
///
/// Pops the typed reason to record anyway, or null to cancel.
class TooSoonDialog extends StatefulWidget {
  const TooSoonDialog({
    super.key,
    required this.blocked,
    required this.worker,
    required this.elapsedMinutes,
    required this.remainingSeconds,
  });

  /// What the scan would have recorded had the gap already passed.
  final TapAction? blocked;
  final WorkerCard? worker;
  final int elapsedMinutes;
  final int remainingSeconds;

  @override
  State<TooSoonDialog> createState() => _TooSoonDialogState();
}

class _TooSoonDialogState extends State<TooSoonDialog> {
  final _reason = TextEditingController();
  bool _overriding = false;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  bool get _isLogout => widget.blocked != TapAction.login;

  String get _headline {
    final name = widget.worker?.fullName ?? 'This person';
    final verb = _isLogout ? 'logged in' : 'logged out';
    final mins = widget.elapsedMinutes;
    final ago = mins <= 0 ? 'less than a minute ago' : '$mins minute${mins == 1 ? '' : 's'} ago';
    return '$name $verb $ago.';
  }

  /// The clock time the scan starts working again — easier to act on at a gate
  /// than a countdown the watchman would have to keep watching.
  String get _allowedFrom {
    final at = DateTime.now().add(Duration(seconds: widget.remainingSeconds));
    final hh = at.hour.toString().padLeft(2, '0');
    final mm = at.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.worker;
    return AlertDialog(
      icon: const Icon(Icons.timer_outlined, color: ClamsColors.warning, size: 40),
      title: Text(_isLogout ? 'Too soon to log out' : 'Too soon to log back in'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (w != null)
              Text(
                '${w.fullName}  (${w.workerCode})',
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
                textAlign: TextAlign.center,
              ),
            ClamsSpacing.gapSm,
            Text(_headline, textAlign: TextAlign.center),
            ClamsSpacing.gapSm,
            Container(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
              decoration: BoxDecoration(
                color: ClamsColors.warningTint,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                '${_isLogout ? 'Logout' : 'Login'} allowed from $_allowedFrom',
                textAlign: TextAlign.center,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
            if (_overriding) ...[
              ClamsSpacing.gapMd,
              TextField(
                controller: _reason,
                autofocus: true,
                textInputAction: TextInputAction.done,
                decoration: const InputDecoration(
                  labelText: 'Reason',
                  hintText: 'e.g. Sent home sick',
                  helperText: 'Saved with the punch so it can be checked later.',
                ),
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) => _submit(),
              ),
            ],
          ],
        ),
      ),
      actions: _overriding
          ? [
              TextButton(
                onPressed: () => setState(() => _overriding = false),
                child: const Text('Back'),
              ),
              FilledButton(
                onPressed: _reason.text.trim().isEmpty ? null : _submit,
                style: FilledButton.styleFrom(backgroundColor: ClamsColors.warning),
                child: const Text('Record'),
              ),
            ]
          : [
              TextButton(
                onPressed: () => setState(() => _overriding = true),
                child: const Text('Record anyway'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('OK'),
              ),
            ],
    );
  }

  void _submit() {
    final reason = _reason.text.trim();
    if (reason.isEmpty) return;
    Navigator.pop(context, reason);
  }
}
