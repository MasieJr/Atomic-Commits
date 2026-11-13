import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/api_endpoints.dart';

class AuthApi {
  final ApiClient _apiClient;

  AuthApi(this._apiClient);

  Future<void> sendEmailCode(String email) async {
    await _apiClient.dio.post(ApiEndpoints.emailCode, data: {'email': email});
  }

  Future<Map<String, dynamic>> login({
    required String email,
    required String password,
  }) async {
    final response = await _apiClient.dio.post(
      ApiEndpoints.login,
      data: {'email': email, 'password': password},
    );

    return Map<String, dynamic>.from(response.data);
  }

  Future<Map<String, dynamic>> refresh(String refreshToken) async {
    final response = await _apiClient.dio.post(
      ApiEndpoints.refresh,
      data: {'refreshToken': refreshToken},
    );

    return Map<String, dynamic>.from(response.data);
  }

  Future<void> logout(String refreshToken) async {
    await _apiClient.dio.post(
      ApiEndpoints.logout,
      data: {'refreshToken': refreshToken},
    );
  }

  Future<Map<String, dynamic>> register({
    required String name,
    required String email,
    required String password,
    required String emailCode,
  }) async {
    final response = await _apiClient.dio.post(
      ApiEndpoints.register,
      data: {
        'name': name,
        'email': email,
        'password': password,
        'emailCode': emailCode,
      },
    );

    return Map<String, dynamic>.from(response.data);
  }

  Future<UserModel> me() async {
    final response = await _apiClient.dio.get(ApiEndpoints.me);

    return UserModel.fromJson(
      Map<String, dynamic>.from(response.data['user'] as Map),
    );
  }
}
