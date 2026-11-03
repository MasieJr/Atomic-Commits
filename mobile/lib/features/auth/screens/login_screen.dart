import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/core/widgets/auth/art.dart';
import 'package:atomic_commits/core/widgets/auth/custom_text_field.dart';
import 'package:atomic_commits/core/widgets/auth/header.dart';
import 'package:atomic_commits/core/widgets/auth/secondary.dart';
import 'package:atomic_commits/core/widgets/auth/signup_texture.dart';
import 'package:atomic_commits/core/widgets/auth/submit_button.dart';
import 'package:atomic_commits/core/widgets/auth/top_line.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/data/auth_repository.dart';
import 'package:atomic_commits/features/auth/screens/temp_dialog.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:go_router/go_router.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final Utils utils = Utils();
  final _formKey = GlobalKey<FormState>();

  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();

  final _emailFocus = FocusNode();
  final _passwordFocus = FocusNode();

  final ApiClient _apiClient = ApiClient();

  late final AuthRepository _authRepository = AuthRepository(
    authApi: AuthApi(_apiClient),
    tokenStorage: TokenStorage(),
    apiClient: _apiClient,
  );

  bool _validatingLive = false;
  bool _obscurePassword = true;
  bool _isLoading = false;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  List<({FocusNode node, String? Function() validate})> _fieldEntries() => [
    (
      node: _emailFocus,
      validate: () => utils.validateEmail(_emailController.text),
    ),
    (
      node: _passwordFocus,
      validate: () => _passwordController.text.isEmpty
          ? 'Please enter your password'
          : null,
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
      final user = await _authRepository.login(
        email: _emailController.text.trim(),
        password: _passwordController.text,
      );

      if (!mounted) return;

      TextInput.finishAutofillContext();

      setState(() => _isLoading = false);

      // temp Must create a home page
      showTempDialog(context: context, user: user);
    } on DioException catch (error) {
      if (!mounted) return;

      setState(() => _isLoading = false);

      final responseData = error.response?.data;
      String message = 'Unable to log in. Please try again.';

      if (responseData is Map) {
        final backendMessage = responseData['message'];

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
                                  inputKey: const ValueKey('login-email'),
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
                                  inputKey: const ValueKey('login-password'),
                                  label: 'Password',
                                  hint: 'Your password',
                                  icon: Icons.lock_outline,
                                  controller: _passwordController,
                                  focusNode: _passwordFocus,
                                  autofillHints: const [AutofillHints.password],
                                  textInputAction: TextInputAction.done,
                                  nextFocus: null,
                                  obscure: _obscurePassword,
                                  toggleTooltip: _obscurePassword
                                      ? 'Show password'
                                      : 'Hide password',
                                  onToggle: () => setState(
                                    () => _obscurePassword = !_obscurePassword,
                                  ),
                                  validator: (value) =>
                                      value == null || value.isEmpty
                                      ? 'Please enter your password'
                                      : null,
                                ),

                                const SizedBox(height: 28),

                                if (_isLoading)
                                  const SizedBox(
                                    height: 50,
                                    child: Center(
                                      child: CircularProgressIndicator(),
                                    ),
                                  )
                                else
                                  SubmitButton(
                                    width: width,
                                    submit: _submit,
                                    label: 'Login',
                                  ),

                                const SizedBox(height: 14),

                                Secondary(
                                  width: width,
                                  currentMode: AuthMode.login,
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
