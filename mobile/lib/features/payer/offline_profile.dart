import 'dart:convert';

import 'package:atomic_commits/core/network/api_endpoints.dart';
import 'package:atomic_commits/features/payer/totp.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class OfflineCode {
  const OfflineCode(this.value, this.expiresAt);
  final String value;
  final DateTime expiresAt;
}

class OfflineProfile {
  const OfflineProfile({
    required this.prefix,
    required this.secret,
    required this.expiresAtEpochMs,
  });

  final String prefix;
  final String secret;
  final int expiresAtEpochMs;

  factory OfflineProfile.fromJson(Map<String, dynamic> packet) {
    final prefix = packet['prefix'];
    final secret = packet['secret'];
    final expires = packet['expiresAtEpochMs'];
    if (packet['version'] != 1 ||
        packet['algorithm'] != 'SHA1' ||
        packet['digits'] != 6 ||
        packet['periodSeconds'] != 30 ||
        packet['revoked'] != false ||
        prefix is! String ||
        !RegExp(r'^[A-Z0-9]{4,12}$').hasMatch(prefix) ||
        secret is! String ||
        !RegExp(r'^[A-Z2-7]{32}$').hasMatch(secret) ||
        expires is! int) {
      throw const FormatException('Invalid offline device profile.');
    }
    return OfflineProfile(
      prefix: prefix,
      secret: secret,
      expiresAtEpochMs: expires,
    );
  }

  Map<String, dynamic> toJson() => {
    'version': 1,
    'prefix': prefix,
    'secret': secret,
    'algorithm': 'SHA1',
    'digits': 6,
    'periodSeconds': 30,
    'expiresAtEpochMs': expiresAtEpochMs,
    'revoked': false,
  };

  OfflineCode codeAt(DateTime time) {
    final milliseconds = time.toUtc().millisecondsSinceEpoch;
    if (milliseconds < 0 || milliseconds >= expiresAtEpochMs) {
      throw StateError(
        'This offline profile has expired. Connect to enroll again.',
      );
    }
    final step = milliseconds ~/ 30000;
    final digits = decimalTotp(secret, step);
    final stepEnd = (step + 1) * 30000;
    final expiry = stepEnd < expiresAtEpochMs ? stepEnd : expiresAtEpochMs;
    return OfflineCode(
      '$prefix-$digits',
      DateTime.fromMillisecondsSinceEpoch(expiry, isUtc: true),
    );
  }
}

class OfflineProfileStore {
  const OfflineProfileStore();
  static const _storage = FlutterSecureStorage();

  String _key(int userId) =>
      'totp_${sha256.convert(utf8.encode(ApiEndpoints.baseUrl))}_$userId';

  Future<OfflineProfile?> read(int userId) async {
    final value = await _storage.read(key: _key(userId));
    if (value == null) return null;
    return OfflineProfile.fromJson(jsonDecode(value) as Map<String, dynamic>);
  }

  Future<void> save(int userId, OfflineProfile profile) =>
      _storage.write(key: _key(userId), value: jsonEncode(profile.toJson()));

  Future<void> delete(int userId) => _storage.delete(key: _key(userId));
}
