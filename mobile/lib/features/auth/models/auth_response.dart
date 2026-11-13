import 'package:atomic_commits/features/auth/models/user_model.dart';

class AuthResponse {
  final String message;
  final UserModel user;
  final String token;

  const AuthResponse({
    required this.message,
    required this.user,
    required this.token,
  });

  factory AuthResponse.fromJson(Map<String, dynamic> json) {
    return AuthResponse(
      message: json['message'] as String,
      user: UserModel.fromJson(json['user'] as Map<String, dynamic>),
      token: json['token'] as String,
    );
  }
}
