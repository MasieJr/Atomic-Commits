import 'package:flutter/foundation.dart';

import 'data/auth_repository.dart';
import 'models/user_model.dart';

class AuthController extends ChangeNotifier {
  final AuthRepository _repository;

  AuthController(this._repository);

  UserModel? _user;
  bool _isInitialized = false;
  bool _newAccount = false;

  UserModel? get user => _user;
  bool get isInitialized => _isInitialized;
  bool get isAuthenticated => _user != null;
  bool get isNewAccount => _newAccount;

  Future<void> initialize() async {
    try {
      _user = await _repository.restoreSession();
    } catch (_) {
      // Keep the app usable if the server is temporarily unavailable.
      // The stored token is not deleted for network errors.
    } finally {
      _isInitialized = true;
      notifyListeners();
    }
  }

  Future<UserModel> login({
    required String email,
    required String password,
  }) async {
    final user = await _repository.login(email: email, password: password);

    _user = user;
    _newAccount = false;
    notifyListeners();

    return user;
  }

  Future<UserModel> register({
    required String name,
    required String email,
    required String password,
  }) async {
    final user = await _repository.register(
      name: name,
      email: email,
      password: password,
    );

    _user = user;
    _newAccount = true;
    notifyListeners();

    return user;
  }

  Future<void> logout() async {
    await _repository.logout();
    _user = null;
    _newAccount = false;
    notifyListeners();
  }
}
