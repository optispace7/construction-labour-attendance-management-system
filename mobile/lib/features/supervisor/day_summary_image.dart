import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../../app/theme.dart';

/// One line of a breakdown: a designation or a contractor, and how many people.
class SummaryLine {
  const SummaryLine(this.name, this.count);
  final String name;
  final int count;
}

/// Who the sheet is for, which is the only thing that differs between the two.
///
/// The client is sent the trades and nothing else — how many masons were on
/// site is their question. Which contractor supplied them is ours, so the
/// internal sheet carries the vendor breakdown as well.
enum SummaryAudience { client, internal }

/// The company header, as printed on ID cards — same source, same look.
class SummaryOrg {
  const SummaryOrg({this.name, this.logoBytes, this.logoScale = 1.0});
  final String? name;
  final Uint8List? logoBytes;
  final double logoScale;
}

/// Width the sheet is laid out at, in logical pixels. Captured at 3× for a
/// 1920px-wide PNG: sharp when opened full-screen, small enough for WhatsApp
/// not to re-compress it into mush.
const double _sheetWidth = 640;
const double _captureScale = 3;

/// The day summary as a picture that can be sent to somebody.
///
/// Built from the figures already on the screen rather than fetched again, so
/// the image and the screen it was shared from cannot disagree.
class DaySummarySheet extends StatelessWidget {
  const DaySummarySheet({
    super.key,
    required this.audience,
    required this.org,
    required this.siteName,
    required this.dateLabel,
    required this.byDesignation,
    required this.byVendor,
  });

  final SummaryAudience audience;
  final SummaryOrg org;
  final String siteName;
  final String dateLabel;
  final List<SummaryLine> byDesignation;
  final List<SummaryLine> byVendor;

  bool get _showsVendors => audience == SummaryAudience.internal;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: _sheetWidth,
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(36, 32, 36, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _header(),
          const SizedBox(height: 26),
          _Table(title: 'Designation', rows: byDesignation),
          if (_showsVendors) ...[
            const SizedBox(height: 22),
            _Table(title: 'Vendor / contractor', rows: byVendor),
          ],
          const SizedBox(height: 22),
          _footer(),
        ],
      ),
    );
  }

  Widget _header() {
    final logo = org.logoBytes;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (logo != null || (org.name ?? '').isNotEmpty)
          Row(
            children: [
              if (logo != null) ...[
                // Clipped to a fixed box like the ID card, so a wide logo and a
                // square one both sit on the same baseline.
                SizedBox(
                  width: 96,
                  height: 48,
                  child: ClipRect(
                    child: Transform.scale(
                      scale: org.logoScale,
                      child: Image.memory(logo, fit: BoxFit.contain),
                    ),
                  ),
                ),
                const SizedBox(width: 16),
              ],
              if ((org.name ?? '').isNotEmpty)
                Expanded(
                  child: Text(
                    org.name!.toUpperCase(),
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.6,
                      color: ClamsColors.text,
                    ),
                  ),
                ),
            ],
          ),
        const SizedBox(height: 20),
        const Text(
          'Daily manpower',
          style: TextStyle(fontSize: 27, fontWeight: FontWeight.w700, color: ClamsColors.text),
        ),
        const SizedBox(height: 6),
        Text(
          [if (siteName.isNotEmpty) siteName, dateLabel].join('  ·  '),
          style: const TextStyle(fontSize: 15, color: ClamsColors.textSecondary),
        ),
      ],
    );
  }

  /// Named so a forwarded image can still be traced back to a day and a source.
  Widget _footer() {
    return Row(
      children: [
        Expanded(
          child: Text(
            _showsVendors ? 'Internal copy — includes contractor split' : 'Manpower summary',
            style: const TextStyle(fontSize: 12, color: ClamsColors.textSecondary),
          ),
        ),
        const Text(
          'CLAMS',
          style: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 1,
            color: ClamsColors.textSecondary,
          ),
        ),
      ],
    );
  }
}

/// One breakdown: a heading, a row per group, and the total underneath.
class _Table extends StatelessWidget {
  const _Table({required this.title, required this.rows});

  final String title;
  final List<SummaryLine> rows;

  @override
  Widget build(BuildContext context) {
    final total = rows.fold<int>(0, (a, b) => a + b.count);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          decoration: const BoxDecoration(
            color: ClamsColors.primary,
            borderRadius: BorderRadius.vertical(top: Radius.circular(10)),
          ),
          child: Row(
            children: [
              Expanded(child: _cell(title.toUpperCase(), header: true)),
              SizedBox(width: 110, child: _cell('WORKERS', header: true, right: true)),
            ],
          ),
        ),
        Container(
          decoration: BoxDecoration(
            border: Border.all(color: ClamsColors.border),
            borderRadius: const BorderRadius.vertical(bottom: Radius.circular(10)),
          ),
          child: Column(
            children: [
              if (rows.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Nobody logged in on this day.',
                          style: TextStyle(fontSize: 15, color: ClamsColors.textSecondary),
                        ),
                      ),
                    ],
                  ),
                ),
              for (var i = 0; i < rows.length; i++)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  decoration: BoxDecoration(
                    // Zebra striping: a long trade list is read across, and on a
                    // phone screen the eye loses the row without it.
                    color: i.isOdd ? const Color(0xFFF7F8FA) : Colors.white,
                  ),
                  child: Row(
                    children: [
                      Expanded(child: _cell(rows[i].name)),
                      SizedBox(width: 110, child: _cell('${rows[i].count}', right: true)),
                    ],
                  ),
                ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
                decoration: const BoxDecoration(
                  color: Color(0xFFEDF0F7),
                  border: Border(top: BorderSide(color: ClamsColors.border)),
                  borderRadius: BorderRadius.vertical(bottom: Radius.circular(10)),
                ),
                child: Row(
                  children: [
                    Expanded(child: _cell('Total', bold: true)),
                    SizedBox(width: 110, child: _cell('$total', bold: true, right: true)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _cell(String text, {bool header = false, bool bold = false, bool right = false}) {
    return Text(
      text,
      textAlign: right ? TextAlign.right : TextAlign.left,
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
      style: header
          ? const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.8,
              color: Colors.white,
            )
          : TextStyle(
              fontSize: 15,
              fontWeight: bold ? FontWeight.w700 : FontWeight.w500,
              color: ClamsColors.text,
            ),
    );
  }
}

/// Paint [sheet] into a PNG without ever showing it to the user.
///
/// The widget is parked off the side of the screen in an overlay rather than
/// wrapped in Offstage: an offstage subtree is laid out but never painted, and
/// a RepaintBoundary with nothing painted into it captures a blank image.
///
/// Any logo must already be decoded before the capture — see
/// [precacheSummaryLogo]. A MemoryImage that has not resolved yet paints
/// nothing on the frame we grab, which loses the logo silently.
Future<Uint8List> renderSummaryPng(BuildContext context, Widget sheet) async {
  final key = GlobalKey();
  final overlay = Overlay.of(context, rootOverlay: true);
  final entry = OverlayEntry(
    builder: (_) => Positioned(
      left: -_sheetWidth * 3,
      top: 0,
      child: Material(
        color: Colors.transparent,
        child: RepaintBoundary(key: key, child: sheet),
      ),
    ),
  );
  overlay.insert(entry);
  try {
    // Two frames: one to lay the sheet out, one to be sure it has painted.
    await WidgetsBinding.instance.endOfFrame;
    await WidgetsBinding.instance.endOfFrame;
    final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: _captureScale);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) throw StateError('the sheet produced no image data');
      return data.buffer.asUint8List();
    } finally {
      image.dispose();
    }
  } finally {
    entry.remove();
  }
}

/// Decode the logo before rendering, so it is on the frame we capture.
Future<void> precacheSummaryLogo(BuildContext context, Uint8List? logoBytes) async {
  if (logoBytes == null) return;
  try {
    await precacheImage(MemoryImage(logoBytes), context);
  } catch (_) {
    // A logo that will not decode is not worth failing the whole share for.
  }
}
