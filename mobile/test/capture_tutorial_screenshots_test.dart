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

class _TutorialApi implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    Map<String, dynamic> response;
    if (options.path == '/wallet' && options.method == 'GET') {
      response = {'wallet': null};
    } else if (options.path == '/wallets' && options.method == 'GET') {
      response = {'wallets': <dynamic>[]};
    } else if (options.path == '/payment-grants' && options.method == 'GET') {
      response = {'grants': <dynamic>[]};
    } else if (options.path == '/wallets/approvals' &&
        options.method == 'POST') {
      response = {
        'approvalId': 'tutorial-approval',
        'authorizationUrl': 'https://auth.interledger-test.dev/approve',
      };
    } else if (options.path == '/wallet/approvals/tutorial-approval') {
      response = {'status': 'AWAITING_APPROVAL'};
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

Future<void> _pumpWallet(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      home: const WalletScreen(),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _setup(WidgetTester tester) async {
  FlutterSecureStorage.setMockInitialValues({});
  final users = _Users();
  final api = _TutorialApi();
  final dio = Dio(BaseOptions(baseUrl: 'https://api.example.test/api'))
    ..httpClientAdapter = api;
  getIt.registerSingleton<ApiClient>(ApiClient(client: dio));
  getIt.registerSingleton<AuthController>(users);
  const channel = MethodChannel('plugins.flutter.io/url_launcher');
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel, (call) async => true);
  addTearDown(() async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });
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

Future<void> _save(String name) async {
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('../../docs/images/wallet-tutorial/screenshots/$name.png'),
  );
}

Future<void> _warmAssets(WidgetTester tester, List<String> paths) async {
  final context = tester.element(find.byType(MaterialApp));
  await tester.runAsync(() async {
    for (final path in paths) {
      await precacheImage(AssetImage(path), context);
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(_loadFonts);

  testWidgets('capture all create-tutorial steps', (tester) async {
    await _setup(tester);
    await _pumpWallet(tester);
    await _warmAssets(tester, [
      'assets/images/wallet_tutorial/signup-fields.png',
      'assets/images/wallet_tutorial/dashboard-account.png',
      'assets/images/wallet_tutorial/wallet-address-list.png',
    ]);
    await tester.tap(find.text('Create a new wallet'));
    await tester.pumpAndSettle();
    expect(find.text('Navigate and fill in'), findsOneWidget);
    await _save('step-1-navigate-fill');

    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Use your own email'), findsOneWidget);
    expect(find.textContaining('email address you can access'), findsOneWidget);
    expect(find.textContaining('dummyinbox.com'), findsNothing);

    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Open your account'), findsOneWidget);
    await _save('step-3-open-account');

    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Confirm and verify'), findsOneWidget);
    await _save('step-4-confirm-verify');

    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Copy your address'), findsOneWidget);
    await _save('step-5-copy-address');

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('capture connect flow screenshots', (tester) async {
    await _setup(tester);
    await _pumpWallet(tester);
    await _warmAssets(tester, [
      'assets/images/wallet_tutorial/wallet-address.png',
      'assets/images/wallet_tutorial/dashboard-account.png',
      'assets/images/wallet_tutorial/wallet-address-list.png',
    ]);
    await _save('flow-1-empty-wallet');

    await tester.tap(find.text('Connect an existing wallet'));
    await tester.pumpAndSettle();
    expect(find.text('Open your account'), findsOneWidget);
    await _save('flow-2-connect-step-1');

    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Copy your address'), findsOneWidget);
    await _save('flow-3-connect-step-2');

    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField),
      r'$ilp.interledger-test.dev/alice',
    );
    await _save('flow-4-connect-dialog');

    await tester.tap(find.text('Verify ownership'));
    await tester.pumpAndSettle();
    await _save('flow-5-approval-pending');

    await tester.pumpWidget(const SizedBox.shrink());
  });
}
