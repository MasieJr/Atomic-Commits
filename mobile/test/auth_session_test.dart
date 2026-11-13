import 'dart:convert';
import 'dart:typed_data';

import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
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
