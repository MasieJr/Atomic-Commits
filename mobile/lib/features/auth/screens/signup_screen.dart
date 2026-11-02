import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/widgets/auth/art.dart';
import 'package:atomic_commits/core/widgets/auth/custom_text_field.dart';
import 'package:atomic_commits/core/widgets/auth/header.dart';
import 'package:atomic_commits/core/widgets/auth/secondary.dart';
import 'package:atomic_commits/core/widgets/auth/signup_texture.dart';
import 'package:atomic_commits/core/widgets/auth/submit_button.dart';
import 'package:atomic_commits/core/widgets/auth/top_line.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Sign-up screen. Pure UI mock: no backend, no credential storage, no
/// account creation. Matches the signup.html art direction (paper gradient,
/// dotted texture, warm orbs) without any device frame.
class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key});

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  final _formKey = GlobalKey<FormState>();

  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();

  final _nameFocus = FocusNode();
  final _emailFocus = FocusNode();
  final _passwordFocus = FocusNode();
  final _confirmFocus = FocusNode();

  bool _obscurePassword = true;
  bool _obscureConfirm = true;

  /// Errors appear only after the first submit attempt; afterwards fields
  /// revalidate on user interaction so mistakes can be corrected inline.
  bool _validatingLive = false;

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    _confirmController.dispose();
    _nameFocus.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    _confirmFocus.dispose();
    super.dispose();
  }

  // --- Validation ---------------------------------------------------------

  String? _validateName(String? raw) {
    if (raw == null || raw.trim().isEmpty) return 'Enter your full name.';
    return null;
  }

  String? _validateEmail(String? raw) {
    final value = raw?.trim() ?? '';
    if (value.isEmpty) return 'Enter your email address.';
    final pattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
    if (!pattern.hasMatch(value)) return 'Enter a valid email address.';
    return null;
  }

  String? _validatePassword(String? raw) {
    final value = raw ?? '';
    if (value.isEmpty) return 'Enter a password.';
    if (value.length < 8) return 'Use at least 8 characters.';
    return null;
  }

  String? _validateConfirm(String? raw) {
    final value = raw ?? '';
    if (value.isEmpty) return 'Confirm your password.';
    if (value != _passwordController.text) return 'Passwords do not match.';
    return null;
  }

  // --- Actions ------------------------------------------------------------

  List<({FocusNode node, String? Function() validate})> _fieldEntries() => [
    (node: _nameFocus, validate: () => _validateName(_nameController.text)),
    (node: _emailFocus, validate: () => _validateEmail(_emailController.text)),
    (
      node: _passwordFocus,
      validate: () => _validatePassword(_passwordController.text),
    ),
    (
      node: _confirmFocus,
      validate: () => _validateConfirm(_confirmController.text),
    ),
  ];

  void _submit() {
    setState(() => _validatingLive = true);
    ScaffoldMessenger.of(context).hideCurrentSnackBar();
    FocusScope.of(context).unfocus();

    if (!_formKey.currentState!.validate()) {
      final firstInvalid = _fieldEntries().firstWhere(
        (entry) => entry.validate() != null,
      );
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final nodeContext = firstInvalid.node.context;
        if (nodeContext != null) {
          Scrollable.ensureVisible(
            nodeContext,
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOut,
          );
        }
        firstInvalid.node.requestFocus();
      });
      return;
    }

    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(
          content: Text('Sign-up preview only — no account has been created.'),
        ),
      );
  }

  // --- Build --------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: AppColours.paperBottom,
      ),
      child: Scaffold(
        backgroundColor: AppColours.paperTop,
        body: Stack(
          fit: StackFit.expand,
          children: [
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    AppColours.paperTop,
                    AppColours.paperMid,
                    AppColours.paperBottom,
                  ],
                  stops: [0, 0.65, 1],
                ),
              ),
            ),
            const IgnorePointer(child: SignupTexture()),
            SafeArea(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final width = constraints.maxWidth.clamp(0.0, 520.0);

                  return Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(
                      constraints: BoxConstraints(maxWidth: width),
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(24, 12, 24, 24),
                        child: AutofillGroup(
                          onDisposeAction: AutofillContextAction.cancel,
                          child: Form(
                            key: _formKey,
                            autovalidateMode: _validatingLive
                                ? AutovalidateMode.onUserInteraction
                                : AutovalidateMode.disabled,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                TopLine(width: width),
                                const Art(),
                                const SizedBox(height: 16),
                                Header(width: width),
                                const SizedBox(height: 16),
                                CustomTextField(
                                  width: width,
                                  inputKey: const ValueKey('signup-name'),
                                  label: 'Full name',
                                  hint: 'Your full name',
                                  icon: Icons.person_outline,
                                  controller: _nameController,
                                  focusNode: _nameFocus,
                                  keyboardType: TextInputType.name,
                                  autofillHints: const [AutofillHints.name],
                                  textCapitalization: TextCapitalization.words,
                                  textInputAction: TextInputAction.next,
                                  nextFocus: _emailFocus,
                                  validator: _validateName,
                                ),
                                const SizedBox(height: 10),
                                CustomTextField(
                                  width: width,
                                  inputKey: const ValueKey('signup-email'),
                                  label: 'Email address',
                                  hint: 'you@example.com',
                                  icon: Icons.mail_outline,
                                  controller: _emailController,
                                  focusNode: _emailFocus,
                                  keyboardType: TextInputType.emailAddress,
                                  autofillHints: const [AutofillHints.email],
                                  textInputAction: TextInputAction.next,
                                  nextFocus: _passwordFocus,
                                  validator: _validateEmail,
                                ),
                                const SizedBox(height: 10),
                                CustomTextField(
                                  width: width,
                                  inputKey: const ValueKey('signup-password'),
                                  label: 'Password',
                                  hint: 'At least 8 characters',
                                  icon: Icons.lock_outline,
                                  controller: _passwordController,
                                  focusNode: _passwordFocus,
                                  autofillHints: const [
                                    AutofillHints.newPassword,
                                  ],
                                  textInputAction: TextInputAction.next,
                                  nextFocus: _confirmFocus,
                                  obscure: _obscurePassword,
                                  toggleTooltip: _obscurePassword
                                      ? 'Show password'
                                      : 'Hide password',
                                  onToggle: () => setState(
                                    () => _obscurePassword = !_obscurePassword,
                                  ),
                                  validator: _validatePassword,
                                ),
                                const SizedBox(height: 10),
                                CustomTextField(
                                  width: width,
                                  inputKey: const ValueKey(
                                    'signup-password-confirm',
                                  ),
                                  label: 'Confirm password',
                                  hint: 'Repeat your password',
                                  icon: Icons.lock_outline,
                                  controller: _confirmController,
                                  focusNode: _confirmFocus,
                                  autofillHints: const [
                                    AutofillHints.newPassword,
                                  ],
                                  textInputAction: TextInputAction.done,
                                  nextFocus: null,
                                  obscure: _obscureConfirm,
                                  toggleTooltip: _obscureConfirm
                                      ? 'Show confirm password'
                                      : 'Hide confirm password',
                                  onToggle: () => setState(
                                    () => _obscureConfirm = !_obscureConfirm,
                                  ),
                                  validator: _validateConfirm,
                                ),
                                const SizedBox(height: 18),
                                SubmitButton(width: width, submit: _submit),
                                const SizedBox(height: 14),
                                Secondary(width: width),
                                const SizedBox(height: 12),
                                const Text(
                                  'Pay by code. Carry on.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(
                                    color: AppColours.footnote,
                                    fontSize: 12,
                                    height: 1.45,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
