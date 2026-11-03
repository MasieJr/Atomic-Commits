import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/models/auth_response.dart';
import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:dio/dio.dart';

class AuthRepository {
  final AuthApi _authApi;
  final TokenStorage _tokenStorage;
  final ApiClient _apiClient;

  AuthRepository({
    required this._authApi,
    required this._tokenStorage,
    required this._apiClient,
  });

  Future<UserModel> login({
    required String email,
    required String password,
  }) async {
    final response = await _authApi.login(email: email, password: password);

    final authResponse = AuthResponse.fromJson(response);

    await _tokenStorage.saveToken(authResponse.token);
    _apiClient.setAuthToken(authResponse.token);

    return authResponse.user;
  }

  Future<UserModel> register({
    required String name,
    required String email,
    required String password,
  }) async {
    final response = await _authApi.register(
      name: name,
      email: email,
      password: password,
    );

    final authResponse = AuthResponse.fromJson(response);

    await _tokenStorage.saveToken(authResponse.token);
    _apiClient.setAuthToken(authResponse.token);

    return authResponse.user;
  }

  Future<UserModel?> restoreSession() async {
    final token = await _tokenStorage.getToken();

    if (token == null || token.isEmpty) {
      return null;
    }

    _apiClient.setAuthToken(token);

    try {
      return await _authApi.me();
    } on DioException catch (error) {
      final statusCode = error.response?.statusCode;

      if (statusCode == 401 || statusCode == 403) {
        await logout();
        return null;
      }
      rethrow;
    }
  }

  Future<void> logout() async {
    _apiClient.clearAuthToken();
    await _tokenStorage.deleteToken();
  }
}
