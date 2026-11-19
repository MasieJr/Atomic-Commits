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
import 'package:atomic_commits/features/wallet/screens/wallet_tutorial_sheet.dart';
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
  static const _wallet = <String, dynamic>{
    'address': r'$ilp.interledger-test.dev/alice',
    'assetCode': 'USD',
    'assetScale': 2,
    'publicName': 'Alice',
  };

  bool connected = false;
  String approvalStatus = 'AWAITING_APPROVAL';

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    Map<String, dynamic> response;
    if (options.path == '/wallet' && options.method == 'GET') {
      response = {'wallet': connected ? _wallet : null};
    } else if (options.path == '/wallets' && options.method == 'GET') {
      response = {'wallets': connected ? [_wallet] : <dynamic>[]};
    } else if (options.path == '/payment-grants' && options.method == 'GET') {
      response = {'grants': <dynamic>[]};
    } else if (options.path == '/wallets/approvals' &&
        options.method == 'POST') {
      response = {
        'approvalId': 'tutorial-approval',
        'authorizationUrl': 'https://auth.interledger-test.dev/approve',
      };
    } else if (options.path == '/wallet/approvals/tutorial-approval') {
      response = {'status': approvalStatus};
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

Future<_TutorialApi> _setup(WidgetTester tester) async {
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
  return api;
}

Future<void> _capture(String name) async {
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('goldens/wallet_tutorial/$name.png'),
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

  testWidgets('wallet tutorial — empty state', (tester) async {
    await _setup(tester);
    await _pumpWallet(tester);
    expect(find.text('Set up your wallet'), findsOneWidget);
    expect(find.text('Create a new wallet'), findsOneWidget);
    expect(find.text('Connect an existing wallet'), findsOneWidget);
    await _capture('01-wallet-empty');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('wallet tutorial — connect dialog', (tester) async {
    await _setup(tester);
    await _pumpWallet(tester);
    await _warmAssets(tester, [
      'assets/images/wallet_tutorial/wallet-address.png',
      'assets/images/wallet_tutorial/dashboard-account.png',
      'assets/images/wallet_tutorial/wallet-address-list.png',
    ]);
    await tester.tap(find.text('Connect an existing wallet'));
    await tester.pumpAndSettle();
    expect(find.text('Open your account'), findsOneWidget);
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Copy your address'), findsOneWidget);
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField),
      r'$ilp.interledger-test.dev/alice',
    );
    await _capture('02-connect-dialog');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('wallet tutorial — approval pending', (tester) async {
    await _setup(tester);
    await _pumpWallet(tester);
    await _warmAssets(tester, [
      'assets/images/wallet_tutorial/wallet-address.png',
      'assets/images/wallet_tutorial/dashboard-account.png',
      'assets/images/wallet_tutorial/wallet-address-list.png',
    ]);
    await tester.tap(find.text('Connect an existing wallet'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField),
      r'$ilp.interledger-test.dev/alice',
    );
    await tester.tap(find.text('Verify ownership'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Complete approval with the provider, then return and refresh.',
      ),
      findsOneWidget,
    );
    await _capture('03-approval-pending');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('wallet tutorial — verified wallet', (tester) async {
    final api = await _setup(tester);
    api.connected = true;
    await _pumpWallet(tester);
    expect(find.text('Alice · USD'), findsOneWidget);
    expect(find.text('Authorize spending'), findsOneWidget);
    await _capture('04-wallet-verified');
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('wallet tutorial — create account sheet', (tester) async {
    await _setup(tester);
    await _pumpWallet(tester);
    await _warmAssets(tester, [
      'assets/images/wallet_tutorial/signup-fields.png',
      'assets/images/wallet_tutorial/signup-filled.png',
      'assets/images/wallet_tutorial/dashboard-account.png',
      'assets/images/wallet_tutorial/wallet-address-list.png',
    ]);
    await tester.tap(find.text('Create a new wallet'));
    await tester.pumpAndSettle();
    expect(find.text('Navigate and fill in'), findsOneWidget);
    await _capture('05-create-tutorial');
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Use the tutorial email'), findsOneWidget);
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Open your account'), findsOneWidget);
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Confirm and verify'), findsOneWidget);
    await tester.tap(find.text('Next'));
    await tester.pumpAndSettle();
    expect(find.text('Copy your address'), findsOneWidget);
    await tester.tap(find.text('Open sign-up page'));
    await tester.pumpAndSettle();
    expect(find.byType(WalletCreateTutorialSheet), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
