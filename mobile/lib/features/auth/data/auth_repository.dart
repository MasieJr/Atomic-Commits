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

    await _tokenStorage.saveSession(authResponse.token, authResponse.user.toJson());
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

    await _tokenStorage.saveSession(authResponse.token, authResponse.user.toJson());
    _apiClient.setAuthToken(authResponse.token);

    return authResponse.user;
  }

  Future<UserModel?> restoreSession() async {
    final session = await _tokenStorage.getSession();
    final token = session?.token;

    if (token == null || token.isEmpty) {
      return null;
    }

    _apiClient.setAuthToken(token);

    try {
      final user = await _authApi.me();
      await _tokenStorage.saveSession(token, user.toJson());
      return user;
    } on DioException catch (error) {
      final statusCode = error.response?.statusCode;

      if (statusCode == 401 || statusCode == 403) {
        await logout();
        return null;
      }
      if ((statusCode == null || statusCode >= 500) && session?.user != null) {
        return UserModel.fromJson(session!.user!);
      }
      rethrow;
    }
  }

  Future<void> logout() async {
    _apiClient.clearAuthToken();
    await _tokenStorage.deleteSession();
  }
}
