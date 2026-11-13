import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class EmailVerificationDialog extends StatefulWidget {
  const EmailVerificationDialog({
    super.key,
    required this.name,
    required this.email,
    required this.password,
  });

  final String name;
  final String email;
  final String password;

  @override
  State<EmailVerificationDialog> createState() => _EmailVerificationDialogState();
}

class _EmailVerificationDialogState extends State<EmailVerificationDialog> {
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
    return data is Map && data['error'] is String ? data['error'] as String : fallback;
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
      if (mounted) setState(() {
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
      if (mounted) setState(() {
        _messageIsError = false;
        _message = 'A new code was sent.';
      });
    } on DioException catch (error) {
      if (mounted) setState(() {
        _messageIsError = true;
        _message = _error(error, 'Unable to send a code. Check your connection.');
      });
    } catch (_) {
      if (mounted) setState(() {
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
      child: AlertDialog(
        title: const Text('Verify your email'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Enter the code sent to ${widget.email}.'),
              const SizedBox(height: 16),
              TextField(
                controller: _code,
                autofocus: true,
                keyboardType: TextInputType.number,
                autofillHints: const [AutofillHints.oneTimeCode],
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
                onSubmitted: (_) => _verify(),
                decoration: const InputDecoration(labelText: 'Email verification code'),
              ),
              if (_message != null) ...[
                const SizedBox(height: 12),
                Text(_message!, style: TextStyle(color: _messageIsError ? Theme.of(context).colorScheme.error : null)),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          TextButton(onPressed: _busy ? null : _resend, child: const Text('Resend code')),
          FilledButton(
            onPressed: _busy ? null : _verify,
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Verify'),
          ),
        ],
      ),
    );
  }
}
