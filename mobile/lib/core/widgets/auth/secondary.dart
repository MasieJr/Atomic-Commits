import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

enum AuthMode { login, signup }

class Secondary extends StatelessWidget {
  final double width;

  /// The current page mode where this widget is rendered.
  /// Defaults to [AuthMode.signup] (shows "Already with us? Log in").
  final AuthMode currentMode;

  const Secondary({
    super.key,
    required this.width,
    this.currentMode = AuthMode.signup,
  });

  @override
  Widget build(BuildContext context) {
    final utils = Utils();
    final secondarySize = utils.sized(width, 0.03, 11, 13);

    final isSignup = currentMode == AuthMode.signup;
    final promptText = isSignup ? 'Already with us?' : "Don't have an account?";
    final actionText = isSignup ? 'Log in' : 'Sign up';
    final targetRoute = isSignup ? AppRoutes.login : AppRoutes.signup;

    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 4,
      children: [
        Text(
          promptText,
          style: TextStyle(
            color: AppColours.secondary,
            fontSize: secondarySize,
            height: 1.6,
          ),
        ),
        TextButton(
          onPressed: () => context.go(targetRoute),
          style: TextButton.styleFrom(
            foregroundColor: AppColours.cobalt,
            minimumSize: const Size(64, 48),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
            textStyle: Theme.of(context).textTheme.labelLarge?.copyWith(
              fontSize: secondarySize,
              fontWeight: FontWeight.w800,
            ),
          ),
          child: Text(actionText),
        ),
      ],
    );
  }
}
