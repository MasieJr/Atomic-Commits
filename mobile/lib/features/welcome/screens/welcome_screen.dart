import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  static const _paper = Color(0xFFF9EFDF);
  static const _ink = Color(0xFF071B36);
  static const _cobalt = Color(0xFF0C42C9);

  @override
  Widget build(BuildContext context) {
    final safePadding = MediaQuery.paddingOf(context);

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: _paper,
      ),
      child: Scaffold(
        backgroundColor: _paper,
        body: LayoutBuilder(
          builder: (context, constraints) {
            final width = math.min(constraints.maxWidth, 600.0);
            // Keep the artwork's portrait composition on short/landscape screens.
            // Those screens can scroll instead of shrinking the text or buttons.
            final artworkHeight = math.max(constraints.maxHeight, width * 1.8);
            final horizontalPadding = math.max(24.0, width * 0.07);
            final bottomPadding = math.max(
              artworkHeight * 0.03,
              safePadding.bottom + 16,
            );
            final buttonHeight = (artworkHeight * 0.0615).clamp(48.0, 54.0);
            final buttonFontSize = (width * 0.039).clamp(14.0, 17.0);
            final buttonTextStyle = Theme.of(context).textTheme.labelLarge
                ?.copyWith(
                  fontSize: buttonFontSize,
                  fontWeight: FontWeight.w700,
                );
            final buttonShape = RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            );

            return Align(
              alignment: Alignment.topCenter,
              child: SizedBox(
                width: width,
                child: SingleChildScrollView(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(minHeight: artworkHeight),
                    child: IntrinsicHeight(
                      child: Stack(
                        children: [
                          Positioned(
                            top: 0,
                            left: 0,
                            right: 0,
                            height: artworkHeight,
                            child: Image.asset(
                              'assets/images/welcome-background.png',
                              fit: BoxFit.cover,
                              excludeFromSemantics: true,
                            ),
                          ),
                          Padding(
                            padding: EdgeInsets.fromLTRB(
                              horizontalPadding + safePadding.left,
                              0,
                              horizontalPadding + safePadding.right,
                              bottomPadding,
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                SizedBox(height: artworkHeight * 0.365),
                                _WelcomeBrand(width: width),
                                SizedBox(
                                  height: (artworkHeight * 0.035).clamp(16, 32),
                                ),
                                Text(
                                  'Commit. Claim. Complete.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(
                                    color: _ink,
                                    fontSize: (width * 0.05).clamp(16, 21),
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: -0.6,
                                    height: 1.3,
                                  ),
                                ),
                                const SizedBox(height: 32),
                                const Spacer(),
                                ElevatedButton(
                                  onPressed: () =>
                                      _showNextStep(context, 'Sign up'),
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: _cobalt,
                                    foregroundColor: Colors.white,
                                    minimumSize: Size(
                                      double.infinity,
                                      buttonHeight,
                                    ),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 24,
                                      vertical: 12,
                                    ),
                                    elevation: 2,
                                    shadowColor: _cobalt.withValues(alpha: 0.2),
                                    shape: buttonShape,
                                    textStyle: buttonTextStyle,
                                  ),
                                  child: const Text('Sign up'),
                                ),
                                SizedBox(
                                  height: (artworkHeight * 0.011).clamp(8, 11),
                                ),
                                OutlinedButton(
                                  onPressed: () =>
                                      _showNextStep(context, 'Log in'),
                                  style: OutlinedButton.styleFrom(
                                    backgroundColor: const Color(0xFFFFFBF5),
                                    foregroundColor: _ink,
                                    minimumSize: Size(
                                      double.infinity,
                                      buttonHeight,
                                    ),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 24,
                                      vertical: 12,
                                    ),
                                    side: const BorderSide(
                                      color: Color(0xFFD9CFC0),
                                    ),
                                    shape: buttonShape,
                                    textStyle: buttonTextStyle,
                                  ),
                                  child: const Text('Log in'),
                                ),
                              ],
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
    );
  }

  void _showNextStep(BuildContext context, String action) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text('$action is coming soon.')));
  }
}

class _WelcomeBrand extends StatelessWidget {
  const _WelcomeBrand({required this.width});

  final double width;

  @override
  Widget build(BuildContext context) {
    final nameSize = (width * 0.23).clamp(52.0, 98.0);
    final suffixSize = (width * 0.041).clamp(12.0, 18.0);

    return Semantics(
      header: true,
      label: 'Atomic Commits',
      excludeSemantics: true,
      child: Column(
        children: [
          // This is a typographic logo. Only the logo keeps a fixed text scale;
          // the tagline and actions respect the user's accessibility settings.
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              'Atomic',
              textScaler: TextScaler.noScaling,
              style: TextStyle(
                color: WelcomeScreen._ink,
                fontFamily: 'Georgia',
                fontFamilyFallback: const [
                  'Noto Serif',
                  'Times New Roman',
                  'serif',
                ],
                fontSize: nameSize,
                fontWeight: FontWeight.w700,
                letterSpacing: -nameSize * 0.076,
                height: 0.91,
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'commits',
            textScaler: TextScaler.noScaling,
            style: TextStyle(
              color: WelcomeScreen._ink,
              fontSize: suffixSize,
              fontWeight: FontWeight.w800,
              letterSpacing: suffixSize * 0.32,
              height: 1.2,
            ),
          ),
        ],
      ),
    );
  }
}
