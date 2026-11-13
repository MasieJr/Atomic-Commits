import 'dart:convert';

class StoredSession {
  const StoredSession({
    required this.token,
    this.refreshToken,
    this.user,
    this.activity,
  });

  final String token;
  final String? refreshToken;
  final Map<String, dynamic>? user;
  final Map<String, dynamic>? activity;
}

class SessionStore {
  SessionStore({
    required this.read,
    required this.write,
    required this.delete,
    required this.deleteLegacy,
  });

  final Future<String?> Function() read;
  final Future<void> Function(String) write;
  final Future<void> Function() delete;
  final Future<void> Function() deleteLegacy;
  Future<void> _pending = Future.value();

  Future<T> _serialize<T>(Future<T> Function() operation) {
    final result = _pending.then((_) => operation());
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<StoredSession?> _readSession() async {
    final raw = await read();
    if (raw == null) return null;
    final value = jsonDecode(raw);
    if (value is! Map || value['token'] is! String || value['user'] is! Map) {
      throw const FormatException('Invalid stored session');
    }
    final activity = value['activity'];
    return StoredSession(
      token: value['token'] as String,
      refreshToken: value['refreshToken'] as String?,
      user: Map<String, dynamic>.from(value['user'] as Map),
      activity: activity is Map ? Map<String, dynamic>.from(activity) : null,
    );
  }

  String _encode(StoredSession session) => jsonEncode({
    'token': session.token,
    if (session.refreshToken != null) 'refreshToken': session.refreshToken,
    'user': session.user,
    if (session.activity != null) 'activity': session.activity,
  });

  Future<StoredSession?> getSession() => _serialize(_readSession);

  Future<void> saveSession(
    String token,
    Map<String, dynamic> user, {
    String? refreshToken,
  }) => _serialize(() async {
    StoredSession? previous;
    try {
      previous = await _readSession();
    } catch (_) {
      previous = null;
    }
    await deleteLegacy();
    final sameSession =
        previous?.token == token && previous?.user?['id'] == user['id'];
    await write(
      _encode(
        StoredSession(
          token: token,
          refreshToken: refreshToken,
          user: user,
          activity: sameSession ? previous?.activity : null,
        ),
      ),
    );
  });

  Future<void> setActivity({
    required String token,
    required int userId,
    required Map<String, dynamic>? activity,
    required bool Function() isCurrent,
  }) => _serialize(() async {
    if (!isCurrent()) return;
    final session = await _readSession();
    if (!isCurrent() ||
        session?.token != token ||
        session?.user?['id'] != userId) {
      return;
    }
    await write(
      _encode(
        StoredSession(
          token: token,
          refreshToken: session!.refreshToken,
          user: session.user,
          activity: activity,
        ),
      ),
    );
  });

  Future<bool> rotateSession(
    String oldToken,
    String token,
    String refreshToken,
    bool Function() isCurrent,
  ) => _serialize(() async {
    if (!isCurrent()) return false;
    final session = await _readSession();
    if (!isCurrent() || session?.token != oldToken) return false;
    await write(
      _encode(
        StoredSession(
          token: token,
          refreshToken: refreshToken,
          user: session!.user,
          activity: session.activity,
        ),
      ),
    );
    return isCurrent();
  });

  Future<void> deleteSession() => _serialize(() async {
    try {
      await delete();
    } finally {
      await deleteLegacy();
    }
  });
}
