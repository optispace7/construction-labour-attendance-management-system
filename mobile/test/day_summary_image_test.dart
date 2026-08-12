import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:clams_mobile/features/supervisor/day_summary_image.dart';

/// The day summary is shared as a picture now, so "did it render" is a question
/// about pixels. Building the widget without throwing proves nothing: the bug
/// worth guarding against is a sheet that captures blank or clipped, which
/// looks fine in code and arrives at the client as an empty white square.

const _designations = [
  SummaryLine('Mason', 42),
  SummaryLine('Electrician', 18),
  SummaryLine('Helper', 55),
  SummaryLine('Carpenter', 13),
];

const _vendors = [
  SummaryLine('Sri Balaji Contractors', 74),
  SummaryLine('Everest Manpower', 54),
];

Widget _sheet(SummaryAudience audience) => DaySummarySheet(
      audience: audience,
      org: const SummaryOrg(name: 'Optispace Infra Pvt Ltd'),
      siteName: 'IndraNagar 01 Site',
      dateLabel: 'Tue, 12 Aug 2026',
      byDesignation: _designations,
      byVendor: _vendors,
    );

/// Pump the sheet on its own and rasterise it, the same way the share does.
///
/// The capture runs inside [WidgetTester.runAsync]: `toImage` and `toByteData`
/// wait on the engine, and the fake-async zone a widget test normally runs in
/// never lets those futures complete — the test just hangs until it times out.
Future<Uint8List> _renderRgba(
  WidgetTester tester,
  Widget sheet, {
  required void Function(int width, int height) onSize,
}) async {
  final key = GlobalKey();
  await tester.pumpWidget(
    MaterialApp(
      home: Align(
        alignment: Alignment.topLeft,
        child: RepaintBoundary(key: key, child: sheet),
      ),
    ),
  );
  await tester.pumpAndSettle();
  final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;

  late Uint8List pixels;
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 2);
    try {
      onSize(image.width, image.height);
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      pixels = data!.buffer.asUint8List();
    } finally {
      image.dispose();
    }
  });
  return pixels;
}

void main() {
  testWidgets('the client sheet renders the trades and their total', (tester) async {
    tester.view.physicalSize = const Size(2000, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(MaterialApp(home: Align(child: _sheet(SummaryAudience.client))));
    await tester.pumpAndSettle();

    expect(find.text('Daily manpower'), findsOneWidget);
    expect(find.text('OPTISPACE INFRA PVT LTD'), findsOneWidget);
    expect(find.textContaining('IndraNagar 01 Site'), findsOneWidget);
    for (final d in _designations) {
      expect(find.text(d.name), findsOneWidget);
    }
    // 42 + 18 + 55 + 13. The total is computed by the sheet, not passed in, so
    // it cannot drift from the rows printed above it.
    expect(find.text('128'), findsOneWidget);

    // The client is not shown who supplied the labour.
    expect(find.text('VENDOR / CONTRACTOR'), findsNothing);
    for (final v in _vendors) {
      expect(find.text(v.name), findsNothing);
    }
  });

  testWidgets('the internal sheet adds the contractor split', (tester) async {
    tester.view.physicalSize = const Size(2000, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(MaterialApp(home: Align(child: _sheet(SummaryAudience.internal))));
    await tester.pumpAndSettle();

    expect(find.text('DESIGNATION'), findsOneWidget);
    expect(find.text('VENDOR / CONTRACTOR'), findsOneWidget);
    for (final v in _vendors) {
      expect(find.text(v.name), findsOneWidget);
    }
    // Both breakdowns count the same people, so both totals read 128 — one per
    // table, which is what "with total" has to mean for two tables.
    expect(find.text('128'), findsNWidgets(2));
  });

  testWidgets('the captured image is a real sheet, not a blank square', (tester) async {
    tester.view.physicalSize = const Size(2000, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    var width = 0;
    var height = 0;
    final pixels = await _renderRgba(
      tester,
      _sheet(SummaryAudience.internal),
      onSize: (w, h) {
        width = w;
        height = h;
      },
    );

    // 640 logical points wide at 2× — the share captures at 3× for ~1920px.
    expect(width, 1280);
    // Tall enough to be carrying both tables rather than a collapsed sheet.
    expect(height, greaterThan(1200));

    // A blank capture is the failure that matters, and it is all-white or
    // all-transparent. Count how much of the sheet is neither.
    var inked = 0;
    for (var i = 0; i < pixels.length; i += 4) {
      final r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
      if (a > 8 && (r < 235 || g < 235 || b < 235)) inked++;
    }
    final total = pixels.length ~/ 4;
    expect(inked / total, greaterThan(0.02), reason: 'the sheet captured blank');

    // …and it is on white paper, not transparent — WhatsApp renders a
    // transparent PNG on a black background in dark mode.
    final corner = pixels.sublist(0, 4);
    expect(corner[3], 255);
    expect(corner[0], greaterThan(240));
  });
}
