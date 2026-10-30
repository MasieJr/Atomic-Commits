import 'package:atomic_commits/app/app.dart';
import 'package:atomic_commits/features/auth/screens/signup_screen.dart';
import 'package:atomic_commits/features/welcome/screens/welcome_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('welcome opens signup and BACK returns to welcome', (
    tester,
  ) async {
    // The shipped router location: AppRoutes.welcome == '/'.
    await tester.pumpWidget(const AtomicCommitsApp());
    await tester.pumpAndSettle();

    expect(find.textContaining('Atomic', findRichText: true), findsWidgets);
    expect(find.textContaining('commits', findRichText: true), findsWidgets);
    expect(find.text('Join the colony.', findRichText: true), findsOneWidget);

    expect(find.text('Sign up', findRichText: true), findsOneWidget);
    expect(find.text('Log in', findRichText: true), findsOneWidget);

    final signUp = find.widgetWithText(ElevatedButton, 'Sign up');
    await tester.ensureVisible(signUp);
    await tester.tap(signUp);
    await tester.pumpAndSettle();

    expect(find.byType(SignupScreen), findsOneWidget);
    expect(find.byType(TextFormField), findsNWidgets(4));
    await tester.tap(find.text('BACK'));
    await tester.pumpAndSettle();

    expect(find.byType(WelcomeScreen), findsOneWidget);
    expect(find.byType(SignupScreen), findsNothing);
  });
}
