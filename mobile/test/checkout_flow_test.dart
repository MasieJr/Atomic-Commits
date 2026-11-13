import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/data/auth_repository.dart';
import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:atomic_commits/features/merchant/screens/enter_code_screen.dart';
import 'package:atomic_commits/features/payer/offline_profile.dart';
import 'package:atomic_commits/features/payer/screens/payer_home_screen.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qr_flutter/qr_flutter.dart';

class _User extends AuthController {
  _User()
    : super(
        AuthRepository(
          authApi: AuthApi(ApiClient()),
          tokenStorage: TokenStorage(),
          apiClient: ApiClient(),
        ),
      );
  @override
  UserModel get user =>
      const UserModel(id: 22, name: 'User B', email: 'b@example.test');
}

class _Backend implements HttpClientAdapter {
  _Backend(this.status);
  final String status;
  int requests = 0;
  Map<String, dynamic>? redemption;
  String? idempotencyKey;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests += 1;
    Map<String, dynamic> result;
    if (options.path == '/wallet') {
      result = {
        'wallet': {
          'address': 'https://ilp.interledger-test.dev/b',
          'assetCode': 'USD',
          'assetScale': 2,
        },
      };
    } else if (options.path == '/merchant') {
      expect(options.data, {'displayName': 'User B'});
      result = {'status': 'ACTIVE'};
    } else if (options.path == '/offline-redemptions') {
      redemption = Map<String, dynamic>.from(options.data as Map);
      idempotencyKey = options.headers['Idempotency-Key'] as String?;
      final amount = {'value': '1234', 'assetCode': 'USD', 'assetScale': 2};
      result = {
        'paymentId': 'payment-1',
        'status': status,
        'payerName': 'User A',
        'merchantName': 'User B',
        'merchantReceiveRequested': amount,
        if (status == 'SUCCEEDED') ...{
          'payerDebitPaid': amount,
          'merchantReceivePaid': amount,
          'providerIncomingRef': 'https://ilp.interledger-test.dev/incoming/1',
        },
      };
    } else {
      throw StateError('Unexpected API request');
    }
    return ResponseBody.fromString(
      jsonEncode(result),
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

  Future<_Backend> setup(String status) async {
    FlutterSecureStorage.setMockInitialValues({});
    final backend = _Backend(status);
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api'))
      ..httpClientAdapter = backend;
    getIt.registerSingleton<ApiClient>(ApiClient(client: dio));
    getIt.registerSingleton<AuthController>(_User());
    return backend;
  }

  testWidgets(
    'a saved device profile renders its code and QR without an API request',
    (tester) async {
      final backend = await setup('UNKNOWN');
      await const OfflineProfileStore().save(
        22,
        OfflineProfile(
          prefix: 'ABC234',
          secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          expiresAtEpochMs: DateTime.now()
              .add(const Duration(hours: 1))
              .millisecondsSinceEpoch,
        ),
      );
      await tester.pumpWidget(const MaterialApp(home: PayerHomeScreen()));
      await tester.pumpAndSettle();
      expect(find.byType(QrImageView), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is SelectableText &&
              RegExp(r'^ABC234-[0-9]{6}$').hasMatch(widget.data ?? ''),
        ),
        findsOneWidget,
      );
      expect(backend.requests, 0);
      await tester.pumpWidget(const SizedBox.shrink());
      await getIt.reset();
    },
  );

  for (final status in ['SUCCEEDED', 'UNKNOWN']) {
    testWidgets('merchant checkout handles a $status provider outcome', (
      tester,
    ) async {
      final backend = await setup(status);
      await tester.pumpWidget(const MaterialApp(home: EnterCodeScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Activate merchant checkout'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Purchase amount (USD)'),
        '12.34',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Customer payment code'),
        'ABC234-123456',
      );
      await tester.ensureVisible(find.text('Submit payment'));
      await tester.tap(find.text('Submit payment'));
      await tester.pumpAndSettle();
      expect(backend.redemption?['merchantReceive'], {
        'value': '1234',
        'assetCode': 'USD',
        'assetScale': 2,
      });
      expect(backend.redemption?['paymentCode'], 'ABC234-123456');
      expect(backend.idempotencyKey, matches(RegExp(r'^[a-f0-9]{32}$')));
      expect(
        find.text('Payment confirmed'),
        status == 'SUCCEEDED' ? findsOneWidget : findsNothing,
      );
      if (status == 'UNKNOWN') {
        expect(find.textContaining('not confirmed'), findsOneWidget);
        expect(find.text('Submit payment'), findsNothing);
      }
      await tester.pumpWidget(const SizedBox.shrink());
      await getIt.reset();
    });
  }
}
