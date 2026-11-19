import 'package:dio/dio.dart';

import 'api_endpoints.dart';

class ApiClient {
  late final Dio dio;

  /// Exchanges the stored refresh token for a fresh access token.
  /// Returns null only when the session is definitively dead; throws on
  /// transient failures (network, 5xx) so the original error is surfaced.
  Future<String?> Function()? onRefreshRequest;

  /// Called once when a 401 could not be recovered by refreshing.
  void Function()? onSessionExpired;

  Future<String?>? _refreshing;

  ApiClient({Dio? client}) {
    final uri = Uri.parse(ApiEndpoints.baseUrl);
    final local = ['localhost', '127.0.0.1', '10.0.2.2', '::1'].contains(uri.host);
    if (client == null &&
        (uri.host.isEmpty || uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment ||
            (uri.scheme != 'https' && !(uri.scheme == 'http' && local)))) {
      throw StateError('ATOMIC_API_BASE_URL must use HTTPS, except for local development.');
    }
    dio = client ?? Dio(
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
        onError: (error, handler) async {
          final options = error.requestOptions;
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

          String? token;
          try {
            // Single-flight: concurrent 401s share one refresh round-trip.
            _refreshing ??= refresh().whenComplete(() => _refreshing = null);
            token = await _refreshing;
          } catch (_) {
            // Transient refresh failure: surface the original 401 untouched
            // (and marked, so callers can tell it from a dead session).
            options.extra['refresh_failed_transient'] = true;
            handler.next(error);
            return;
          }

          if (token == null) {
            onSessionExpired?.call();
            handler.next(error);
            return;
          }

          options.headers['Authorization'] = 'Bearer $token';
          options.extra['retried_after_refresh'] = true;
          try {
            final response = await dio.fetch<dynamic>(options);
            handler.resolve(response);
          } catch (_) {
            handler.next(error);
          }
        },
      ),
    );
  }

  /// Only /auth/me recovers via refresh: a 401 from login/register/code
  /// means bad credentials, and google/link 401s are domain errors.
  bool _shouldRefresh(String path) =>
      !path.startsWith('/auth/') || path == ApiEndpoints.me;

  void setAuthToken(String token) {
    dio.options.headers['Authorization'] = 'Bearer $token';
  }

  void clearAuthToken() {
    dio.options.headers.remove('Authorization');
  }
}
