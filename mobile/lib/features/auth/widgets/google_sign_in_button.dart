import 'dart:async';

import 'package:flutter/material.dart';

import '../google_sign_in_flow.dart';
import '../models/user_model.dart';

/// Owns one flow. Supply an HTTPS origin (or development localhost origin).
/// An embedded WebView host must allow an external browser to open; the OAuth
/// provider must not be opened inside the WebView.
class GoogleSignInButton extends StatefulWidget {
  const GoogleSignInButton({super.key, required this.apiOrigin, required this.onComplete, this.enabled = true});

  final Uri apiOrigin;
  final Future<void> Function(UserModel user, String token, String? refreshToken) onComplete;
  final bool enabled;

  @override
  State<GoogleSignInButton> createState() => _GoogleSignInButtonState();
}

class _GoogleSignInButtonState extends State<GoogleSignInButton> with WidgetsBindingObserver {
  late final GoogleSignInFlow _flow;
  final _password = TextEditingController();
  Timer? _refresh;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _flow = GoogleSignInFlow(apiOrigin: widget.apiOrigin, onComplete: widget.onComplete);
    _flow.addListener(_changed);
    _flow.setAppActive(WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed);
  }

  void _changed() {
    if (_flow.phase != GoogleSignInPhase.linking) _password.clear();
    _refresh?.cancel();
    final retry = _flow.linkRetryAt;
    if (_flow.phase == GoogleSignInPhase.linking && retry != null && retry.isAfter(DateTime.now())) {
      _refresh = Timer(retry.difference(DateTime.now()), () { if (mounted) setState(() {}); });
    }
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _flow.setAppActive(state == AppLifecycleState.resumed);

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refresh?.cancel();
    _flow.removeListener(_changed);
    _flow.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final phase = _flow.phase;
    final canStart = phase == GoogleSignInPhase.idle || phase == GoogleSignInPhase.error || phase == GoogleSignInPhase.finished;
    final canCancel = !canStart && _flow.canCancel;
    final canLink = _flow.linkRetryAt == null || !_flow.linkRetryAt!.isAfter(DateTime.now());
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (canStart)
          OutlinedButton(onPressed: widget.enabled && _flow.available ? _flow.start : null, child: const Text('Continue with Google')),
        if (phase == GoogleSignInPhase.openBrowser)
          FilledButton(onPressed: _flow.openBrowser, child: const Text('Open Google in browser')),
        if (_flow.checkingAvailability || phase == GoogleSignInPhase.preparing || phase == GoogleSignInPhase.submitting || phase == GoogleSignInPhase.finishing)
          const Center(child: CircularProgressIndicator()),
        if (_flow.message != null) Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(_flow.message!),
        ),
        if (phase == GoogleSignInPhase.linking) ...[
          const Text('An Atomic Commits account already exists. Connecting Google adds it as a future sign-in method. This connection is not undone by cancelling afterwards.'),
          if (_flow.attemptsRemaining != null) Text('Password attempts remaining: ${_flow.attemptsRemaining}'),
          TextField(controller: _password, obscureText: true, enableSuggestions: false, autocorrect: false,
              decoration: const InputDecoration(labelText: 'Atomic Commits password')),
          FilledButton(
            onPressed: canLink ? () {
              final password = _password.text;
              _password.clear();
              unawaited(_flow.link(password));
            } : null,
            child: const Text('Connect Google to my existing account'),
          ),
        ],
        if (canCancel) TextButton(onPressed: _flow.cancel, child: const Text('Cancel Google sign-in')),
      ],
    );
  }
}
