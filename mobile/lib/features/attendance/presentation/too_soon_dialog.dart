import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/widgets/api_image.dart';
import '../domain/models.dart';
import '../domain/tap_decision.dart';

/// Shown when a scan is refused for being too close to the last one — either
/// inside the duplicate cooldown (seconds) or inside the site's safety gap
/// (minutes).
///
/// Both guard the same accident: a watchman working a queue, a badge still in
/// front of the lens, and a worker scanned back out moments after arriving.
/// Neither is a wall. The watchman is standing at the gate and can see whether
/// it is one badge read twice or a second man who has walked up, so he gets the
/// final say.
///
/// He is NOT asked to type a reason. That prompt used to be mandatory, and it
/// asked watchmen to justify a decision they had no vocabulary for — so it was
/// dropped. Confirming IS the decision, and the override is audited with the
/// punch either way.
///
/// ---
///
/// Built for a watchman who cannot read. The panel teaches three colours and
/// this screen is the third:
///
///   green  = a login is being recorded      (ConfirmTapDialog)
///   blue   = a logout is being recorded     (ConfirmTapDialog)
///   RED    = stop, this one is not normal   (here)
///
/// Colour alone is never the whole signal, because a colour-blind watchman or a
/// sun-washed screen would erase it. Three other things say the same thing:
///
///  - The SHAPE is different. The routine dialog puts its two choices side by
///    side; this one stacks them. A dialog that does not look like the dialog he
///    taps fifty times a shift is one he has to actually look at.
///  - The FACE is large. He recognises the man in front of him, not the name —
///    and "is this the same person I just scanned?" is the entire question being
///    asked. The old version showed a line of text and no photo.
///  - The BUTTONS carry a tick and a cross, and the safe one is the big filled
///    one on top. Reaching the override takes a second, deliberate look.
///
/// The green/blue chip stays inside the red frame: red says "something is
/// wrong", and the chip says which of the two familiar things it is about.
///
/// Pops true to record anyway, or null to cancel.
class TooSoonDialog extends StatelessWidget {
  const TooSoonDialog({
    super.key,
    required this.blocked,
    required this.worker,
    required this.elapsedMinutes,
    required this.remainingSeconds,
    this.isDuplicate = false,
  });

  /// What the scan would have recorded had the wait already passed.
  final TapAction? blocked;
  final WorkerCard? worker;
  final int elapsedMinutes;
  final int remainingSeconds;

  /// True for the short duplicate cooldown, false for the longer safety gap.
  /// Only changes the wording — the choice offered is the same.
  final bool isDuplicate;

  bool get _isLogout => blocked != TapAction.login;

  /// The colour of the action being held up, so the two familiar colours still
  /// name it inside the red frame.
  Color get _actionColor => _isLogout ? ClamsColors.info : ClamsColors.success;

  String get _headline {
    final name = worker?.fullName ?? 'This person';
    if (isDuplicate) return '$name was scanned a moment ago.';
    final verb = _isLogout ? 'logged in' : 'logged out';
    final ago = elapsedMinutes <= 0
        ? 'less than a minute ago'
        : '$elapsedMinutes minute${elapsedMinutes == 1 ? '' : 's'} ago';
    return '$name $verb $ago.';
  }

  /// The clock time the scan starts working again — easier to act on at a gate
  /// than a countdown the watchman would have to keep watching.
  String get _allowedFrom {
    final at = DateTime.now().add(Duration(seconds: remainingSeconds));
    final hh = at.hour.toString().padLeft(2, '0');
    final mm = at.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }

  String get _wait {
    if (!isDuplicate) {
      return '${_isLogout ? 'Logout' : 'Login'} allowed from $_allowedFrom';
    }
    return remainingSeconds <= 0
        ? 'You can scan again now'
        : 'Scanning again is allowed in ${remainingSeconds}s';
  }

  @override
  Widget build(BuildContext context) {
    final w = worker;
    // A fixed inner width lets the two buttons below be full-width without
    // handing an unbounded constraint to a SizedBox.
    final width = math.min(360.0, MediaQuery.sizeOf(context).width - 72);

    return AlertDialog(
      backgroundColor: ClamsColors.surface,
      contentPadding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
      // A red hairline all the way round, so the frame reads as red even where
      // the white content fills the middle.
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(ClamsRadius.card + 4),
        side: const BorderSide(color: ClamsColors.error, width: 2),
      ),
      content: SizedBox(
        width: width,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // ---- The red mark ----
                    Center(
                      child: Container(
                        width: 76,
                        height: 76,
                        decoration: BoxDecoration(
                          color: ClamsColors.errorTint,
                          shape: BoxShape.circle,
                          border: Border.all(color: ClamsColors.error, width: 2),
                        ),
                        child: Icon(
                          isDuplicate ? Icons.copy_rounded : Icons.front_hand_rounded,
                          color: ClamsColors.error,
                          size: 40,
                        ),
                      ),
                    ),
                    ClamsSpacing.gapMd,
                    Text(
                      isDuplicate ? 'SAME CARD AGAIN' : 'TOO SOON',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: ClamsColors.error,
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.6,
                      ),
                    ),

                    ClamsSpacing.gapLg,

                    // ---- Who ----
                    // The face first. He is looking at this man; matching a
                    // photograph is something he can do without reading.
                    if (w != null) ...[
                      Center(child: ApiCircleAvatar(photoUrl: w.photoUrl, radius: 44)),
                      ClamsSpacing.gapSm,
                      Text(
                        w.fullName,
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                      ),
                      Text(
                        w.workerCode,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 14,
                          color: ClamsColors.textSecondary,
                        ),
                      ),
                      ClamsSpacing.gapMd,
                    ],

                    // ---- Which of the two familiar things ----
                    Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 14),
                        decoration: BoxDecoration(
                          color: _actionColor.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              _isLogout ? Icons.logout : Icons.login,
                              color: _actionColor,
                              size: 20,
                            ),
                            const SizedBox(width: 8),
                            Text(
                              _isLogout ? 'LOGOUT' : 'LOGIN',
                              style: TextStyle(
                                color: _actionColor,
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 0.5,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),

                    ClamsSpacing.gapMd,
                    Text(
                      _headline,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 15),
                    ),
                    ClamsSpacing.gapSm,
                    Container(
                      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
                      decoration: BoxDecoration(
                        color: ClamsColors.errorTint,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(Icons.schedule, size: 18, color: ClamsColors.error),
                          const SizedBox(width: 8),
                          Flexible(
                            child: Text(
                              _wait,
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontWeight: FontWeight.w700,
                                color: ClamsColors.error,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // ---- The choice ----
            // Stacked, not side by side. The routine dialog he taps all shift
            // puts its buttons in a row; a different arrangement is the cheapest
            // way to stop a habit completing this one for him.
            ClamsSpacing.gapLg,
            SizedBox(
              height: 56,
              child: FilledButton.icon(
                onPressed: () => Navigator.pop(context),
                icon: const Icon(Icons.close_rounded, size: 24),
                label: const Text(
                  'DO NOT RECORD',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
                style: FilledButton.styleFrom(
                  backgroundColor: ClamsColors.text,
                  foregroundColor: Colors.white,
                ),
              ),
            ),
            ClamsSpacing.gapSm,
            SizedBox(
              height: 52,
              child: OutlinedButton.icon(
                onPressed: () => Navigator.pop(context, true),
                icon: const Icon(Icons.check_rounded, size: 22),
                label: const Text(
                  'RECORD ANYWAY',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                ),
                style: OutlinedButton.styleFrom(
                  foregroundColor: ClamsColors.error,
                  side: const BorderSide(color: ClamsColors.error, width: 1.5),
                ),
              ),
            ),
            ClamsSpacing.gapSm,
            Text(
              _isLogout
                  ? 'Only if this person is really leaving now.'
                  : 'Only if this person is really here now.',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12, color: ClamsColors.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
