import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../../app/theme.dart';

/// How a scan went, shown as a banner on the camera itself.
enum ScanFeedbackKind { success, info, warning, error }

class ScanFeedback {
  const ScanFeedback(this.kind, this.message, {this.detail});
  const ScanFeedback.success(String message, {String? detail})
      : this(ScanFeedbackKind.success, message, detail: detail);
  const ScanFeedback.info(String message, {String? detail})
      : this(ScanFeedbackKind.info, message, detail: detail);
  const ScanFeedback.warning(String message, {String? detail})
      : this(ScanFeedbackKind.warning, message, detail: detail);
  const ScanFeedback.error(String message, {String? detail})
      : this(ScanFeedbackKind.error, message, detail: detail);

  final ScanFeedbackKind kind;
  final String message;
  final String? detail;
}

/// Full-screen QR scanner for CLAMS badges ("CLAMS:W-0001"), driven as a queue:
/// the camera stays up and [onCode] is called for each new badge, so the
/// watchman works a line of workers without leaving the screen. Aadhaar QRs use
/// the dedicated zxing-cpp scanner in features/aadhaar instead.
///
/// The screen owns ONE controller for its whole life, and remembers the badge it
/// just handled. A badge held in front of the lens keeps being detected — that
/// is how a camera works — so without that memory the same worker is processed
/// over and over. Previously each scan pushed a fresh scanner (fresh controller,
/// and `noDuplicates` only remembers within one controller), so the worker still
/// standing at the gate was re-read until the duplicate cooldown lapsed and the
/// read that finally got through scanned him back out a minute after he arrived.
///
/// The badge re-arms once it has been out of frame for [_rearmAfter]: physically
/// taking it away and presenting it again is a new scan, holding it still is not.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key, required this.onCode});

  /// Handles one scanned badge and returns what to show on the camera.
  /// Returning null shows nothing (e.g. the watchman cancelled).
  final Future<ScanFeedback?> Function(String code) onCode;

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> with WidgetsBindingObserver {
  /// Detection is continuous on purpose: seeing the same badge frame after
  /// frame is what tells us it has not been taken away yet.
  final MobileScannerController _controller = MobileScannerController(
    autoStart: false,
    detectionSpeed: DetectionSpeed.normal,
    formats: const [BarcodeFormat.qrCode],
  );

  /// A badge must be out of frame this long before it counts as a new scan.
  static const _rearmAfter = Duration(seconds: 3);

  /// The banner clears itself so it can never be mistaken for the next worker.
  static const _feedbackFor = Duration(seconds: 4);

  bool _handling = false;
  String? _lastHandledCode;
  DateTime _lastSeenAt = DateTime.fromMillisecondsSinceEpoch(0);
  ScanFeedback? _feedback;
  Timer? _feedbackTimer;
  bool _holdingSameBadge = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_controller.start());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(_controller.start());
        break;
      case AppLifecycleState.inactive:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        unawaited(_controller.stop());
        break;
    }
  }

  @override
  void dispose() {
    _feedbackTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    super.dispose();
  }

  void _show(ScanFeedback? feedback) {
    _feedbackTimer?.cancel();
    if (!mounted) return;
    setState(() => _feedback = feedback);
    if (feedback == null) return;
    _feedbackTimer = Timer(_feedbackFor, () {
      if (mounted) setState(() => _feedback = null);
    });
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    final code = capture.barcodes.isNotEmpty ? capture.barcodes.first.rawValue : null;
    if (code == null || code.isEmpty) return;

    final now = DateTime.now();
    final isSameBadge = code == _lastHandledCode;
    final stillInFrame = now.difference(_lastSeenAt) < _rearmAfter;

    // Keep the "still here" clock fresh whenever we can see it, including while
    // a dialog is open over the camera — otherwise dismissing the dialog would
    // look like the badge had been taken away and come back.
    if (isSameBadge) _lastSeenAt = now;

    if (_handling) return;

    if (isSameBadge && stillInFrame) {
      // Say so, rather than silently doing nothing: the watchman kept holding
      // the badge up precisely because the old build gave him no sign at all.
      if (!_holdingSameBadge) {
        _holdingSameBadge = true;
        _show(const ScanFeedback.info(
          'Already scanned',
          detail: 'Move this badge away, then show the next one.',
        ));
      }
      return;
    }

    _handling = true;
    _holdingSameBadge = false;
    _lastHandledCode = code;
    _lastSeenAt = now;
    try {
      final feedback = await widget.onCode(code);
      _show(feedback);
    } finally {
      _handling = false;
      // The badge is almost certainly still in front of the lens now. Treat it
      // as present so it has to be taken away before it can scan again.
      _lastSeenAt = DateTime.now();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Scan worker QR'),
        actions: [
          IconButton(
            tooltip: 'Toggle torch',
            icon: const Icon(Icons.flashlight_on),
            onPressed: () => unawaited(_controller.toggleTorch()),
          ),
        ],
      ),
      body: Stack(
        alignment: Alignment.center,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: (capture) => unawaited(_onDetect(capture)),
            errorBuilder: (context, error, child) {
              return Container(
                color: Colors.black,
                padding: const EdgeInsets.all(24),
                alignment: Alignment.center,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.videocam_off, color: Colors.white, size: 56),
                    const SizedBox(height: 16),
                    Text(
                      'Camera error: ${error.errorCode.name}',
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      error.errorDetails?.message ??
                          'Grant camera permission in Settings, or use Manual entry.',
                      style: const TextStyle(color: Colors.white70),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: () => unawaited(_controller.start()),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              );
            },
          ),
          IgnorePointer(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white, width: 3),
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),
          // Result of the last scan, on the camera itself. It used to be a
          // SnackBar on the screen underneath, which the camera covered before
          // anyone could read it.
          Positioned(
            top: 12,
            left: 12,
            right: 12,
            child: _FeedbackBanner(feedback: _feedback),
          ),
          const Positioned(
            bottom: 40,
            child: Text(
              'Point the camera at the worker QR badge',
              style: TextStyle(color: Colors.white, backgroundColor: Colors.black54),
            ),
          ),
        ],
      ),
    );
  }
}

class _FeedbackBanner extends StatelessWidget {
  const _FeedbackBanner({required this.feedback});
  final ScanFeedback? feedback;

  (Color, IconData) get _style => switch (feedback!.kind) {
        ScanFeedbackKind.success => (ClamsColors.success, Icons.check_circle),
        ScanFeedbackKind.info => (ClamsColors.info, Icons.info),
        ScanFeedbackKind.warning => (ClamsColors.warning, Icons.warning_amber),
        ScanFeedbackKind.error => (ClamsColors.error, Icons.error),
      };

  @override
  Widget build(BuildContext context) {
    final f = feedback;
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 180),
      child: f == null
          ? const SizedBox.shrink()
          : Container(
              key: ValueKey('${f.kind}|${f.message}|${f.detail}'),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: _style.$1,
                borderRadius: BorderRadius.circular(12),
                boxShadow: const [
                  BoxShadow(color: Colors.black45, blurRadius: 12, offset: Offset(0, 4)),
                ],
              ),
              child: Row(
                children: [
                  Icon(_style.$2, color: Colors.white, size: 26),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          f.message,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        if (f.detail != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              f.detail!,
                              style: const TextStyle(color: Colors.white, fontSize: 13),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}
