import 'dart:convert';
import 'dart:async';
import 'dart:typed_data';

import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/network_errors.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/activity/data/payment_api.dart';
import 'package:atomic_commits/features/activity/data/payment_repository.dart';
import 'package:atomic_commits/features/activity/payment_controller.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/data/auth_repository.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

class _AuthServer implements HttpClientAdapter {
  bool offline = false;
  final users = <String, Map<String, dynamic>>{
    'a@example.test': {'id': 1, 'name': 'User A', 'email': 'a@example.test'},
  };
  final tokens = <String, String>{'token-a': 'a@example.test'};

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (offline) {
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      );
    }
    final Map<String, dynamic> response;
    var status = 200;
    if (options.path.endsWith('/auth/me')) {
      final authorization = options.headers['Authorization'];
      final token =
          authorization is String && authorization.startsWith('Bearer ')
          ? authorization.substring(7)
          : null;
      final email = tokens[token];
      if (email == null) {
        status = 401;
        response = {'error': 'Please log in first'};
      } else {
        response = {'user': users[email]};
      }
    } else {
      final body = Map<String, dynamic>.from(options.data as Map);
      final email = body['email'] as String;
      if (options.path.endsWith('/auth/register')) {
        users[email] = {'id': 2, 'name': body['name'], 'email': email};
        tokens['token-b'] = email;
      }
      final token = email == 'a@example.test' ? 'token-a' : 'token-b';
      response = {'message': 'ok', 'user': users[email], 'token': token};
    }
    return ResponseBody.fromString(
      jsonEncode(response),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _RefreshServer implements HttpClientAdapter {
  int refreshes = 0;
  int protectedRequests = 0;
  bool failRefresh = false;
  int refreshFailureStatus = 503;
  int? retryStatus;
  bool retryOffline = false;
  Completer<void>? gate;
  final revoked = <String>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    var status = 200;
    Map<String, dynamic> body = {};
    if (options.path.endsWith('/auth/login')) {
      body = {
        'message': 'ok',
        'user': {'id': 1, 'name': 'A', 'email': 'a@example.test'},
        'token': 'old',
        'refreshToken': 'refresh-old',
      };
    } else if (options.path.endsWith('/auth/refresh')) {
      refreshes++;
      if (gate != null) await gate!.future;
      if (failRefresh) {
        status = refreshFailureStatus;
      } else {
        body = {
          'user': {'id': 1},
          'token': 'new',
          'refreshToken': 'refresh-new',
        };
      }
    } else if (options.path.endsWith('/auth/logout')) {
      revoked.add((options.data as Map)['refreshToken'] as String);
    } else {
      protectedRequests++;
      if (options.headers['Authorization'] != 'Bearer new') {
        status = 401;
      } else if (retryOffline) {
        throw DioException(
          requestOptions: options,
          type: DioExceptionType.connectionError,
        );
      } else if (retryStatus != null) {
        status = retryStatus!;
      }
      body = {
        'user': {'id': 1, 'name': 'A', 'email': 'a@example.test'},
        'asPayer': [],
        'asMerchant': [],
        'code': 'conflict',
      };
    }
    return ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

AuthRepository _repository(_AuthServer server) {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000/api'))
    ..httpClientAdapter = server;
  final client = ApiClient(client: dio);
  return AuthRepository(
    authApi: AuthApi(client),
    tokenStorage: TokenStorage(),
    apiClient: client,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('concurrent expiry rotates once and survives restart', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _RefreshServer()..gate = Completer<void>();
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
      ..httpClientAdapter = server;
    final client = ApiClient(client: dio);
    final repository = AuthRepository(
      authApi: AuthApi(client),
      tokenStorage: TokenStorage(),
      apiClient: client,
    );
    await repository.login(email: 'a@example.test', password: 'password');
    final requests = [dio.get('/payments'), dio.get('/payments')];
    while (server.refreshes == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    server.gate!.complete();
    await Future.wait(requests);
    expect(server.refreshes, 1);
    final stored = await TokenStorage().getSession();
    expect(stored?.token, 'new');
    expect(stored?.refreshToken, 'refresh-new');
    final nextClient = ApiClient(
      client: Dio(BaseOptions(baseUrl: 'http://localhost/api'))
        ..httpClientAdapter = server,
    );
    final restarted = AuthRepository(
      authApi: AuthApi(nextClient),
      tokenStorage: TokenStorage(),
      apiClient: nextClient,
    );
    expect((await restarted.restoreSession())?.id, 1);
    await restarted.logout();
    expect(server.revoked, contains('refresh-new'));
  });

  test('transient refresh failure preserves cached session', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _RefreshServer()..failRefresh = true;
    final client = ApiClient(
      client: Dio(BaseOptions(baseUrl: 'http://localhost/api'))
        ..httpClientAdapter = server,
    );
    final repository = AuthRepository(
      authApi: AuthApi(client),
      tokenStorage: TokenStorage(),
      apiClient: client,
    );
    await repository.login(email: 'a@example.test', password: 'password');
    expect((await repository.restoreSession())?.id, 1);
    expect((await TokenStorage().getSession())?.refreshToken, 'refresh-old');
  });

  test(
    'refresh failure exposes its real 503 instead of the original 401',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final server = _RefreshServer()..failRefresh = true;
      final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
        ..httpClientAdapter = server;
      final client = ApiClient(client: dio);
      final repository = AuthRepository(
        authApi: AuthApi(client),
        tokenStorage: TokenStorage(),
        apiClient: client,
      );
      await repository.login(email: 'a@example.test', password: 'password');
      final error = await dio
          .get('/payments')
          .then<DioException>(
            (_) => throw StateError('expected failure'),
            onError: (Object error) => error as DioException,
          );
      expect(error, isA<RefreshFailure>());
      expect(error.response?.statusCode, 503);
      expect(isOfflineFailure(error), isTrue);
      expect((await TokenStorage().getSession())?.refreshToken, 'refresh-old');
    },
  );

  for (final status in [409, 500]) {
    test(
      'post-refresh $status response is propagated without losing the session',
      () async {
        FlutterSecureStorage.setMockInitialValues({});
        final server = _RefreshServer()..retryStatus = status;
        final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
          ..httpClientAdapter = server;
        final client = ApiClient(client: dio);
        final repository = AuthRepository(
          authApi: AuthApi(client),
          tokenStorage: TokenStorage(),
          apiClient: client,
        );
        await repository.login(email: 'a@example.test', password: 'password');
        final error = await dio
            .get('/payments')
            .then<DioException>(
              (_) => throw StateError('expected failure'),
              onError: (Object error) => error as DioException,
            );
        expect(error.response?.statusCode, status);
        expect(error.response?.data['code'], 'conflict');
        expect(
          (await TokenStorage().getSession())?.refreshToken,
          'refresh-new',
        );
        expect(client.authToken, 'new');
      },
    );
  }

  test('post-refresh transport failure is propagated', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _RefreshServer()..retryOffline = true;
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
      ..httpClientAdapter = server;
    final client = ApiClient(client: dio);
    final repository = AuthRepository(
      authApi: AuthApi(client),
      tokenStorage: TokenStorage(),
      apiClient: client,
    );
    await repository.login(email: 'a@example.test', password: 'password');
    final error = await dio
        .get('/payments')
        .then<DioException>(
          (_) => throw StateError('expected failure'),
          onError: (Object error) => error as DioException,
        );
    expect(error.type, DioExceptionType.connectionError);
    expect(error.response, isNull);
    expect(client.authToken, 'new');
  });

  test(
    'activity controller retains its cache on transient refresh failure',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final server = _RefreshServer()..failRefresh = true;
      final client = ApiClient(
        client: Dio(BaseOptions(baseUrl: 'http://localhost/api'))
          ..httpClientAdapter = server,
      );
      final storage = TokenStorage();
      final auth = AuthController(
        AuthRepository(
          authApi: AuthApi(client),
          tokenStorage: storage,
          apiClient: client,
        ),
      );
      await auth.login(email: 'a@example.test', password: 'password');
      final cached = {
        'syncedAt': DateTime.utc(2025).toIso8601String(),
        'payments': [],
      };
      await storage.setActivity(
        token: 'old',
        userId: 1,
        activity: cached,
        isCurrent: () => true,
      );
      final controller = PaymentController(
        PaymentRepository(PaymentApi(client)),
        storage,
        auth,
        client,
      );
      await controller.loadPayments();
      expect(controller.state, isA<ActivityAvailable>());
      expect((controller.state as ActivityAvailable).snapshot.cached, isTrue);
      expect((await storage.getSession())?.activity, cached);
      expect(auth.isAuthenticated, isTrue);
      controller.dispose();
      auth.dispose();
    },
  );

  test('logout during refresh never retries or installs old account', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _RefreshServer()..gate = Completer<void>();
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
      ..httpClientAdapter = server;
    final client = ApiClient(client: dio);
    final repository = AuthRepository(
      authApi: AuthApi(client),
      tokenStorage: TokenStorage(),
      apiClient: client,
    );
    await repository.login(email: 'a@example.test', password: 'password');
    final request = dio
        .get('/payments')
        .then<Object>((value) => value, onError: (Object error) => error);
    while (server.refreshes == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    await repository.logout();
    server.gate!.complete();
    expect(await request, isA<DioException>());
    expect(client.authToken, isNull);
    expect(await TokenStorage().getSession(), isNull);
    expect(server.protectedRequests, 1);
    expect(server.revoked, containsAll(['refresh-old', 'refresh-new']));
  });

  test('account change during refresh never retries as the new user', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _RefreshServer()..gate = Completer<void>();
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
      ..httpClientAdapter = server;
    final client = ApiClient(client: dio);
    final repository = AuthRepository(
      authApi: AuthApi(client),
      tokenStorage: TokenStorage(),
      apiClient: client,
    );
    await repository.login(email: 'a@example.test', password: 'password');
    final request = dio
        .get('/payments')
        .then<Object>((value) => value, onError: (Object error) => error);
    while (server.refreshes == 0) {
      await Future<void>.delayed(Duration.zero);
    }
    await repository.logout();
    await TokenStorage().saveSession('user-b', {
      'id': 2,
      'name': 'B',
      'email': 'b@example.test',
    }, refreshToken: 'refresh-b');
    client.setAuthToken('user-b');
    server.gate!.complete();
    expect(await request, isA<DioException>());
    expect(client.authToken, 'user-b');
    expect((await TokenStorage().getSession())?.refreshToken, 'refresh-b');
    expect(server.protectedRequests, 1);
    expect(server.revoked, contains('refresh-new'));
  });

  test(
    'activity controller does not reject or purge cache on retry 409',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final server = _RefreshServer()..retryStatus = 409;
      final client = ApiClient(
        client: Dio(BaseOptions(baseUrl: 'http://localhost/api'))
          ..httpClientAdapter = server,
      );
      final storage = TokenStorage();
      final auth = AuthController(
        AuthRepository(
          authApi: AuthApi(client),
          tokenStorage: storage,
          apiClient: client,
        ),
      );
      await auth.login(email: 'a@example.test', password: 'password');
      final cached = {
        'syncedAt': DateTime.utc(2025).toIso8601String(),
        'payments': [],
      };
      await storage.setActivity(
        token: 'old',
        userId: 1,
        activity: cached,
        isCurrent: () => true,
      );
      final controller = PaymentController(
        PaymentRepository(PaymentApi(client)),
        storage,
        auth,
        client,
      );
      await controller.loadPayments();
      expect(controller.state, isA<ActivityUnavailable>());
      expect(
        (controller.state as ActivityUnavailable).message,
        isNot(contains('rejected')),
      );
      expect((await storage.getSession())?.activity, cached);
      expect(auth.isAuthenticated, isTrue);
      controller.dispose();
      auth.dispose();
    },
  );

  test('refresh endpoint 403 is not presented as resource rejection', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _RefreshServer()
      ..failRefresh = true
      ..refreshFailureStatus = 403;
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
      ..httpClientAdapter = server;
    final client = ApiClient(client: dio);
    final repository = AuthRepository(
      authApi: AuthApi(client),
      tokenStorage: TokenStorage(),
      apiClient: client,
    );
    await repository.login(email: 'a@example.test', password: 'password');
    final error = await dio
        .get('/payments')
        .then<DioException>(
          (_) => throw StateError('expected failure'),
          onError: (Object error) => error as DioException,
        );
    expect(error, isA<RefreshFailure>());
    expect(error.response, isNull);
    expect((error.error as DioException).response?.statusCode, 403);
    expect((await TokenStorage().getSession())?.refreshToken, 'refresh-old');
  });

  test('account change while retry is queued prevents dispatch', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _RefreshServer();
    final retryQueued = Completer<void>();
    final release = Completer<void>();
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost/api'))
      ..httpClientAdapter = server;
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          if (options.extra['retried_after_refresh'] == true) {
            retryQueued.complete();
            await release.future;
          }
          handler.next(options);
        },
      ),
    );
    final client = ApiClient(client: dio);
    final repository = AuthRepository(
      authApi: AuthApi(client),
      tokenStorage: TokenStorage(),
      apiClient: client,
    );
    await repository.login(email: 'a@example.test', password: 'password');
    final request = dio
        .get('/payments')
        .then<Object>((value) => value, onError: (Object error) => error);
    await retryQueued.future;
    await repository.logout();
    await TokenStorage().saveSession('user-b', {
      'id': 2,
    }, refreshToken: 'refresh-b');
    client.setAuthToken('user-b');
    release.complete();
    final error = await request as DioException;
    expect(error.type, DioExceptionType.cancel);
    expect(error.response, isNull);
    expect(server.protectedRequests, 1);
    expect(client.authToken, 'user-b');
    expect((await TokenStorage().getSession())?.refreshToken, 'refresh-b');
  });

  test('registration, logout and restart keep two users separate', () async {
    FlutterSecureStorage.setMockInitialValues({});
    final server = _AuthServer();
    var repository = _repository(server);

    expect(
      (await repository.login(
        email: 'a@example.test',
        password: 'password',
      )).id,
      1,
    );
    repository = _repository(server);
    expect((await repository.restoreSession())?.email, 'a@example.test');
    server.offline = true;
    expect(
      (await _repository(server).restoreSession())?.email,
      'a@example.test',
    );
    server.offline = false;
    await repository.logout();
    expect(await _repository(server).restoreSession(), isNull);

    final registered = await repository.register(
      name: 'User B',
      email: 'b@example.test',
      password: 'password',
    );
    expect(registered.id, 2);
    repository = _repository(server);
    expect((await repository.restoreSession())?.email, 'b@example.test');
    await repository.logout();

    await repository.login(email: 'a@example.test', password: 'password');
    expect((await _repository(server).restoreSession())?.id, 1);
  });
}
