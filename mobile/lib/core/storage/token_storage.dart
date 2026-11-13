import 'dart:convert';

import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'session_store.dart';

export 'session_store.dart' show StoredSession;

class TokenStorage {
  static const String _tokenKey = 'auth_token';
  static final String _sessionKey =
      'auth_session_${sha256.convert(utf8.encode(ApiEndpoints.baseUrl))}';

  static const FlutterSecureStorage _storage = FlutterSecureStorage();
  static final SessionStore _store = SessionStore(
    read: () => _storage.read(key: _sessionKey),
    write: (value) => _storage.write(key: _sessionKey, value: value),
    delete: () => _storage.delete(key: _sessionKey),
    deleteLegacy: () => _storage.delete(key: _tokenKey),
  );

  Future<void> saveSession(
    String token,
    Map<String, dynamic> user, {
    String? refreshToken,
  }) => _store.saveSession(token, user, refreshToken: refreshToken);

  Future<bool> rotateSession(
    String oldToken,
    String token,
    String refreshToken,
    bool Function() isCurrent,
  ) => _store.rotateSession(oldToken, token, refreshToken, isCurrent);

  Future<StoredSession?> getSession() => _store.getSession();

  Future<void> setActivity({
    required String token,
    required int userId,
    required Map<String, dynamic>? activity,
    required bool Function() isCurrent,
  }) => _store.setActivity(
    token: token,
    userId: userId,
    activity: activity,
    isCurrent: isCurrent,
  );

  Future<void> deleteSession() => _store.deleteSession();
}
