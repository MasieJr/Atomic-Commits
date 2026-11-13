import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/activity/data/activity_cache.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/models/auth_response.dart';
import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:atomic_commits/features/wallet/wallet_cache.dart';
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

  Future<void> sendEmailCode(String email) => _authApi.sendEmailCode(email);

  Future<void> saveGoogleSession(
    UserModel user,
    String token,
    String? refreshToken,
  ) async {
    await _tokenStorage.saveSession(
      token,
      user.toJson(),
      refreshToken: refreshToken,
    );
    _apiClient.setAuthToken(token);
  }

  Future<UserModel> login({
    required String email,
    required String password,
  }) async {
    final response = await _authApi.login(email: email, password: password);

    final authResponse = AuthResponse.fromJson(response);

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
    required String emailCode,
  }) async {
    final response = await _authApi.register(
      name: name,
      email: email,
      password: password,
      emailCode: emailCode,
    );

    final authResponse = AuthResponse.fromJson(response);

    await _tokenStorage.saveSession(
      authResponse.token,
      authResponse.user.toJson(),
      refreshToken: authResponse.refreshToken,
    );
    _apiClient.setAuthToken(authResponse.token);

    return authResponse.user;
  }

  /// Exchanges the stored refresh token for a fresh access token.
  /// Returns null only when the session is definitively dead (the server
  /// rejected the refresh token, or no refresh token is stored); throws on
  /// transient failures so a flaky network never destroys a live session.
  Future<String?> refreshAccessToken() async {
    final session = await _tokenStorage.getSession();
    final refreshToken = session?.refreshToken;
    if (refreshToken == null || refreshToken.isEmpty) return null;

    try {
      final response = await _authApi.refresh(refreshToken);
      final authResponse = AuthResponse.fromJson(response);

      await _tokenStorage.saveSession(
        authResponse.token,
        authResponse.user.toJson(),
        refreshToken: authResponse.refreshToken,
      );
      _apiClient.setAuthToken(authResponse.token);
      return authResponse.token;
    } on DioException catch (error) {
      final statusCode = error.response?.statusCode;
      if (statusCode == 401 || statusCode == 403) {
        await _forgetLocalSession();
        return null;
      }
      rethrow;
    }
  }

  Future<UserModel?> restoreSession() async {
    final session = await _tokenStorage.getSession();
    final token = session?.token;

    if (token == null || token.isEmpty) {
      return null;
    }

    _apiClient.setAuthToken(token);

    try {
      /* a 401 here triggers the ApiClient's refresh-and-retry first; only an
         unrecoverable session reaches the catch below */
      final user = await _authApi.me();
      // Refreshing may have rotated the pair while me() was in flight —
      // persist whatever is current, not the snapshot taken above.
      final latest = await _tokenStorage.getSession();
      await _tokenStorage.saveSession(
        latest?.token ?? token,
        user.toJson(),
        refreshToken: latest?.refreshToken ?? session?.refreshToken,
      );
      return user;
    } on DioException catch (error) {
      final statusCode = error.response?.statusCode;

      if (statusCode == 401 || statusCode == 403) {
        if (error.requestOptions.extra['refresh_failed_transient'] == true) {
          // Refresh was tried and failed on the network: keep the stored
          // session for the next launch instead of logging the user out.
          rethrow;
        }
        final id = session?.user?['id'];
        await logout(userId: id is int ? id : null);
        return null;
      }
      if ((statusCode == null || statusCode >= 500) && session?.user != null) {
        return UserModel.fromJson(session!.user!);
      }
      rethrow;
    }
  }

  Future<void> logout({int? userId}) async {
    try {
      if (userId != null) {
        try {
          await ActivityCache().purge(_apiClient.dio.options.baseUrl, userId);
        } finally {
          await WalletCache.purge(origin: _apiClient.dio.options.baseUrl, userId: userId);
        }
      }
    } finally {
      await _revokeRefreshToken();
      await _forgetLocalSession();
    }
  }

  /// Best-effort server-side revocation; the local session is dropped either way.
  Future<void> _revokeRefreshToken() async {
    final refreshToken = (await _tokenStorage.getSession())?.refreshToken;
    if (refreshToken == null || refreshToken.isEmpty) return;
    try {
      await _authApi.logout(refreshToken);
    } catch (_) {
      // The refresh token expires on its own; losing this call is not fatal.
    }
  }

  Future<void> _forgetLocalSession() async {
    _apiClient.clearAuthToken();
    await _tokenStorage.deleteSession();
  }
}
