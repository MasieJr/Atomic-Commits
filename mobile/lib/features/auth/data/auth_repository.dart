import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/network_errors.dart';
import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/models/auth_response.dart';
import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:dio/dio.dart';

class AuthRepository {
  final AuthApi _authApi;
  final TokenStorage _tokenStorage;
  final ApiClient _apiClient;
  set onSessionExpired(void Function()? callback) =>
      _apiClient.onSessionExpired = callback;

  AuthRepository({
    required this._authApi,
    required this._tokenStorage,
    required this._apiClient,
  }) {
    _apiClient.onRefreshRequest = _refresh;
  }

  Future<void> _revoke(String? refreshToken) async {
    if (refreshToken == null || refreshToken.isEmpty) return;
    try {
      await _apiClient.dio.post(
        ApiEndpoints.logout,
        data: {'refreshToken': refreshToken},
        options: Options(headers: {'Authorization': null}),
      );
    } catch (_) {
      // Local logout must succeed even when revocation is unavailable.
    }
  }

  Future<String?> _refresh(String oldToken, int generation) async {
    bool current() =>
        _apiClient.generation == generation && _apiClient.authToken == oldToken;
    final session = await _tokenStorage.getSession();
    if (!current()) throw StateError('Account changed');
    final refreshToken = session?.refreshToken;
    if (session?.token != oldToken ||
        refreshToken == null ||
        refreshToken.isEmpty) {
      return null;
    }
    final Response<dynamic> response;
    try {
      response = await _apiClient.dio.post(
        ApiEndpoints.refresh,
        data: {'refreshToken': refreshToken},
        options: Options(headers: {'Authorization': null}),
      );
    } on DioException catch (error) {
      if (error.response?.statusCode == 401) return null;
      rethrow;
    }
    final data = response.data;
    if (data is! Map ||
        data['token'] is! String ||
        (data['token'] as String).isEmpty ||
        data['refreshToken'] is! String ||
        (data['refreshToken'] as String).isEmpty ||
        data['user'] is! Map ||
        (data['user'] as Map)['id'] != session!.user?['id']) {
      throw const FormatException('Invalid refresh response');
    }
    final token = data['token'] as String;
    final rotated = data['refreshToken'] as String;
    if (!current() ||
        !await _tokenStorage.rotateSession(oldToken, token, rotated, current)) {
      await _revoke(rotated);
      throw StateError('Account changed');
    }
    if (!current()) {
      await _revoke(rotated);
      throw StateError('Account changed');
    }
    _apiClient.setAuthToken(token);
    return token;
  }

  Future<void> saveGoogleSession(
    UserModel user,
    String token,
    String? refreshToken,
  ) async {
    _apiClient.clearAuthToken();
    await _tokenStorage.saveSession(
      token,
      user.toJson(),
      refreshToken: refreshToken,
    );
    _apiClient.setAuthToken(token);
  }

  Future<EmailVerificationState> emailVerificationState() =>
      _authApi.emailVerificationState();

  Future<void> sendEmailCode(String email) => _authApi.sendEmailCode(email);

  Future<UserModel> login({
    required String email,
    required String password,
  }) async {
    final response = await _authApi.login(email: email, password: password);

    final authResponse = AuthResponse.fromJson(response);

    _apiClient.clearAuthToken();
    await _tokenStorage.saveSession(
      authResponse.token,
      authResponse.user.toJson(),
      refreshToken: authResponse.refreshToken,
    );
    _apiClient.setAuthToken(authResponse.token);

    return authResponse.user;
  }

  Future<UserModel> register({
    required String name,
    required String email,
    required String password,
    String? emailCode,
  }) async {
    final response = await _authApi.register(
      name: name,
      email: email,
      password: password,
      emailCode: emailCode,
    );

    final authResponse = AuthResponse.fromJson(response);

    _apiClient.clearAuthToken();
    await _tokenStorage.saveSession(
      authResponse.token,
      authResponse.user.toJson(),
      refreshToken: authResponse.refreshToken,
    );
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
      return user;
    } on DioException catch (error) {
      final statusCode = error.response?.statusCode;

      if ((statusCode == 401 || statusCode == 403) &&
          error is! RefreshFailure) {
        await logout();
        return null;
      }
      if ((isOfflineFailure(error) ||
              (statusCode != null && statusCode >= 500)) &&
          session?.user != null) {
        return UserModel.fromJson(session!.user!);
      }
      rethrow;
    }
  }

  Future<void> logout() async {
    _apiClient.clearAuthToken();
    final session = await _tokenStorage.getSession();
    await _tokenStorage.deleteSession();
    await _revoke(session?.refreshToken);
  }

  void invalidate() => _apiClient.clearAuthToken();
}
