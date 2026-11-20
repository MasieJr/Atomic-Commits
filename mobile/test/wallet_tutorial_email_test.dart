import 'package:atomic_commits/features/wallet/screens/wallet_tutorial_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('wallet tutorial requires the user to use their own inbox', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WalletCreateTutorialSheet(onOpenSite: () {}),
        ),
      ),
    );
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();

    expect(find.text('Use your own email'), findsOneWidget);
    expect(find.textContaining('email address you can access'), findsOneWidget);
    expect(find.textContaining('dummyinbox.com'), findsNothing);
    expect(find.byIcon(Icons.alternate_email), findsOneWidget);
  });
}
