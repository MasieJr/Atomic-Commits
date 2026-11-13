import 'dart:convert';

import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class StoredSession {
  const StoredSession({required this.token, this.user});

  final String token;
  final Map<String, dynamic>? user;
}

class TokenStorage {
  static const String _tokenKey = 'auth_token';
  static final String _sessionKey =
      'auth_session_${sha256.convert(utf8.encode(ApiEndpoints.baseUrl))}';

  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Future<void> saveSession(String token, Map<String, dynamic> user) async {
    await _storage.write(key: _sessionKey, value: jsonEncode({'token': token, 'user': user}));
    await _storage.delete(key: _tokenKey);
  }

  Future<StoredSession?> getSession() async {
    final stored = await _storage.read(key: _sessionKey);
    if (stored != null) {
      final value = jsonDecode(stored) as Map<String, dynamic>;
      return StoredSession(
        token: value['token'] as String,
        user: Map<String, dynamic>.from(value['user'] as Map),
      );
    }
    return null;
  }

  Future<void> deleteSession() async {
    await _storage.delete(key: _sessionKey);
    await _storage.delete(key: _tokenKey);
  }
}
