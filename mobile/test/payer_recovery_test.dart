import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/data/auth_repository.dart';
import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:atomic_commits/features/payer/screens/payer_home_screen.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

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
      const UserModel(id: 1, name: 'User A', email: 'a@example.test');
}

class _DeviceApi implements HttpClientAdapter {
  bool revoked = false;
  bool timeoutEnrollment = true;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    Map<String, dynamic> response;
    if (options.path == '/payment-grants') {
      response = {
        'grants': [
          {
            'authorizationId': 'grant-1',
            'payerWalletAddress': 'https://ilp.interledger-test.dev/a',
            'status': 'ACTIVE',
            'authoritySource': 'PROVIDER',
            'validUntil': DateTime.now()
                .add(const Duration(hours: 1))
                .toIso8601String(),
            'remaining': {'value': '1000', 'assetCode': 'ZAR', 'assetScale': 2},
            'perPaymentMaxDebit': {
              'value': '500',
              'assetCode': 'ZAR',
              'assetScale': 2,
            },
          },
        ],
      };
    } else if (options.path == '/devices/totp/enroll') {
      if (timeoutEnrollment) {
        throw DioException(
          requestOptions: options,
          type: DioExceptionType.receiveTimeout,
        );
      }
      response = {
        'version': 1,
        'prefix': 'ABC234',
        'secret': 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
        'algorithm': 'SHA1',
        'digits': 6,
        'periodSeconds': 30,
        'expiresAtEpochMs': DateTime.now()
            .add(const Duration(hours: 1))
            .millisecondsSinceEpoch,
        'revoked': false,
      };
    } else if (options.path == '/devices/totp') {
      response = {
        'devices': [
          {
            'prefix': 'ABC234',
            'deviceName': 'Atomic mobile',
            'status': 'ACTIVE',
            'grantStatus': 'ACTIVE',
          },
        ],
      };
    } else if (options.path == '/devices/totp/ABC234/revoke') {
      revoked = true;
      response = {'status': 'REVOKED'};
    } else {
      throw StateError('Unexpected device API request.');
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
    'a lost enrollment response can be checked and revoked before retrying',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final backend = _DeviceApi();
      final user = _User();
      final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api'))
        ..httpClientAdapter = backend;
      getIt.registerSingleton<ApiClient>(ApiClient(client: dio));
      getIt.registerSingleton<AuthController>(user);
      addTearDown(() async {
        await getIt.reset();
        user.dispose();
      });
      await tester.pumpWidget(const MaterialApp(home: PayerHomeScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Enroll this device'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Maximum ZAR 5.00 per payment'),
        findsOneWidget,
      );
      await tester.tap(
        find.textContaining('https://ilp.interledger-test.dev/a'),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Enrollment may already exist'),
        findsOneWidget,
      );
      await tester.tap(find.text('Check registered devices'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Atomic mobile'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
      await tester.pumpAndSettle();
      expect(backend.revoked, isTrue);
      expect(find.text('Device ABC234 revoked.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('the payment code shows the selected permission limit', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({});
    final backend = _DeviceApi()..timeoutEnrollment = false;
    final user = _User();
    final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api'))
      ..httpClientAdapter = backend;
    getIt.registerSingleton<ApiClient>(ApiClient(client: dio));
    getIt.registerSingleton<AuthController>(user);
    addTearDown(() async {
      await getIt.reset();
      user.dispose();
    });
    await tester.pumpWidget(const MaterialApp(home: PayerHomeScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Enroll this device'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Maximum ZAR 5.00 per payment'));
    await tester.pumpAndSettle();
    expect(
      find.text('Device limit at enrollment: ZAR 5.00 per payment'),
      findsOneWidget,
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
