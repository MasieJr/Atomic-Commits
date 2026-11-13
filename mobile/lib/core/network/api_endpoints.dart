import 'package:flutter/foundation.dart';

class ApiEndpoints {
  static const String _configuredBaseUrl = String.fromEnvironment('ATOMIC_API_BASE_URL');
  static String get baseUrl => _configuredBaseUrl.isNotEmpty
      ? _configuredBaseUrl
      : kIsWeb ? '${Uri.base.origin}/api' : 'http://localhost:3000/api';
  static const String register = '/auth/register';
  static const String emailCode = '/auth/email-code';
  static const String login = '/auth/login';
  static const String refresh = '/auth/refresh';
  static const String logout = '/auth/logout';
  static const String me = '/auth/me';
  static const String payments = '/payments';
}
