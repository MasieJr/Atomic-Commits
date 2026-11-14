import 'dart:async';

import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/network/network_errors.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/activity/data/activity_snapshot.dart';
import 'package:atomic_commits/features/activity/data/payment_repository.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

sealed class ActivityState {
  const ActivityState();
}

class ActivityIdle extends ActivityState {
  const ActivityIdle();
}

class ActivityLoading extends ActivityState {
  const ActivityLoading();
}

class ActivityAvailable extends ActivityState {
  const ActivityAvailable(this.snapshot);
  final ActivitySnapshot snapshot;
}

class ActivityUnavailable extends ActivityState {
  const ActivityUnavailable(this.message);
  final String message;
}

class PaymentController extends ChangeNotifier {
  PaymentController(this._repository, this._storage, this._auth, this._api) {
    _auth.addListener(_authChanged);
    _authChanged();
  }

  final PaymentRepository _repository;
  final TokenStorage _storage;
  final AuthController _auth;
  final ApiClient _api;
  ActivityState _state = const ActivityIdle();
  int? _ownerId;
  int _sessionGeneration = -1;
  bool _loggingOut = false;
  bool _cacheBlocked = false;
  bool _disposed = false;
  int _revision = 0;
  Future<void>? _inFlight;

  ActivityState get state => _state;

  void _authChanged() {
    final owner = _auth.user?.id;
    final generation = _auth.sessionGeneration;
    final loggingOut = _auth.isLoggingOut;
    if (owner == _ownerId &&
        generation == _sessionGeneration &&
        loggingOut == _loggingOut) {
      return;
    }
    final failedLogout =
        _loggingOut && !loggingOut && owner != null && owner == _ownerId;
    _ownerId = owner;
    _sessionGeneration = generation;
    _loggingOut = loggingOut;
    _cacheBlocked = loggingOut || (failedLogout && _cacheBlocked);
    _revision++;
    _inFlight = null;
    _state = const ActivityIdle();
    notifyListeners();
    if (owner != null && !loggingOut) unawaited(loadPayments());
  }

  Future<void> loadPayments() {
    final owner = _ownerId;
    if (_disposed || owner == null || _loggingOut) return Future.value();
    if (_inFlight case final pending?) return pending;
    final generation = _sessionGeneration;
    final revision = ++_revision;
    final origin = _api.dio.options.baseUrl;
    final result = Future<void>.microtask(
      () => _load(owner, generation, revision, origin),
    );
    _inFlight = result;
    return result.whenComplete(() {
      if (identical(_inFlight, result)) _inFlight = null;
    });
  }

  bool _current(int owner, int generation, int revision, String origin) =>
      !_disposed &&
      _auth.user?.id == owner &&
      !_auth.isLoggingOut &&
      _auth.sessionGeneration == generation &&
      _revision == revision &&
      _api.dio.options.baseUrl == origin;

  Future<void> _load(
    int owner,
    int generation,
    int revision,
    String origin,
  ) async {
    bool current() => _current(owner, generation, revision, origin);
    if (!current()) return;
    _state = const ActivityLoading();
    notifyListeners();
    StoredSession? session;
    try {
      session = await _storage.getSession();
    } catch (_) {
      // Live activity can still load if secure storage is unavailable.
    }
    if (!current()) return;
    final token = session?.user?['id'] == owner ? session?.token : null;
    try {
      final payments = await _repository.getPayments();
      if (!current()) return;
      _cacheBlocked = false;
      final snapshot = ActivitySnapshot(
        payments: payments,
        syncedAt: DateTime.now().toUtc(),
        cached: false,
      );
      _state = ActivityAvailable(snapshot);
      notifyListeners();
      if (token != null) {
        try {
          await _storage.setActivity(
            token: token,
            userId: owner,
            activity: snapshot.toJson(),
            isCurrent: current,
          );
        } catch (_) {
          // A cache failure must not hide a successful response.
        }
      }
    } on DioException catch (error) {
      if (!current()) return;
      final status = error.response?.statusCode;
      if (status == 401 || status == 403) {
        _cacheBlocked = true;
        _state = const ActivityUnavailable(
          'Activity access was rejected. Pull down to try again.',
        );
        notifyListeners();
        try {
          final stored = session ?? await _storage.getSession();
          if (stored?.user?['id'] == owner) {
            await _storage.setActivity(
              token: stored!.token,
              userId: owner,
              activity: null,
              isCurrent: current,
            );
          }
        } catch (_) {
          if (current()) {
            _state = const ActivityUnavailable(
              'Offline activity could not be cleared. Sign out and try again.',
            );
            notifyListeners();
          }
        }
        return;
      }
      final cached = isOfflineFailure(error) && !_cacheBlocked && token != null
          ? ActivitySnapshot.fromCache(session?.activity)
          : null;
      _state = cached == null
          ? const ActivityUnavailable(
              'Activity unavailable. Pull down to try again.',
            )
          : ActivityAvailable(cached);
      notifyListeners();
    } catch (_) {
      if (!current()) return;
      _state = const ActivityUnavailable(
        'Activity unavailable. Pull down to try again.',
      );
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _revision++;
    _auth.removeListener(_authChanged);
    super.dispose();
  }
}
