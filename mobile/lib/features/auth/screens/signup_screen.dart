import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/widgets/auth/art.dart';
import 'package:atomic_commits/core/widgets/auth/header.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

import 'package:atomic_commits/app/router.dart';

/// Sign-up screen. Pure UI mock: no backend, no credential storage, no
/// account creation. Matches the signup.html art direction (paper gradient,
/// dotted texture, warm orbs) without any device frame.
class SignupScreen extends StatefulWidget {
  const SignupScreen({super.key});

  static const _paperTop = Color(0xFFFFF7EA);
  static const _paperMid = Color(0xFFFAECDA);
  static const _paperBottom = Color(0xFFF5E5CD);
  static const _ink = Color(0xFF071B36);
  static const _orange = Color(0xFFFF6B0B);
  static const _cobalt = Color(0xFF0C42C9);
  static const _fieldBorder = Color(0xFFDACDBC);
  static const _fieldFocus = Color(0xFF3468E2);
  static const _fieldFill = Color(0xFFFFFCF7);
  static const _fieldText = Color(0xFF0C1F3D);
  static const _fieldHint = Color(0xFF9BA3B0);
  static const _fieldIcon = Color(0xFF6D7D91);
  static const _eyeIcon = Color(0xFF69778A);
  static const _topline = Color(0xFF4C5C72);
  static const _eyebrow = Color(0xFFA34C0F);
  static const _tagline = Color(0xFF6D7071);
  static const _subtle = Color(0xFF5F6B7C);
  static const _labelInk = Color(0xFF223650);
  static const _secondary = Color(0xFF647084);
  static const _footnote = Color(0xFF81796D);
  static const _error = Color(0xFFB3392F);

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

  String? _validateName(String raw) {
    if (raw.trim().isEmpty) return 'Enter your full name.';
    return null;
  }

  String? _validateEmail(String raw) {
    final value = raw.trim();
    if (value.isEmpty) return 'Enter your email address.';
    // Deliberately simple, offline-only shape check; deliverability is the
    // backend's job once this preview becomes a real sign-up flow.
    final pattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
    if (!pattern.hasMatch(value)) return 'Enter a valid email address.';
    return null;
  }

  String? _validatePassword(String raw) {
    if (raw.isEmpty) return 'Enter a password.';
    if (raw.length < 8) return 'Use at least 8 characters.';
    return null;
  }

  String? _validateConfirm(String raw) {
    if (raw.isEmpty) return 'Confirm your password.';
    if (raw != _passwordController.text) return 'Passwords do not match.';
    return null;
  }

  // --- Actions ------------------------------------------------------------

  void _goBack() {
    if (context.canPop()) {
      context.pop();
    } else {
      // Direct-link resilience: the route may be opened without a caller
      // stacked on top, so route home instead of popping.
      context.go(AppRoutes.welcome);
    }
  }

  void _showLoginPlaceholder() {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Log in is coming soon.')));
  }

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
            const IgnorePointer(child: _SignupTexture()),
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
                                _buildTopline(width),
                                Art(),
                                const SizedBox(height: 16),
                                Header(width: width),
                                const SizedBox(height: 16),
                                _buildField(
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
                                _buildField(
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
                                _buildField(
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
                                _buildField(
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
                                _buildSubmitButton(width, context),
                                const SizedBox(height: 14),
                                _buildSecondary(width, context),
                                const SizedBox(height: 12),
                                Text(
                                  'Pay by code. Carry on.',
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(
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

  Widget _buildSubmitButton(double width, BuildContext context) {
    final buttonFontSize = _sized(width, 0.037, 13, 15);
    final buttonTextStyle = Theme.of(context).textTheme.labelLarge
        ?.copyWith(fontSize: buttonFontSize, fontWeight: FontWeight.w800);

    return ElevatedButton(
      onPressed: _submit,
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColours.cobalt,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(52),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
        elevation: 0,
        shadowColor: const Color(0x2B0941BA),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
        textStyle: buttonTextStyle,
      ),
      child: const Text('Create account'),
    );
  }

  Widget _buildSecondary(double width, BuildContext context) {
    final secondarySize = _sized(width, 0.03, 11, 13);

    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 4,
      children: [
        Text(
          'Already with us?',
          style: TextStyle(
            color: AppColours.secondary,
            fontSize: secondarySize,
            height: 1.6,
          ),
        ),
        TextButton(
          onPressed: _showLoginPlaceholder,
          style: TextButton.styleFrom(
            foregroundColor: AppColours.cobalt,
            minimumSize: const Size(64, 48),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
            textStyle: Theme.of(context).textTheme.labelLarge?.copyWith(
              fontSize: secondarySize,
              fontWeight: FontWeight.w800,
            ),
          ),
          child: const Text('Log in'),
        ),
      ],
    );
  }

  Widget _buildField({
    required double width,
    required Key inputKey,
    required String label,
    required String hint,
    required IconData icon,
    required TextEditingController controller,
    required FocusNode focusNode,
    required List<String> autofillHints,
    required TextInputAction textInputAction,
    required FocusNode? nextFocus,
    required String? Function(String) validator,
    TextInputType? keyboardType,
    TextCapitalization textCapitalization = TextCapitalization.none,
    bool obscure = false,
    String? toggleTooltip,
    VoidCallback? onToggle,
  }) {
    final labelSize = _sized(width, 0.031, 10, 12);
    final inputSize = _sized(width, 0.0345, 12, 14);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 1, bottom: 4),
          child: ExcludeSemantics(
            // The editable control announces the label below.
            child: Text(
              label,
              style: TextStyle(
                color: AppColours.labelInk,
                fontSize: labelSize,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.012 * labelSize,
              ),
            ),
          ),
        ),
        Semantics(
          label: label,
          child: TextFormField(
            key: inputKey,
            controller: controller,
            focusNode: focusNode,
            validator: (value) => validator(value ?? ''),
            obscureText: obscure,
            keyboardType: keyboardType ?? TextInputType.visiblePassword,
            autocorrect: keyboardType == TextInputType.name,
            enableSuggestions: keyboardType == TextInputType.name,
            textCapitalization: textCapitalization,
            textInputAction: textInputAction,
            autofillHints: autofillHints,
            style: TextStyle(
              color: AppColours.fieldText,
              fontSize: inputSize,
              fontWeight: FontWeight.w500,
            ),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: const TextStyle(
                color: AppColours.fieldHint,
                fontWeight: FontWeight.w400,
              ),
              errorStyle: const TextStyle(
                color: AppColours.error,
                fontSize: 11,
                height: 1.3,
              ),
              errorMaxLines: 3,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 8,
                vertical: 15,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(color: AppColours.fieldBorder),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(color: AppColours.fieldBorder),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(
                  color: AppColours.fieldFocus,
                  width: 1.5,
                ),
              ),
              errorBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(color: AppColours.error),
              ),
              focusedErrorBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(
                  color: AppColours.error,
                  width: 1.5,
                ),
              ),
              filled: true,
              fillColor: AppColours.fieldFill,
              prefixIcon: Padding(
                padding: const EdgeInsets.only(left: 14, right: 10),
                child: Icon(icon, size: 18, color: AppColours.fieldIcon),
              ),
              prefixIconConstraints: const BoxConstraints(
                minHeight: 48,
                minWidth: 42,
              ),
              suffixIcon: onToggle != null
                  ? IconButton(
                      tooltip: toggleTooltip,
                      onPressed: onToggle,
                      padding: const EdgeInsets.all(7),
                      constraints: const BoxConstraints(
                        minWidth: 48,
                        minHeight: 48,
                      ),
                      icon: Icon(
                        obscure
                            ? Icons.visibility_outlined
                            : Icons.visibility_off_outlined,
                        size: 20,
                        color: AppColours.eyeIcon,
                      ),
                    )
                  : null,
              suffixIconConstraints: onToggle != null
                  ? const BoxConstraints(minWidth: 48, minHeight: 48)
                  : null,
            ),
            onFieldSubmitted: (_) {
              if (nextFocus != null) {
                nextFocus.requestFocus();
              } else {
                _submit();
              }
            },
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Texture / warm accents (background decoration only)
// ---------------------------------------------------------------------------

class _SignupTexture extends StatelessWidget {
  const _SignupTexture();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Stack(
        children: [
          Positioned.fill(child: CustomPaint(painter: _SignupTexturePainter())),
          LayoutBuilder(
            builder: (context, constraints) {
              final w = constraints.maxWidth;
              final h = constraints.maxHeight;
              return Stack(
                children: [
                  Positioned(
                    top: h * 0.05,
                    right: -w * 0.28,
                    width: w * 0.68,
                    height: w * 0.68,
                    child: const DecoratedBox(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: RadialGradient(
                          colors: [
                            Color(0xBBFFD7A1),
                            Color(0x55FBA75E),
                            Colors.transparent,
                          ],
                          stops: [0, 0.36, 0.7],
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    top: constraints.maxHeight * 0.45,
                    left: -constraints.maxWidth * 0.6,
                    width: constraints.maxWidth * 1.1,
                    height: constraints.maxWidth * 1.1,
                    child: const DecoratedBox(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        gradient: RadialGradient(
                          colors: [Color(0x47FFC078), Colors.transparent],
                          stops: [0, 0.72],
                        ),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

class _SignupTexturePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final first = Paint()..color = const Color(0x1B9C6422);
    final second = Paint()..color = const Color(0x15A76C2A);

    void dots(double spacingX, double spacingY, Offset offset, Paint paint) {
      var y = offset.dy;
      while (y < size.height + spacingY) {
        var x = offset.dx;
        while (x < size.width + spacingX) {
          canvas.drawCircle(Offset(x, y), 0.7, paint);
          x += spacingX;
        }
        y += spacingY;
      }
    }

    dots(19, 21, Offset.zero, first);
    dots(29, 31, const Offset(11, 17), second);
  }

  @override
  bool shouldRepaint(_SignupTexturePainter oldDelegate) => false;
}
