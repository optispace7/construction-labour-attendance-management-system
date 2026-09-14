import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/widgets/api_image.dart';
import '../domain/models.dart';

/// The one screen a scan shows: who was scanned, whether it is a LOGIN or a
/// LOGOUT, and OK / Cancel. Nothing is recorded until OK is pressed.
///
/// The action shown is the server's answer, never the phone's guess. When the
/// server cannot be asked, this screen is not shown at all.
///
/// Pops `true` for OK (record it) and `false`/null for Cancel (record nothing).
class ConfirmTapDialog extends StatelessWidget {
  const ConfirmTapDialog({
    super.key,
    required this.action,
    required this.worker,
  });

  final TapAction action;
  final WorkerCard worker;

  bool get _isLogin => action == TapAction.login;

  @override
  Widget build(BuildContext context) {
    final color = _isLogin ? ClamsColors.success : ClamsColors.info;
    final w = worker;
    final category = w.category;

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
            ClamsSpacing.gapLg,
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
        // Flexible, not a bare Text. Sitting unbounded next to an Expanded, the
        // label takes its natural width whatever is left — so a long
        // designation, a narrow phone, or a watchman who has turned his system
        // font size up puts black-and-yellow overflow stripes across the one
        // dialog he uses all day. Both parts give way now.
        Flexible(
          child: Text(
            '$label: ',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context)
                .textTheme
                .bodyMedium
                ?.copyWith(color: ClamsColors.textSecondary),
          ),
        ),
        Expanded(
          child: Text(
            value ?? '—',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
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
