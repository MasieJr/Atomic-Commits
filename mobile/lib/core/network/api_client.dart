import 'package:dio/dio.dart';

import 'api_endpoints.dart';

class ApiClient {
  late final Dio dio;

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
  }

  void setAuthToken(String token) {
    dio.options.headers['Authorization'] = 'Bearer $token';
  }

  void clearAuthToken() {
    dio.options.headers.remove('Authorization');
  }
}
