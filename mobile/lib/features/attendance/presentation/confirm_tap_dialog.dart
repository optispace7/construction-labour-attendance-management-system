import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/widgets/api_image.dart';
import '../domain/models.dart';
import '../domain/tap_decision.dart';

/// The one screen a scan shows: who was scanned, whether it is a LOGIN or a
/// LOGOUT, and OK / Cancel. Nothing is recorded until OK is pressed.
///
/// Pops `true` for OK (record it) and `false`/null for Cancel (record nothing).
/// [worker] is null when the badge isn't in the offline cache and the device is
/// offline — the punch is still worth recording, so we confirm on the raw code.
class ConfirmTapDialog extends StatelessWidget {
  const ConfirmTapDialog({
    super.key,
    required this.action,
    required this.identifier,
    this.worker,
    this.stateIsStale = false,
  });

  final TapAction action;
  final String identifier;
  final WorkerCard? worker;

  /// This device could not reach the server to check whether the worker is
  /// already on site, so LOGIN/LOGOUT below is its own best guess.
  final bool stateIsStale;

  bool get _isLogin => action == TapAction.login;

  @override
  Widget build(BuildContext context) {
    final color = _isLogin ? ClamsColors.success : ClamsColors.info;
    final w = worker;
    final category = w?.category;

    return AlertDialog(
      contentPadding: const EdgeInsets.fromLTRB(24, 20, 24, 0),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // LOGIN / LOGOUT — the decision being confirmed, stated first.
            Container(
              padding: const EdgeInsets.symmetric(vertical: 12),
              decoration: BoxDecoration(
                color: color.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(_isLogin ? Icons.login : Icons.logout, color: color, size: 22),
                  const SizedBox(width: 8),
                  Text(
                    _isLogin ? 'LOGIN' : 'LOGOUT',
                    style: TextStyle(
                      color: color,
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.5,
                    ),
                  ),
                ],
              ),
            ),
            // Say so when the decision above is a guess. Without this the
            // watchman confirms "LOGIN", the server answers LOGOUT because
            // another gate — or a Super Admin fix — moved the worker, and the
            // toast a second later contradicts the screen he just approved.
            if (stateIsStale) ...[
              ClamsSpacing.gapMd,
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: ClamsColors.warningTint,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.cloud_off, color: ClamsColors.warning, size: 20),
                    SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'This phone could not check with the server, so this is its '
                        'best guess. If another gate already scanned this person, '
                        'the opposite may be recorded.',
                        style: TextStyle(fontSize: 13, color: ClamsColors.textSecondary),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            ClamsSpacing.gapLg,
            if (w != null) ...[
              Row(
                children: [
                  ApiCircleAvatar(photoUrl: w.photoUrl, radius: 36),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          w.fullName,
                          style: Theme.of(context)
                              .textTheme
                              .titleLarge
                              ?.copyWith(fontWeight: FontWeight.w600),
                        ),
                        Text(
                          w.workerCode,
                          style: Theme.of(context)
                              .textTheme
                              .bodyMedium
                              ?.copyWith(color: ClamsColors.textSecondary),
                        ),
                        if (category != null && category != 'WORKER')
                          Padding(
                            padding: const EdgeInsets.only(top: ClamsSpacing.xs),
                            child: Chip(
                              label: Text(category),
                              visualDensity: VisualDensity.compact,
                              backgroundColor: ClamsColors.primaryTint,
                              side: BorderSide.none,
                              labelStyle: const TextStyle(
                                color: ClamsColors.primaryDark,
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              ClamsSpacing.gapMd,
              Card(
                margin: EdgeInsets.zero,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _InfoRow(
                        icon: Icons.engineering,
                        label: 'Designation',
                        value: w.designationName,
                      ),
                      const SizedBox(height: 8),
                      _InfoRow(
                        icon: Icons.business,
                        label: 'Vendor',
                        value: w.vendorName,
                      ),
                    ],
                  ),
                ),
              ),
            ] else
              Row(
                children: [
                  const Icon(Icons.help_outline, color: ClamsColors.warning, size: 40),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          identifier,
                          style: Theme.of(context)
                              .textTheme
                              .titleMedium
                              ?.copyWith(fontWeight: FontWeight.w600),
                        ),
                        Text(
                          "Card not in this device's list — the name appears once it syncs.",
                          style: Theme.of(context)
                              .textTheme
                              .bodySmall
                              ?.copyWith(color: ClamsColors.textSecondary),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          style: FilledButton.styleFrom(backgroundColor: color),
          child: const Text('OK'),
        ),
      ],
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.icon, required this.label, required this.value});
  final IconData icon;
  final String label;
  final String? value;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 20, color: ClamsColors.primary),
        const SizedBox(width: 10),
        Text('$label: ',
            style: Theme.of(context)
                .textTheme
                .bodyMedium
                ?.copyWith(color: ClamsColors.textSecondary)),
        Expanded(
          child: Text(
            value ?? '—',
            style: Theme.of(context)
                .textTheme
                .bodyMedium
                ?.copyWith(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }
}
