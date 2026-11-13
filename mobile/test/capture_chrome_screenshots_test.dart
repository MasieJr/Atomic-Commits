import 'dart:convert';
import 'dart:io';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_theme.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/data/auth_repository.dart';
import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:atomic_commits/features/merchant/screens/enter_code_screen.dart';
import 'package:atomic_commits/features/wallet/screens/wallet_screen.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

const _fontDir =
    r'C:\Users\Leeroy Chakanyuka\development\SDKs\flutter\bin\cache\artifacts\material_fonts';

Future<void> _loadFont(String fileName, String family) async {
  final bytes = await File('$_fontDir\\$fileName').readAsBytes();
  final data = ByteData.view(
    bytes.buffer,
    bytes.offsetInBytes,
    bytes.lengthInBytes,
  );
  final loader = FontLoader(family)..addFont(Future.value(data));
  await loader.load();
}

Future<void> _loadFonts() async {
  for (final file in [
    'roboto-regular.ttf',
    'roboto-medium.ttf',
    'roboto-bold.ttf',
  ]) {
    await _loadFont(file, 'Roboto');
  }
  await _loadFont('materialicons-regular.otf', 'MaterialIcons');
}

class _Users extends AuthController {
  _Users()
    : super(
        AuthRepository(
          authApi: AuthApi(ApiClient()),
          tokenStorage: TokenStorage(),
          apiClient: ApiClient(),
        ),
      );
  @override
  UserModel get user =>
      UserModel(id: 1, name: 'Alice', email: 'alice@example.test');
}

class _ChromeApi implements HttpClientAdapter {
  static const _wallet = <String, dynamic>{
    'address': r'$ilp.interledger-test.dev/alice',
    'assetCode': 'USD',
    'assetScale': 2,
    'isDefaultReceiving': true,
    'publicName': 'Alice',
  };

  static const _merchant = <String, dynamic>{
    'displayName': 'Alice',
    'status': 'ACTIVE',
    'walletAddress': r'$ilp.interledger-test.dev/alice',
  };

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    Map<String, dynamic> response;
    if (options.path == '/wallets' && options.method == 'GET') {
      response = {'wallets': [_wallet]};
    } else if (options.path == '/merchant' && options.method == 'GET') {
      response = {'merchant': _merchant};
    } else if (options.path == '/wallet' && options.method == 'GET') {
      response = {'wallet': null};
    } else if (options.path == '/payment-grants' && options.method == 'GET') {
      response = {'grants': <dynamic>[]};
    } else {
      throw StateError('Unexpected request: ${options.method} ${options.path}');
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

Future<void> _setup(WidgetTester tester) async {
  FlutterSecureStorage.setMockInitialValues({});
  final users = _Users();
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api'))
    ..httpClientAdapter = _ChromeApi();
  getIt.registerSingleton<ApiClient>(ApiClient(client: dio));
  getIt.registerSingleton<AuthController>(users);
  addTearDown(() async {
    await getIt.reset();
    users.dispose();
  });
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
  });
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

Future<void> _capture(String name) async {
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('../../docs/images/ui-chrome/$name.png'),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);

  testWidgets('chrome — merchant receive fields', (tester) async {
    await _setup(tester);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        home: const EnterCodeScreen(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Purchase amount (USD)'), findsOneWidget);
    expect(find.text('Customer payment code'), findsOneWidget);
    expect(find.text('Submit payment'), findsOneWidget);
    await _capture('receive-payment-fields');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('chrome — wallet connect dialog field', (tester) async {
    await _setup(tester);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        home: const WalletScreen(),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Connect an existing wallet'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);
    await _capture('wallet-connect-field');
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
