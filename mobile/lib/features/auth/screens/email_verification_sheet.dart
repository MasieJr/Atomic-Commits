import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class EmailVerificationSheet extends StatefulWidget {
  const EmailVerificationSheet({
    super.key,
    required this.name,
    required this.email,
    required this.password,
  });

  final String name;
  final String email;
  final String password;

  @override
  State<EmailVerificationSheet> createState() => _EmailVerificationSheetState();
}

class _EmailVerificationSheetState extends State<EmailVerificationSheet> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _message;
  bool _messageIsError = true;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  String _error(DioException error, String fallback) {
    final data = error.response?.data;
    return data is Map && data['error'] is String
        ? data['error'] as String
        : fallback;
  }

  Future<void> _verify() async {
    if (_busy) return;
    final code = _code.text.trim();
    if (!RegExp(r'^[0-9]{6,10}$').hasMatch(code)) {
      setState(() {
        _messageIsError = true;
        _message = 'Enter the code from your email.';
      });
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await getIt<AuthController>().register(
        name: widget.name,
        email: widget.email,
        password: widget.password,
        emailCode: code,
      );
      if (mounted) {
        setState(() => _busy = false);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) Navigator.of(context).pop(true);
        });
      }
    } on DioException catch (error) {
      if (!mounted) return;
      setState(() {
        _messageIsError = true;
        _message = _error(
          error,
          error.response == null
              ? 'Account creation may have completed. Try signing in before requesting another code.'
              : 'Unable to verify the code. Please try again.',
        );
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _messageIsError = true;
        _message = 'Unable to verify the code. Please try again.';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resend() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await getIt<AuthController>().sendEmailCode(widget.email);
      if (!mounted) return;
      setState(() {
        _messageIsError = false;
        _message = 'A new code was sent.';
      });
    } on DioException catch (error) {
      if (!mounted) return;
      setState(() {
        _messageIsError = true;
        _message = _error(
          error,
          'Unable to send a code. Check your connection.',
        );
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _messageIsError = true;
        _message = 'Unable to send a code. Please try again.';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_busy,
      child: Container(
        decoration: const BoxDecoration(
          color: AppColours.paperTop,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(
              24,
              16,
              24,
              24 + MediaQuery.viewInsetsOf(context).bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: AppColours.orange,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                const Text(
                  'Verify your email',
                  style: TextStyle(
                    color: AppColours.ink,
                    fontSize: 23,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Enter the code sent to ${widget.email}.',
                  style: const TextStyle(color: AppColours.subtle),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _code,
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  autofillHints: const [AutofillHints.oneTimeCode],
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(10),
                  ],
                  onSubmitted: (_) => _verify(),
                  decoration: const InputDecoration(
                    labelText: 'Email verification code',
                  ),
                ),
                if (_message != null) ...[
                  const SizedBox(height: 12),
                  Text(
                    _message!,
                    style: TextStyle(
                      color: _messageIsError
                          ? AppColours.error
                          : AppColours.subtle,
                    ),
                  ),
                ],
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: _busy ? null : _verify,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                    backgroundColor: AppColours.cobalt,
                    foregroundColor: Colors.white,
                  ),
                  child: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Verify and create account'),
                ),
                TextButton(
                  onPressed: _busy ? null : _resend,
                  child: const Text('Resend code'),
                ),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => Navigator.of(context).pop(false),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
