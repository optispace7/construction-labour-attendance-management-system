import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/config/env.dart';
import '../../core/widgets/app_version_label.dart';
import '../sos/sos_button.dart';
import 'auth_controller.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final ok = await ref.read(authControllerProvider.notifier).login(
          _email.text.trim(),
          _password.text,
        );
    if (ok && mounted) context.go('/site');
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(authControllerProvider);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Align(
                    alignment: Alignment.center,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: ClamsSpacing.xl, vertical: 14),
                      decoration: BoxDecoration(
                        color: ClamsColors.primaryDark,
                        borderRadius: BorderRadius.circular(ClamsRadius.card),
                      ),
                      child: Image.asset('assets/logo.png', height: 56, fit: BoxFit.contain),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    'CLAMS',
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                          color: ClamsColors.text,
                        ),
                  ),
                  ClamsSpacing.gapXs,
                  Text('Attendance terminal',
                      style: Theme.of(context)
                          .textTheme
                          .bodyMedium
                          ?.copyWith(color: ClamsColors.textSecondary)),
                  ClamsSpacing.gapXl,
                  if (state.error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: ClamsSpacing.md),
                      child: Text(state.error!,
                          style: const TextStyle(color: ClamsColors.error)),
                    ),
                  TextField(
                    controller: _email,
                    keyboardType: TextInputType.text,
                    decoration: const InputDecoration(labelText: 'Email or user ID'),
                  ),
                  ClamsSpacing.gapLg,
                  TextField(
                    controller: _password,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'Password'),
                  ),
                  ClamsSpacing.gapXl,
                  FilledButton(
                    onPressed: state.loading ? null : _submit,
                    child: Text(state.loading ? 'Signing in…' : 'Sign in'),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: () => showDialog<void>(
                        context: context,
                        builder: (_) =>
                            ForgotPasswordDialog(initialIdentifier: _email.text.trim()),
                      ),
                      child: const Text('Forgot password?'),
                    ),
                  ),
                  const SizedBox(height: 32),
                  const Divider(),
                  const SizedBox(height: 8),
                  // Works without signing in — site resolved via GPS.
                  const SosButton(),
                  const SizedBox(height: 16),
                  const AppVersionLabel(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Self-service password reset.
///
/// Better Auth emails a link rather than a code. The OTP endpoints this dialog
/// used to call — /auth/forgot-password and its verify step — were part of the
/// JWT scheme and no longer exist, so every attempt came back "Cannot POST
/// /api/v1/auth/forgot-password" from the bare Express 404.
///
/// So the app now asks Better Auth to send the link and stops there. Setting
/// the new password happens on the panel page the link opens, which is the
/// same page the panel's own reset uses; there is no second step to do here.
///
/// Uses a plain Dio, like the SOS service, because the user is not signed in.
class ForgotPasswordDialog extends StatefulWidget {
  const ForgotPasswordDialog({super.key, this.initialIdentifier = ''});

  final String initialIdentifier;

  @override
  State<ForgotPasswordDialog> createState() => _ForgotPasswordDialogState();
}

class _ForgotPasswordDialogState extends State<ForgotPasswordDialog> {
  late final _identifier = TextEditingController(text: widget.initialIdentifier);

  final _dio = Dio(BaseOptions(baseUrl: Env.betterAuthBaseUrl));

  bool _busy = false;
  bool _sent = false;
  String? _info;
  String? _error;

  @override
  void dispose() {
    _identifier.dispose();
    super.dispose();
  }

  String _detail(DioException e, String fallback) {
    final data = e.response?.data;
    final detail = data is Map ? (data['message'] ?? data['detail'] ?? data['title']) : null;
    return detail is String && detail.isNotEmpty ? detail : (e.message ?? fallback);
  }

  Future<void> _sendLink() async {
    final id = _identifier.text.trim();
    if (id.isEmpty) {
      setState(() => _error = 'Enter your email address');
      return;
    }
    // Watchmen sign in with a user ID and have no mailbox — their address is a
    // synthesised .invalid one — so there is nothing to send to. Answered here
    // rather than by the server, which would otherwise claim a link was on its
    // way to an address that cannot receive one.
    if (!id.contains('@')) {
      setState(() {
        _sent = true;
        _error = null;
        _info = 'This account signs in with a user ID and has no email address. '
            'Ask your administrator to set a new password for you.';
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _info = null;
    });
    try {
      await _dio.post('/request-password-reset', data: {
        'email': id,
        // Where the emailed link lands. It has to be an address Better Auth
        // trusts, and the panel's login page is the one on that list.
        'redirectTo': '${Env.panelBaseUrl}/login',
      });
      if (!mounted) return;
      setState(() {
        _busy = false;
        _sent = true;
        // Deliberately the same answer whether or not the address is known, so
        // this cannot be used to find out who has an account.
        _info = 'If that address has an account, a reset link is on its way. '
            'Open it on this phone or any browser, set a new password, then '
            'sign in here with it.';
      });
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _detail(e, 'Could not send the reset link');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Forgot password'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: ClamsSpacing.md),
                child: Text(_error!, style: const TextStyle(color: ClamsColors.error)),
              ),
            if (_info != null)
              Padding(
                padding: const EdgeInsets.only(bottom: ClamsSpacing.md),
                child: Text(_info!,
                    style: const TextStyle(color: ClamsColors.textSecondary)),
              ),
            if (!_sent)
              TextField(
                controller: _identifier,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(labelText: 'Email address'),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: Text(_sent ? 'Close' : 'Cancel'),
        ),
        if (!_sent)
          FilledButton(
            onPressed: _busy ? null : _sendLink,
            child: Text(_busy ? 'Please wait…' : 'Send reset link'),
          ),
      ],
    );
  }
}
