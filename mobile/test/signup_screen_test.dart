import 'package:atomic_commits/app/theme/app_theme.dart';
import 'package:atomic_commits/features/auth/screens/signup_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

const _previewMessage = 'Sign-up preview only — no account has been created.';
const _fieldKeys = [
  'signup-name',
  'signup-email',
  'signup-password',
  'signup-password-confirm',
];

Finder _field(String key) => find.byKey(ValueKey(key));
Finder _submitButton() => find.ancestor(
  of: find.text('Create account'),
  matching: find.byWidgetPredicate((widget) => widget is ButtonStyleButton),
);

EditableText _editable(WidgetTester tester, String key) =>
    tester.widget<EditableText>(
      find.descendant(of: _field(key), matching: find.byType(EditableText)),
    );

Future<void> _pumpSignup(
  WidgetTester tester, {
  Size size = const Size(390, 844),
  double textScale = 1,
  EdgeInsets padding = EdgeInsets.zero,
  double keyboardHeight = 0,
}) async {
  tester.view
    ..devicePixelRatio = 2
    ..physicalSize = size * 2
    ..padding = FakeViewPadding(
      left: padding.left * 2,
      top: padding.top * 2,
      right: padding.right * 2,
      bottom: padding.bottom * 2,
    )
    ..viewInsets = FakeViewPadding(bottom: keyboardHeight * 2);
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(() {
    tester.view
      ..resetPhysicalSize()
      ..resetDevicePixelRatio()
      ..resetPadding()
      ..resetViewInsets();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });
  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light, home: const SignupScreen()),
  );
  await tester.pumpAndSettle();
}

Future<void> _enter(WidgetTester tester, String key, String value) async {
  await tester.ensureVisible(_field(key));
  await tester.pumpAndSettle();
  await tester.enterText(_field(key), value);
  await tester.pump();
}

Future<void> _fillValidForm(WidgetTester tester) async {
  await _enter(tester, 'signup-name', 'Nomsa');
  await _enter(tester, 'signup-email', 'nomsa@example.com');
  await _enter(tester, 'signup-password', 'sample-password');
  await _enter(tester, 'signup-password-confirm', 'sample-password');
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  expect(finder.hitTestable(), findsOneWidget);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'required errors appear on submit and clear as details are fixed',
    (tester) async {
      await _pumpSignup(tester);
      expect(find.text('Enter your full name.'), findsNothing);
      await _enter(tester, 'signup-email', 'invalid');
      expect(find.text('Enter a valid email address.'), findsNothing);
      await _enter(tester, 'signup-email', '');

      await _tap(tester, _submitButton());
      for (final message in [
        'Enter your full name.',
        'Enter your email address.',
        'Enter a password.',
        'Confirm your password.',
      ]) {
        expect(find.text(message), findsOneWidget);
      }
      expect(find.text(_previewMessage), findsNothing);
      expect(_editable(tester, 'signup-name').focusNode.hasFocus, isTrue);

      await _fillValidForm(tester);
      await _tap(tester, _submitButton());
      expect(find.text(_previewMessage), findsOneWidget);
      expect(find.text('Enter your full name.'), findsNothing);
      expect(find.text('Passwords do not match.'), findsNothing);
      expect(find.byType(SignupScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final invalid in [
    ('signup-name', '   ', 'Enter your full name.'),
    ('signup-email', '   ', 'Enter your email address.'),
    ('signup-email', 'not-an-email', 'Enter a valid email address.'),
    ('signup-password', 'short', 'Use at least 8 characters.'),
    (
      'signup-password-confirm',
      'different-password',
      'Passwords do not match.',
    ),
  ]) {
    testWidgets('rejects ${invalid.$1} with ${invalid.$3}', (tester) async {
      await _pumpSignup(tester, size: const Size(320, 568));
      await _fillValidForm(tester);
      await _enter(tester, invalid.$1, invalid.$2);
      await _tap(tester, _submitButton());

      expect(find.text(invalid.$3), findsOneWidget);
      expect(find.text(_previewMessage), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('password visibility is independent and retains both values', (
    tester,
  ) async {
    await _pumpSignup(tester);
    await _fillValidForm(tester);
    expect(_editable(tester, 'signup-password').obscureText, isTrue);
    expect(_editable(tester, 'signup-password-confirm').obscureText, isTrue);

    await _tap(tester, find.byTooltip('Show password'));
    expect(_editable(tester, 'signup-password').obscureText, isFalse);
    expect(_editable(tester, 'signup-password-confirm').obscureText, isTrue);
    await _tap(tester, find.byTooltip('Show confirm password'));
    expect(_editable(tester, 'signup-password-confirm').obscureText, isFalse);
    await _tap(tester, find.byTooltip('Hide password'));
    expect(_editable(tester, 'signup-password').obscureText, isTrue);
    expect(_editable(tester, 'signup-password-confirm').obscureText, isFalse);
    for (final key in _fieldKeys.skip(2)) {
      expect(_editable(tester, key).controller.text, 'sample-password');
    }
  });

  testWidgets(
    'changing a previously matched password requires confirmation again',
    (tester) async {
      await _pumpSignup(tester);
      await _fillValidForm(tester);
      await _tap(tester, _submitButton());
      expect(find.text(_previewMessage), findsOneWidget);

      await _enter(tester, 'signup-password', 'changed-password');
      await _tap(tester, _submitButton());
      expect(find.text('Passwords do not match.'), findsOneWidget);
      expect(find.text(_previewMessage), findsNothing);
    },
  );

  testWidgets(
    'accepts Unicode names, preserves password spaces, and submits with Done',
    (tester) async {
      await _pumpSignup(tester);
      await _fillValidForm(tester);
      await _enter(tester, 'signup-name', 'Ölaf');
      await _enter(tester, 'signup-password', ' padded password ');
      await _enter(tester, 'signup-password-confirm', ' padded password ');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(find.text(_previewMessage), findsOneWidget);
      expect(
        _editable(tester, 'signup-password').controller.text,
        ' padded password ',
      );
      expect(
        _editable(tester, 'signup-password-confirm').focusNode.hasFocus,
        isFalse,
      );
    },
  );

  for (final viewport in [
    (
      size: const Size(320, 568),
      padding: EdgeInsets.zero,
      scale: 1.0,
      keyboard: 0.0,
    ),
    (
      size: const Size(390, 844),
      padding: const EdgeInsets.only(top: 47, bottom: 34),
      scale: 1.0,
      keyboard: 0.0,
    ),
    (
      size: const Size(430, 932),
      padding: const EdgeInsets.only(top: 59, bottom: 34),
      scale: 1.0,
      keyboard: 0.0,
    ),
    (
      size: const Size(844, 390),
      padding: const EdgeInsets.fromLTRB(47, 0, 47, 21),
      scale: 1.0,
      keyboard: 0.0,
    ),
    (
      size: const Size(360, 640),
      padding: EdgeInsets.zero,
      scale: 2.0,
      keyboard: 0.0,
    ),
    (
      size: const Size(320, 568),
      padding: const EdgeInsets.only(top: 24, bottom: 24),
      scale: 3.0,
      keyboard: 0.0,
    ),
    (
      size: const Size(320, 568),
      padding: EdgeInsets.zero,
      scale: 1.0,
      keyboard: 280.0,
    ),
    (
      size: const Size(844, 390),
      padding: EdgeInsets.zero,
      scale: 1.0,
      keyboard: 240.0,
    ),
  ]) {
    testWidgets(
      'signup controls remain reachable at ${viewport.size}, ${viewport.scale}x text, ${viewport.keyboard}px keyboard',
      (tester) async {
        await _pumpSignup(
          tester,
          size: viewport.size,
          padding: viewport.padding,
          textScale: viewport.scale,
          keyboardHeight: viewport.keyboard,
        );
        expect(tester.takeException(), isNull);

        for (final control in [
          for (final key in _fieldKeys) _field(key),
          _submitButton(),
        ]) {
          await tester.ensureVisible(control);
          await tester.pumpAndSettle();
          expect(control.hitTestable(), findsOneWidget);
          final bounds = tester.getRect(control);
          expect(bounds.height, greaterThanOrEqualTo(48));
          expect(bounds.left, greaterThanOrEqualTo(viewport.padding.left));
          expect(
            bounds.right,
            lessThanOrEqualTo(viewport.size.width - viewport.padding.right),
          );
          expect(bounds.top, greaterThanOrEqualTo(viewport.padding.top));
          expect(
            bounds.bottom,
            lessThanOrEqualTo(
              viewport.size.height -
                  (viewport.keyboard > 0
                      ? viewport.keyboard
                      : viewport.padding.bottom) +
                  0.1,
            ),
          );
          expect(tester.takeException(), isNull);
        }
      },
    );
  }

  testWidgets('BACK returns to welcome when signup is opened directly', (
    tester,
  ) async {
    final router = GoRouter(
      initialLocation: '/signup',
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) =>
              const Scaffold(body: Text('Welcome destination')),
        ),
        GoRoute(
          path: '/signup',
          builder: (context, state) => const SignupScreen(),
        ),
      ],
    );
    addTearDown(router.dispose);
    await tester.pumpWidget(
      MaterialApp.router(theme: AppTheme.light, routerConfig: router),
    );
    await tester.pumpAndSettle();
    await _tap(tester, find.text('BACK'));
    expect(find.text('Welcome destination'), findsOneWidget);
    expect(find.byType(SignupScreen), findsNothing);
  });
}
