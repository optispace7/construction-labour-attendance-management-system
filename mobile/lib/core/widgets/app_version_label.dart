import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../config/env.dart';

/// The build this phone runs, small and out of the way — so whoever is
/// looking into a scan can ask the gate "which version does it say?".
class AppVersionLabel extends StatelessWidget {
  const AppVersionLabel({super.key});

  @override
  Widget build(BuildContext context) {
    return Text(
      'App version ${Env.appVersion}',
      textAlign: TextAlign.center,
      style: Theme.of(context)
          .textTheme
          .bodySmall
          ?.copyWith(color: ClamsColors.textSecondary),
    );
  }
}
