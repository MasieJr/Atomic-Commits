import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:atomic_commits/core/widgets/auth/art.dart';
import 'package:atomic_commits/core/widgets/auth/custom_text_field.dart';
import 'package:atomic_commits/core/widgets/auth/header.dart';
import 'package:atomic_commits/core/widgets/auth/secondary.dart';
import 'package:atomic_commits/core/widgets/auth/signup_texture.dart';
import 'package:atomic_commits/core/widgets/auth/submit_button.dart';
import 'package:atomic_commits/core/widgets/auth/top_line.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key});

  @override
  State<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends State<SignupScreen> {
  final Utils utils = Utils();
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
  bool _isLoading = false;

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

  String? _validateConfirm(String? raw) {
    final value = raw ?? '';
    if (value.isEmpty) return 'Confirm your password.';
    if (value != _passwordController.text) return 'Passwords do not match.';
    return null;
  }

  // --- Actions ------------------------------------------------------------

  List<({FocusNode node, String? Function() validate})> _fieldEntries() => [
    (
      node: _nameFocus,
      validate: () => utils.validateName(_nameController.text),
    ),
    (
      node: _emailFocus,
      validate: () => utils.validateEmail(_emailController.text),
    ),
    (
      node: _passwordFocus,
      validate: () => utils.validatePassword(_passwordController.text),
    ),
    (
      node: _confirmFocus,
      validate: () => _validateConfirm(_confirmController.text),
    ),
  ];

  Future<void> _submit() async {
    if (_isLoading) return;
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

    setState(() => _isLoading = true);

    try {
      await getIt<AuthController>().register(
        name: _nameController.text.trim(),
        email: _emailController.text.trim(),
        password: _passwordController.text,
      );

      if (!mounted) return;

      TextInput.finishAutofillContext();

      setState(() => _isLoading = false);

      context.go(AppRoutes.wallet);
    } on DioException catch (error) {
      if (!mounted) return;

      setState(() => _isLoading = false);

      final responseData = error.response?.data;
      String message =
          'Unable to create an account. Please try again or log in if you already have an account.';

      if (responseData is Map) {
        final backendMessage = responseData['error'];

        if (backendMessage is String && backendMessage.isNotEmpty) {
          message = backendMessage;
        }
      } else if (error.response == null) {
        message =
            'Could not connect to the server. Check your internet connection.';
      }

      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(message)));
    } catch (error) {
      if (!mounted) return;

      setState(() => _isLoading = false);

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Something went wrong. Please try again.'),
        ),
      );
    }
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
                                  validator: utils.validateName,
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
                                  validator: utils.validateEmail,
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
                                  validator: utils.validatePassword,
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
                                  onSubmitted: _submit,
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
                                SubmitButton(
                                  width: width,
                                  submit: _submit,
                                  label: "Create an account",
                                ),
                                const SizedBox(height: 14),
                                Secondary(
                                  width: width,
                                  currentMode: AuthMode.signup,
                                ),
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
