import 'dart:convert';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/data/auth_repository.dart';
import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:atomic_commits/features/wallet/screens/wallet_screen.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

class _Users extends AuthController {
  _Users()
    : super(
        AuthRepository(
          authApi: AuthApi(ApiClient()),
          tokenStorage: TokenStorage(),
          apiClient: ApiClient(),
        ),
      );
  int id = 1;
  @override
  UserModel get user =>
      UserModel(id: id, name: 'User $id', email: 'user$id@example.test');
}

class _WalletApi implements HttpClientAdapter {
  _WalletApi(this.users);
  final _Users users;
  bool verified = false;
  int starts = 0;
  int polls = 0;
  Map<String, dynamic>? grantRequest;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    Map<String, dynamic> response;
    if (options.path == '/wallet' && options.method == 'GET') {
      response = {
        'wallet': verified && users.id == 1
            ? {
                'address': 'https://ilp.interledger-test.dev/a',
                'assetCode': 'USD',
                'assetScale': 2,
                'publicName': 'Wallet A',
              }
            : null,
      };
    } else if (options.path == '/wallet/approvals' &&
        options.method == 'POST') {
      expect(options.data, {'walletAddress': r'$ilp.interledger-test.dev/a'});
      starts++;
      response = {
        'approvalId': 'approval-a',
        'authorizationUrl': 'https://auth.interledger-test.dev/approve',
      };
    } else if (options.path == '/wallet/approvals/approval-a') {
      polls++;
      response = {'status': verified ? 'VERIFIED' : 'AWAITING_APPROVAL'};
    } else if (options.path == '/payment-grants' && options.method == 'POST') {
      grantRequest = Map<String, dynamic>.from(options.data as Map);
      response = {
        'approvalId': 'grant-a',
        'authorizationUrl': 'https://auth.interledger-test.dev/approve',
      };
    } else if (options.path == '/payment-grants') {
      response = {'grants': []};
    } else {
      throw StateError('Unexpected wallet API request.');
    }
    return ResponseBody.fromString(
      jsonEncode(response),
      200,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'a pending wallet approval survives restart and stays scoped to its user',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final users = _Users();
      final backend = _WalletApi(users);
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api'))
        ..httpClientAdapter = backend;
      getIt.registerSingleton<ApiClient>(ApiClient(client: dio));
      getIt.registerSingleton<AuthController>(users);
      const channel = MethodChannel('plugins.flutter.io/url_launcher');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async => true);
      addTearDown(() async {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
        await getIt.reset();
        users.dispose();
      });

      await tester.pumpWidget(const MaterialApp(home: WalletScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Connect an existing wallet'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField),
        r'$ilp.interledger-test.dev/a',
      );
      await tester.tap(find.text('Verify ownership'));
      await tester.pumpAndSettle();
      expect(backend.starts, 1);

      await tester.pumpWidget(const SizedBox.shrink());
      users.id = 2;
      await tester.pumpWidget(const MaterialApp(home: WalletScreen()));
      await tester.pumpAndSettle();
      expect(backend.polls, 0);
      expect(
        find.text(
          'No verified wallet is connected. Create a Test Wallet account or connect an existing wallet.',
        ),
        findsOneWidget,
      );

      await tester.pumpWidget(const SizedBox.shrink());
      users.id = 1;
      backend.verified = true;
      await tester.pumpWidget(const MaterialApp(home: WalletScreen()));
      await tester.pumpAndSettle();
      expect(backend.polls, 1);
      expect(find.text('Verified wallet'), findsOneWidget);
      expect(find.text('Wallet A'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'spending approval sends reviewed exact limits for the verified wallet',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final users = _Users();
      final backend = _WalletApi(users)..verified = true;
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api'))
        ..httpClientAdapter = backend;
      getIt.registerSingleton<ApiClient>(ApiClient(client: dio));
      getIt.registerSingleton<AuthController>(users);
      const channel = MethodChannel('plugins.flutter.io/url_launcher');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async => true);
      addTearDown(() async {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
        await getIt.reset();
        users.dispose();
      });
      await tester.pumpWidget(const MaterialApp(home: WalletScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Authorize spending'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'Total allowance'),
        '12.34',
      );
      await tester.enterText(
        find.widgetWithText(TextField, 'Maximum per payment'),
        '2.50',
      );
      await tester.tap(find.text('Review'));
      await tester.pumpAndSettle();
      expect(find.textContaining('12.34 USD'), findsOneWidget);
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
      expect(backend.grantRequest, {
        'cumulativeCap': '1234',
        'perPaymentMaxDebit': '250',
      });
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
