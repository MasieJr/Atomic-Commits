import 'package:atomic_commits/app/app.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('app starts on the welcome screen at the entry route', (
    tester,
  ) async {
    // The shipped router location: AppRoutes.welcome == '/'.
    await tester.pumpWidget(const AtomicCommitsApp());
    await tester.pumpAndSettle();

    expect(find.textContaining('Atomic', findRichText: true), findsWidgets);
    expect(find.textContaining('commits', findRichText: true), findsWidgets);
    expect(
      find.text('Commit. Claim. Complete.', findRichText: true),
      findsOneWidget,
    );

    expect(find.text('Sign up', findRichText: true), findsOneWidget);
    expect(find.text('Log in', findRichText: true), findsOneWidget);
  });
}
