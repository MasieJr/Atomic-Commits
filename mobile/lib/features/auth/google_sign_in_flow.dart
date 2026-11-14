import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

import 'models/user_model.dart';

enum GoogleSignInPhase {
  idle,
  preparing,
  openBrowser,
  waiting,
  linking,
  submitting,
  finishing,
  finished,
  error,
}

/// An in-memory, single-use OAuth attempt. Never add logging interceptors.
class GoogleSignInFlow extends ChangeNotifier {
  GoogleSignInFlow({required Uri apiOrigin, required this.onComplete})
    : _dio = Dio(
        BaseOptions(
          baseUrl: apiOrigin.origin,
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 20),
          followRedirects: false,
          validateStatus: (_) => true,
          headers: {'Content-Type': 'application/json'},
        ),
      ) {
    final localHttp =
        !kReleaseMode &&
        apiOrigin.scheme == 'http' &&
        (apiOrigin.host == 'localhost' ||
            apiOrigin.host == '127.0.0.1' ||
            apiOrigin.host == '::1');
    if ((apiOrigin.scheme != 'https' && !localHttp) ||
        apiOrigin.host.isEmpty ||
        apiOrigin.userInfo.isNotEmpty ||
        apiOrigin.hasQuery ||
        apiOrigin.hasFragment ||
        (apiOrigin.path.isNotEmpty && apiOrigin.path != '/')) {
      checkingAvailability = false;
      message = 'Google sign-in requires a secure server connection.';
      return;
    }
    _canCheckAvailability = true;
    unawaited(_checkAvailability());
  }

  final Future<void> Function(UserModel user, String token) onComplete;
  final Dio _dio;
  bool available = false;
  bool checkingAvailability = true;
  GoogleSignInPhase phase = GoogleSignInPhase.idle;
  String? message;
  int? attemptsRemaining;
  DateTime? linkRetryAt;
  String? _id;
  String? _secret;
  Uri? _authorizationUrl;
  final Stopwatch _clock = Stopwatch()..start();
  Duration? _deadline;
  DateTime? _nextPoll;
  Timer? _timer;
  int _generation = 0;
  bool _disposed = false;
  bool _active = true;
  bool _polling = false;
  bool _canCheckAvailability = false;
  bool _availabilityInFlight = false;
  Timer? _availabilityTimer;
  Duration _interval = const Duration(seconds: 2);
  static const _base = '/api/auth/google/attempts';
  static const _unavailableMessage =
      'Google sign-in is currently unavailable. Please use password sign-in.';

  bool get canCancel => !_polling && phase != GoogleSignInPhase.finishing;

  Future<void> _checkAvailability() async {
    if (_disposed || !_canCheckAvailability || _availabilityInFlight) return;
    _availabilityTimer?.cancel();
    _availabilityTimer = null;
    _availabilityInFlight = true;
    var enabled = false;
    try {
      final response = await _dio.get<dynamic>('/api/auth/google/status');
      enabled =
          response.statusCode == 200 && _body(response)['enabled'] == true;
    } catch (_) {
      enabled = false;
    }
    _availabilityInFlight = false;
    if (_disposed) return;
    available = enabled;
    checkingAvailability = false;
    if (!available) {
      message = _unavailableMessage;
      if (_active) {
        _availabilityTimer?.cancel();
        _availabilityTimer = Timer(
          const Duration(seconds: 30),
          _checkAvailability,
        );
      }
    } else if (message == _unavailableMessage) {
      message = null;
    }
    notifyListeners();
  }

  void _update(GoogleSignInPhase value, [String? text]) {
    if (_disposed) return;
    phase = value;
    message = text;
    notifyListeners();
  }

  bool _current(int generation) => !_disposed && generation == _generation;

  Future<Response<dynamic>> _post(String path, Map<String, dynamic> body) =>
      _dio.post<dynamic>(path, data: body);

  Map<String, dynamic> _body(Response<dynamic> response) {
    final data = response.data;
    if (data is Map<String, dynamic>) return data;
    return <String, dynamic>{};
  }

  Duration _retry(
    Response<dynamic> response,
    Map<String, dynamic> body, {
    Duration minimum = const Duration(seconds: 2),
  }) {
    final header = response.headers.value('retry-after');
    final seconds =
        int.tryParse(header ?? '') ??
        (body['retryAfterSeconds'] is num
            ? (body['retryAfterSeconds'] as num).ceil()
            : 0);
    var delay = Duration(seconds: seconds > 0 ? seconds : 0);
    if (header != null && int.tryParse(header) == null) {
      final match = RegExp(
        r'^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$',
      ).firstMatch(header);
      const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      final month = match == null ? -1 : months.indexOf(match.group(2)!);
      final date = month < 0
          ? null
          : DateTime.utc(
              int.parse(match!.group(3)!),
              month + 1,
              int.parse(match.group(1)!),
              int.parse(match.group(4)!),
              int.parse(match.group(5)!),
              int.parse(match.group(6)!),
            );
      if (date != null) delay = date.difference(DateTime.now().toUtc());
    }
    return delay > minimum ? delay : minimum;
  }

  Future<void> start() async {
    if (!available) return;
    if (phase != GoogleSignInPhase.idle &&
        phase != GoogleSignInPhase.error &&
        phase != GoogleSignInPhase.finished) {
      return;
    }
    final generation = ++_generation;
    final requestedAt = _clock.elapsed;
    _update(GoogleSignInPhase.preparing);
    try {
      final response = await _post(_base, {});
      final data = _body(response);
      final id = data['attemptId'];
      final secret = data['pollSecret'];
      final url = Uri.tryParse(
        data['authorizationUrl'] is String
            ? data['authorizationUrl'] as String
            : '',
      );
      final remaining = data['expiresInMs'];
      // If cancellation raced with start, cancel the newly created attempt too.
      if (!_current(generation)) {
        if (id is String && secret is String) {
          unawaited(_cancelRemote(id, secret));
        }
        return;
      }
      if (response.statusCode != 201 ||
          id is! String ||
          id.isEmpty ||
          secret is! String ||
          secret.isEmpty ||
          url == null ||
          url.scheme != 'https' ||
          url.host != 'accounts.google.com' ||
          url.userInfo.isNotEmpty ||
          url.hasPort ||
          url.hasFragment ||
          url.toString().contains(secret) ||
          url.queryParametersAll.values.any(
            (values) => values.any((value) => value.contains(secret)),
          ) ||
          remaining is! int ||
          remaining <= 0 ||
          remaining > 600000 ||
          requestedAt + Duration(milliseconds: remaining) <= _clock.elapsed) {
        if (id is String && secret is String) {
          unawaited(_cancelRemote(id, secret));
        }
        _update(
          GoogleSignInPhase.error,
          'Could not prepare Google sign-in. Please try again.',
        );
        return;
      }
      _id = id;
      _secret = secret;
      _authorizationUrl = url;
      _deadline = requestedAt + Duration(milliseconds: remaining);
      final interval = data['pollIntervalMs'];
      _interval = Duration(
        milliseconds: interval is num && interval > 2000
            ? interval.ceil()
            : 2000,
      );
      _update(GoogleSignInPhase.openBrowser);
      _scheduleExpiry();
    } catch (_) {
      if (_current(generation)) {
        _update(
          GoogleSignInPhase.error,
          'Could not prepare Google sign-in. Please try again.',
        );
      }
    }
  }

  /// Invoke directly from a separate button gesture, not after awaiting start().
  void openBrowser() {
    if (phase != GoogleSignInPhase.openBrowser || _authorizationUrl == null) {
      return;
    }
    if (_expired()) {
      _expire();
      return;
    }
    final generation = _generation;
    final url = _authorizationUrl!;
    _authorizationUrl = null;
    // Initiate the plugin call synchronously while the gesture is still active.
    try {
      final launch = launchUrl(url, mode: LaunchMode.externalApplication);
      _update(
        GoogleSignInPhase.waiting,
        'Waiting for Google sign-in. Return here when finished.',
      );
      unawaited(_afterLaunch(launch, generation));
    } catch (_) {
      _end('Could not open the external browser. Please try again.');
    }
  }

  Future<void> _afterLaunch(Future<bool> launch, int generation) async {
    try {
      if (!await launch) throw StateError('Launch failed');
      if (!_current(generation)) return;
      _nextPoll = DateTime.now().add(_interval);
      _schedulePoll();
    } catch (_) {
      if (_current(generation)) {
        _end('Could not open the external browser. Please try again.');
      }
    }
  }

  bool _expired() => _deadline == null || _clock.elapsed >= _deadline!;

  void _scheduleExpiry() {
    _timer?.cancel();
    if (_deadline == null) return;
    final remaining = _deadline! - _clock.elapsed;
    _timer = Timer(remaining.isNegative ? Duration.zero : remaining, _expire);
  }

  void _schedulePoll() {
    _timer?.cancel();
    if (phase != GoogleSignInPhase.waiting) return;
    if (_expired()) {
      _expire();
      return;
    }
    if (!_active || _polling) {
      _scheduleExpiry();
      return;
    }
    final now = DateTime.now();
    final pollDelay = (_nextPoll ?? now).difference(now);
    final expiryDelay = _deadline! - _clock.elapsed;
    final delay = pollDelay < expiryDelay ? pollDelay : expiryDelay;
    _timer = Timer(delay.isNegative ? Duration.zero : delay, _poll);
  }

  void setAppActive(bool active) {
    _active = active;
    if (!active) {
      _availabilityTimer?.cancel();
    } else if (!available && !checkingAvailability) {
      unawaited(_checkAvailability());
    }
    if (phase == GoogleSignInPhase.waiting) _schedulePoll();
  }

  Future<void> _poll() async {
    if (phase != GoogleSignInPhase.waiting || !_active || _polling) return;
    if (_expired()) {
      _expire();
      return;
    }
    final generation = _generation;
    final requestedAt = _clock.elapsed;
    _polling = true;
    notifyListeners();
    _nextPoll = DateTime.now().add(_interval);
    try {
      final response = await _post(
        '$_base/${Uri.encodeComponent(_id!)}/consume',
        {'pollSecret': _secret},
      );
      if (!_current(generation)) return;
      final data = _body(response);
      final status = data['status'];
      if (_expired() && !(response.statusCode == 200 && status == 'complete')) {
        _end('Google sign-in expired. Please start again.');
        return;
      }
      if (response.statusCode == 429 || status == 'rate_limited') {
        _nextPoll = DateTime.now().add(
          _retry(response, data, minimum: _interval),
        );
        _update(
          GoogleSignInPhase.waiting,
          'Too many requests. Waiting before checking again.',
        );
      } else if (response.statusCode == 202 && status == 'pending') {
        final ms = data['pollIntervalMs'];
        if (ms is num && ms > _interval.inMilliseconds) {
          _interval = Duration(milliseconds: ms.ceil());
        }
        _nextPoll = DateTime.now().add(
          _retry(response, data, minimum: _interval),
        );
      } else if (response.statusCode == 200 && status == 'link_required') {
        final remaining = data['expiresInMs'];
        if (remaining is! int || remaining <= 0 || remaining > 600000) {
          _end('Could not verify the sign-in response.');
          return;
        }
        final deadline = requestedAt + Duration(milliseconds: remaining);
        if (deadline < _deadline!) _deadline = deadline;
        if (_expired()) {
          _end('Google sign-in expired. Please start again.');
          return;
        }
        attemptsRemaining = data['attemptsRemaining'] is int
            ? data['attemptsRemaining'] as int
            : null;
        _update(GoogleSignInPhase.linking);
        _scheduleExpiry();
      } else if (response.statusCode == 200 && status == 'complete') {
        final token = data['token'];
        final user = data['user'];
        if (token is! String ||
            token.isEmpty ||
            user is! Map<String, dynamic>) {
          _end('Could not verify the sign-in response. Please start again.');
          return;
        }
        final parsed = UserModel.fromJson(user);
        _clear();
        _update(GoogleSignInPhase.finishing, 'Finishing sign-in...');
        try {
          await onComplete(parsed, token);
          _update(GoogleSignInPhase.finished);
        } catch (_) {
          _update(
            GoogleSignInPhase.error,
            'Could not save your sign-in. Please start Google sign-in again.',
          );
        }
      } else {
        _end(_failureMessage(data));
      }
    } catch (_) {
      if (_current(generation)) {
        _end('Sign-in could not be completed. Please start again.');
      }
    } finally {
      if (_current(generation)) {
        _polling = false;
        notifyListeners();
        if (phase == GoogleSignInPhase.waiting) _schedulePoll();
      }
    }
  }

  String _failureMessage(Map<String, dynamic> data) {
    if (data['code'] == 'link_attempts_exhausted') {
      return 'Too many password attempts. Use password sign-in or account recovery.';
    }
    if (data['code'] == 'link_conflict') {
      return 'This Google account could not be connected. Use your existing sign-in or contact support.';
    }
    if (data['status'] == 'consumed') {
      return 'This sign-in was already used. Please start again.';
    }
    if (data['status'] == 'expired' ||
        data['code'] == 'GOOGLE_ATTEMPT_EXPIRED') {
      return 'Google sign-in expired. Please start again.';
    }
    return 'Google sign-in did not complete. Please try again.';
  }

  Future<void> link(String password) async {
    if (phase != GoogleSignInPhase.linking ||
        (linkRetryAt?.isAfter(DateTime.now()) ?? false)) {
      return;
    }
    if (_expired()) {
      _expire();
      return;
    }
    if (password.length < 8 || utf8.encode(password).length > 72) {
      _update(
        GoogleSignInPhase.linking,
        'Enter your Atomic Commits password (8 characters minimum, 72 bytes maximum).',
      );
      return;
    }
    final generation = _generation;
    linkRetryAt = DateTime.now().add(const Duration(seconds: 2));
    _update(GoogleSignInPhase.submitting);
    try {
      final response = await _post('$_base/${Uri.encodeComponent(_id!)}/link', {
        'pollSecret': _secret,
        'password': password,
        'confirmLink': true,
      });
      if (!_current(generation)) return;
      if (_expired()) {
        _expire();
        return;
      }
      final data = _body(response);
      if (response.statusCode == 200 && data['status'] == 'ready') {
        _update(GoogleSignInPhase.waiting, 'Checking your sign-in.');
        _nextPoll = DateTime.now().add(_interval);
        _schedulePoll();
      } else if (response.statusCode == 401 &&
          data['status'] == 'invalid_password') {
        attemptsRemaining = data['attemptsRemaining'] is int
            ? data['attemptsRemaining'] as int
            : null;
        _update(
          GoogleSignInPhase.linking,
          'Incorrect Atomic Commits password. Wait two seconds before trying again.',
        );
      } else if (response.statusCode == 429) {
        linkRetryAt = DateTime.now().add(_retry(response, data));
        _update(
          GoogleSignInPhase.linking,
          'Too many attempts. Wait before trying again, or use password sign-in.',
        );
      } else {
        _end(_failureMessage(data));
      }
    } catch (_) {
      if (_current(generation)) {
        // The server may have committed the link despite a lost response.
        _update(
          GoogleSignInPhase.waiting,
          'Checking whether the connection completed.',
        );
        _nextPoll = DateTime.now().add(_interval);
        _schedulePoll();
      }
    }
  }

  void cancel() {
    if (!canCancel) return;
    _clear(cancelRemote: true);
    _update(GoogleSignInPhase.idle);
  }

  void _expire() {
    if (_polling || phase == GoogleSignInPhase.finishing) return;
    _end('Google sign-in expired. Please start again.');
  }

  void _end(String text) {
    _clear(cancelRemote: true);
    _update(GoogleSignInPhase.error, text);
  }

  Future<void> _cancelRemote(String id, String secret) async {
    try {
      await _post('$_base/${Uri.encodeComponent(id)}/cancel', {
        'pollSecret': secret,
      });
    } catch (_) {
      /* best effort */
    }
  }

  void _clear({bool cancelRemote = false}) {
    final id = _id;
    final secret = _secret;
    ++_generation;
    _timer?.cancel();
    _timer = null;
    _id = null;
    _secret = null;
    _authorizationUrl = null;
    _deadline = null;
    _nextPoll = null;
    _polling = false;
    attemptsRemaining = null;
    linkRetryAt = null;
    _interval = const Duration(seconds: 2);
    if (cancelRemote && id != null && secret != null) {
      unawaited(_cancelRemote(id, secret));
    }
  }

  @override
  void dispose() {
    _clear(cancelRemote: true);
    _availabilityTimer?.cancel();
    _disposed = true;
    super.dispose();
  }
}
