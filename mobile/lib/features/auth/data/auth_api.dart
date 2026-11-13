import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:dio/dio.dart';

enum EmailVerificationState { notRequired, required, unavailable }

class AuthApi {
  final ApiClient _apiClient;

  AuthApi(this._apiClient);

  Future<EmailVerificationState> emailVerificationState() async {
    try {
      final response = await _apiClient.dio.get(
        ApiEndpoints.emailVerificationStatus,
      );
      final data = response.data;
      if (data is! Map ||
          data['required'] is! bool ||
          data['available'] is! bool) {
        throw const FormatException('Invalid email verification status');
      }
      if (data['available'] == false) return EmailVerificationState.unavailable;
      return data['required'] == true
          ? EmailVerificationState.required
          : EmailVerificationState.notRequired;
    } on DioException catch (error) {
      if (error.response?.statusCode == 404) {
        return EmailVerificationState.notRequired;
      }
      rethrow;
    }
  }

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

  Future<Map<String, dynamic>> register({
    required String name,
    required String email,
    required String password,
    String? emailCode,
  }) async {
    final response = await _apiClient.dio.post(
      ApiEndpoints.register,
      data: {
        'name': name,
        'email': email,
        'password': password,
        'emailCode': ?emailCode,
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
