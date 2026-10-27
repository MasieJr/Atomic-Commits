import 'package:atomic_commits/app/theme/app_theme.dart';
import 'package:atomic_commits/features/welcome/screens/welcome_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _pumpWelcome(
  WidgetTester tester, {
  Size size = const Size(360, 640),
  double textScale = 1,
  EdgeInsets insets = EdgeInsets.zero,
}) async {
  tester.view
    ..devicePixelRatio = 2
    ..physicalSize = size * 2
    ..padding = FakeViewPadding(
      left: insets.left * 2,
      top: insets.top * 2,
      right: insets.right * 2,
      bottom: insets.bottom * 2,
    );
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view
      ..resetPhysicalSize()
      ..resetDevicePixelRatio()
      ..resetPadding();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });

  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light, home: const WelcomeScreen()),
  );
  await tester.pumpAndSettle();
}

Finder _action(String label) => find.ancestor(
  of: find.text(label),
  matching: find.byWidgetPredicate((widget) => widget is ButtonStyleButton),
);

void main() {
  final viewports = [
    (size: const Size(320, 568), insets: EdgeInsets.zero, textScale: 1.0),
    (size: const Size(360, 640), insets: EdgeInsets.zero, textScale: 1.0),
    (
      size: const Size(390, 844),
      insets: const EdgeInsets.only(top: 47, bottom: 34),
      textScale: 1.0,
    ),
    (
      size: const Size(430, 932),
      insets: const EdgeInsets.only(top: 59, bottom: 34),
      textScale: 1.0,
    ),
    (
      size: const Size(844, 390),
      insets: const EdgeInsets.fromLTRB(47, 0, 47, 21),
      textScale: 1.0,
    ),
    (size: const Size(360, 640), insets: EdgeInsets.zero, textScale: 2.0),
    (
      size: const Size(320, 568),
      insets: const EdgeInsets.only(top: 24, bottom: 24),
      textScale: 3.0,
    ),
  ];

  for (final viewport in viewports) {
    testWidgets(
      'welcome fits ${viewport.size} at ${viewport.textScale}x text with reachable actions',
      (tester) async {
        await _pumpWelcome(
          tester,
          size: viewport.size,
          insets: viewport.insets,
          textScale: viewport.textScale,
        );

        expect(tester.takeException(), isNull);
        final brand = tester.getRect(find.text('commits'));
        final tagline = tester.getRect(find.text('Join the colony.'));
        expect(brand.bottom, lessThan(tagline.top));
        expect(
          tagline.bottom,
          lessThan(tester.getRect(_action('Sign up')).top),
        );
        expect(
          tester.getRect(_action('Sign up')).bottom,
          lessThan(tester.getRect(_action('Log in')).top),
        );

        for (final label in ['Sign up', 'Log in']) {
          final action = _action(label);
          await tester.ensureVisible(action);
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull);
          expect(action.hitTestable(), findsOneWidget);
          final bounds = tester.getRect(action);
          expect(bounds.height, greaterThanOrEqualTo(48));
          expect(bounds.width, greaterThanOrEqualTo(48));
          expect(bounds.left, greaterThanOrEqualTo(viewport.insets.left));
          expect(bounds.top, greaterThanOrEqualTo(viewport.insets.top));
          expect(
            bounds.right,
            lessThanOrEqualTo(viewport.size.width - viewport.insets.right),
          );
          expect(
            bounds.bottom,
            lessThanOrEqualTo(viewport.size.height - viewport.insets.bottom),
          );
        }
      },
    );
  }

  testWidgets('Log in gives feedback while its screen is pending', (
    tester,
  ) async {
    await _pumpWelcome(tester);
    await tester.tap(_action('Log in'));
    await tester.pumpAndSettle();

    expect(find.text('Log in is coming soon.'), findsOneWidget);
  });

  testWidgets('welcome artwork is included in the app bundle', (tester) async {
    final data = await rootBundle.load('assets/images/welcome-background.png');
    expect(data.lengthInBytes, greaterThan(0));
  });
}
