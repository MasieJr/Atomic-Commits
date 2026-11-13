import 'package:dio/dio.dart';

import 'api_endpoints.dart';
import 'network_errors.dart';

class ApiClient {
  late final Dio dio;

  /// Exchanges the stored refresh token for a fresh access token.
  /// Returns null only when the session is definitively dead; throws on
  /// transient failures (network, 5xx) so they are not treated as expiry.
  Future<String?> Function(String token, int generation)? onRefreshRequest;

  /// Called once when a 401 could not be recovered by refreshing.
  void Function()? onSessionExpired;

  Future<String?>? _refreshing;
  int? _refreshGeneration;
  int _generation = 0;
  int get generation => _generation;
  String? get authToken {
    final value = dio.options.headers['Authorization'];
    return value is String && value.startsWith('Bearer ')
        ? value.substring(7)
        : null;
  }

  ApiClient({Dio? client}) {
    final uri = Uri.parse(ApiEndpoints.baseUrl);
    final local = [
      'localhost',
      '127.0.0.1',
      '10.0.2.2',
      '::1',
    ].contains(uri.host);
    if (client == null &&
        (uri.host.isEmpty ||
            uri.userInfo.isNotEmpty ||
            uri.hasQuery ||
            uri.hasFragment ||
            (uri.scheme != 'https' && !(uri.scheme == 'http' && local)))) {
      throw StateError(
        'ATOMIC_API_BASE_URL must use HTTPS, except for local development.',
      );
    }
    dio =
        client ??
        Dio(
          BaseOptions(
            baseUrl: ApiEndpoints.baseUrl,
            connectTimeout: const Duration(seconds: 15),
            receiveTimeout: const Duration(seconds: 15),
            sendTimeout: const Duration(seconds: 15),
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
          ),
        );
    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          final expected = options.extra['retry_generation'];
          final authorization = options.headers['Authorization'];
          final bearer =
              authorization is String && authorization.startsWith('Bearer ')
              ? authorization.substring(7)
              : null;
          if ((expected != null && expected != _generation) ||
              (bearer != null && bearer != authToken)) {
            handler.reject(_accountChanged(options));
            return;
          }
          options.extra['auth_generation'] = _generation;
          options.extra['authenticated_request'] = bearer != null;
          handler.next(options);
        },
        onResponse: (response, handler) {
          final options = response.requestOptions;
          if (options.extra['authenticated_request'] == true &&
              options.extra['auth_generation'] != _generation) {
            handler.reject(_accountChanged(options));
            return;
          }
          handler.next(response);
        },
        onError: (error, handler) async {
          final options = error.requestOptions;
          if (options.extra['auth_generation'] != null &&
              options.extra['auth_generation'] != _generation) {
            handler.next(_accountChanged(options));
            return;
          }
          if (error.response?.statusCode != 401 ||
              options.extra['retried_after_refresh'] == true ||
              !_shouldRefresh(options.path)) {
            handler.next(error);
            return;
          }
          final refresh = onRefreshRequest;
          if (refresh == null) {
            handler.next(error);
            return;
          }

          final authorization = options.headers['Authorization'];
          if (authorization is! String ||
              !authorization.startsWith('Bearer ')) {
            handler.next(error);
            return;
          }
          final oldToken = authorization.substring(7);
          final generation = _generation;

          String? token;
          try {
            // Single-flight: concurrent 401s share one refresh round-trip.
            if (authToken != oldToken) {
              token = authToken;
            } else {
              if (_refreshing == null || _refreshGeneration != generation) {
                _refreshGeneration = generation;
                _refreshing = refresh(oldToken, generation).whenComplete(() {
                  if (_refreshGeneration == generation) _refreshing = null;
                });
              }
              token = await _refreshing;
            }
          } catch (cause) {
            handler.next(
              generation != _generation
                  ? _accountChanged(options)
                  : RefreshFailure(requestOptions: options, cause: cause),
            );
            return;
          }

          if (generation != _generation) {
            handler.next(_accountChanged(options));
            return;
          }
          if (token == null) {
            onSessionExpired?.call();
            handler.next(error);
            return;
          }

          options.headers['Authorization'] = 'Bearer $token';
          options.extra['retried_after_refresh'] = true;
          options.extra['retry_generation'] = generation;
          try {
            final response = await dio.fetch<dynamic>(options);
            handler.resolve(response);
          } on DioException catch (retryError) {
            handler.next(
              generation != _generation ? _accountChanged(options) : retryError,
            );
          } catch (cause) {
            handler.next(DioException(requestOptions: options, error: cause));
          }
        },
      ),
    );
  }

  DioException _accountChanged(RequestOptions options) => DioException(
    requestOptions: options,
    type: DioExceptionType.cancel,
    message: 'Account changed',
  );

  /// Only /auth/me recovers via refresh: a 401 from login/register/code
  /// means bad credentials, and google/link 401s are domain errors.
  bool _shouldRefresh(String path) =>
      !path.startsWith('/auth/') || path == ApiEndpoints.me;

  void setAuthToken(String token) {
    dio.options.headers['Authorization'] = 'Bearer $token';
  }

  void clearAuthToken() {
    _generation++;
    dio.options.headers.remove('Authorization');
  }
}
