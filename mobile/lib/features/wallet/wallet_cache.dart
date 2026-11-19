import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A read-only snapshot, never an authorization to spend.
class WalletCache {
  static const _storage = FlutterSecureStorage();
  static Future<void> _pending = Future.value();
  static final Set<String> _blocked = {};

  static String _key(String origin, int userId) =>
      'wallet_read_cache_v1_${sha256.convert(utf8.encode(Uri.parse(origin).origin))}_$userId';

  static Future<T> _serialize<T>(Future<T> Function() operation) {
    final result = _pending.then((_) => operation());
    _pending = result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  /// Call on logout with the origin and user ID captured before clearing auth.
  static Future<void> purge({required String origin, required int userId}) {
    final key = _key(origin, userId);
    _blocked.add(key);
    return _serialize(() async {
      _blocked.add(key);
      await _storage.delete(key: key);
    });
  }

  static Map<String, dynamic> _wallet(Map source) => {
    'address': source['address'] is String ? source['address'] : null,
    'publicName': source['publicName'] is String ? source['publicName'] : null,
    'assetCode': source['assetCode'] is String ? source['assetCode'] : null,
    'assetScale': source['assetScale'] is int ? source['assetScale'] : null,
    'isDefaultSpending': source['isDefaultSpending'] == true,
    'isDefaultReceiving': source['isDefaultReceiving'] == true,
  };

  static Map<String, dynamic>? _amount(dynamic source) {
    if (source == null) return null;
    if (source is! Map || source['value'] is! String ||
        !RegExp(r'^\d+$').hasMatch(source['value'] as String) ||
        source['assetCode'] is! String || source['assetScale'] is! int ||
        (source['assetScale'] as int) < 0 || (source['assetScale'] as int) > 18) {
      throw const FormatException('Invalid cached amount');
    }
    return {'value': source['value'], 'assetCode': source['assetCode'],
      'assetScale': source['assetScale']};
  }

  static Map<String, dynamic> _grant(Map source) => {
    'status': source['status'] is String ? source['status'] : null,
    'authoritySource': source['authoritySource'] is String ? source['authoritySource'] : null,
    'validUntil': source['validUntil'] is String ? source['validUntil'] : null,
    for (final key in ['remaining', 'cumulativeCap', 'spent', 'reserved', 'perPaymentMaxDebit'])
      key: _amount(source[key]),
  };

  static Future<void> write({required String origin, required int userId,
    required bool Function() isCurrent, required bool Function() isAccountCurrent,
    required Map<String, dynamic>? wallet,
    required List<Map<String, dynamic>> wallets, required List<dynamic> grants}) =>
      _serialize(() async {
        if (!isCurrent()) return;
        final value = jsonEncode({
          'syncedAt': DateTime.now().toUtc().toIso8601String(),
          'wallet': wallet == null ? null : _wallet(wallet),
          'wallets': wallets.map(_wallet).toList(),
          'grants': grants.map((item) => _grant(item as Map)).toList(),
        });
        if (!isCurrent()) return;
        final key = _key(origin, userId);
        await _storage.write(key: key, value: value);
        if (!isAccountCurrent()) {
          await _storage.delete(key: key);
        } else if (isCurrent()) {
          _blocked.remove(key);
        }
      });

  static Future<Map<String, dynamic>?> read({required String origin,
    required int userId, required bool Function() isCurrent}) => _serialize(() async {
        final key = _key(origin, userId);
        if (!isCurrent() || _blocked.contains(key)) return null;
        final value = await _storage.read(key: key);
        if (!isCurrent() || _blocked.contains(key) || value == null) return null;
        try {
        final data = jsonDecode(value) as Map<String, dynamic>;
        if (DateTime.tryParse(data['syncedAt'] as String) == null) return null;
        final wallet = data['wallet'];
        final wallets = (data['wallets'] as List).map((e) => _wallet(e as Map)).toList();
        final grants = (data['grants'] as List).map((e) => _grant(e as Map)).toList();
        if (wallet != null && (wallet is! Map || wallet['address'] is! String)) return null;
        return {'syncedAt': data['syncedAt'], 'wallet': wallet == null ? null : _wallet(wallet as Map),
          'wallets': wallets, 'grants': grants};
        } catch (_) {
          return null;
        }
      });
}
