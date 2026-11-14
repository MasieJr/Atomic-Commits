import 'package:flutter/foundation.dart';

import 'data/auth_repository.dart';
import 'data/auth_api.dart';
import 'models/user_model.dart';

class AuthController extends ChangeNotifier {
  final AuthRepository _repository;

  AuthController(this._repository);

  UserModel? _user;
  bool _isInitialized = false;
  bool _newAccount = false;
  Future<void> _pending = Future.value();
  bool _loggingOut = false;
  bool _authenticating = false;
  int _generation = 0;

  Future<T> _serialize<T>(Future<T> Function() operation) {
    final result = _pending.then((_) => operation());
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  UserModel? get user => _user;
  bool get isInitialized => _isInitialized;
  bool get isAuthenticated => _user != null;
  bool get isNewAccount => _newAccount;
  bool get isLoggingOut => _loggingOut;
  int get sessionGeneration => _generation;

  Future<EmailVerificationState> emailVerificationState() =>
      _repository.emailVerificationState();

  Future<void> sendEmailCode(String email) => _repository.sendEmailCode(email);

  Future<void> initialize() {
    if (_loggingOut) return Future.error(StateError('Logout in progress'));
    final generation = _generation;
    return _serialize(() async {
      try {
        if (generation != _generation) return;
        final user = await _repository.restoreSession();
        if (generation == _generation) _user = user;
      } catch (_) {
        // Keep the app usable if the server is temporarily unavailable.
        // The stored token is not deleted for network errors.
      } finally {
        _isInitialized = true;
        notifyListeners();
      }
    });
  }

  Future<UserModel> login({
    required String email,
    required String password,
  }) async {
    if (_loggingOut || _authenticating || _user != null) {
      throw StateError('Authentication unavailable');
    }
    _authenticating = true;
    final generation = _generation;
    try {
      return await _serialize(() async {
        if (generation != _generation || _user != null) {
          throw StateError('Account changed');
        }
        final user = await _repository.login(email: email, password: password);
        if (generation != _generation) throw StateError('Account changed');
        _user = user;
        _newAccount = false;
        notifyListeners();
        return user;
      });
    } finally {
      _authenticating = false;
    }
  }

  Future<void> completeGoogleSignIn(UserModel user, String token) async {
    if (_loggingOut || _authenticating || _user != null) {
      throw StateError('Authentication unavailable');
    }
    _authenticating = true;
    final generation = _generation;
    try {
      await _serialize(() async {
        if (generation != _generation || _user != null) {
          throw StateError('Account changed');
        }
        await _repository.saveGoogleSession(user, token);
        if (generation != _generation) throw StateError('Account changed');
        _user = user;
        _newAccount = false;
        notifyListeners();
      });
    } finally {
      _authenticating = false;
    }
  }

  Future<UserModel> register({
    required String name,
    required String email,
    required String password,
    String? emailCode,
  }) async {
    if (_loggingOut || _authenticating || _user != null) {
      throw StateError('Authentication unavailable');
    }
    _authenticating = true;
    final generation = _generation;
    try {
      return await _serialize(() async {
        if (generation != _generation || _user != null) {
          throw StateError('Account changed');
        }
        final user = await _repository.register(
          name: name,
          email: email,
          password: password,
          emailCode: emailCode,
        );
        if (generation != _generation) throw StateError('Account changed');
        _user = user;
        _newAccount = true;
        notifyListeners();
        return user;
      });
    } finally {
      _authenticating = false;
    }
  }

  Future<void> logout() {
    if (_loggingOut) return Future.error(StateError('Logout in progress'));
    _loggingOut = true;
    _generation++;
    notifyListeners();
    final result = _serialize(() async {
      try {
        await _repository.logout();
        _user = null;
        _newAccount = false;
      } finally {
        _loggingOut = false;
        notifyListeners();
      }
    });
    return result;
  }
}
