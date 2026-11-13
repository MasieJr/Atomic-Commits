import 'dart:convert';

import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ActivitySnapshot {
  const ActivitySnapshot(this.payments, this.syncedAt, {required this.cached});

  final List<PaymentModel> payments;
  final DateTime syncedAt;
  final bool cached;
}

class ActivityCache {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();
  static Future<void> _pending = Future.value();
  static final Set<String> _blocked = {};

  Future<void> _serialize(Future<void> Function() operation) {
    final result = _pending.then((_) => operation());
    _pending = result.catchError((Object _) {});
    return result;
  }

  String _key(String origin, int userId) =>
      'activity_v1_${sha256.convert(utf8.encode(jsonEncode([Uri.parse(origin).origin, userId])))}';

  Future<void> purge(String origin, int userId) {
    final key = _key(origin, userId);
    _blocked.add(key);
    return _serialize(() async {
      _blocked.add(key);
      await _storage.delete(key: key);
    });
  }

  Future<void> write(String origin, int userId, ActivitySnapshot snapshot,
      {required bool Function() isCurrent}) async {
    Map<String, dynamic>? amount(PaymentAmount? value) => value == null
        ? null
        : {'value': value.value, 'assetCode': value.assetCode, 'assetScale': value.assetScale};
    final value = jsonEncode({
        'syncedAt': snapshot.syncedAt.toUtc().toIso8601String(),
        'payments': snapshot.payments.map((p) => {
          'paymentId': p.paymentId, 'status': p.status, 'direction': p.direction.name,
          'merchantName': p.merchantName, 'payerName': p.payerName,
          'providerIncomingRef': p.providerIncomingRef, 'providerOutgoingRef': p.providerOutgoingRef,
          'merchantReceiveRequested': amount(p.merchantReceiveRequested),
          'payerDebitQuoted': amount(p.payerDebitQuoted), 'payerDebitPaid': amount(p.payerDebitPaid),
          'merchantReceivePaid': amount(p.merchantReceivePaid), 'errorCode': p.errorCode,
          'completedAt': p.completedAt?.toIso8601String(), 'createdAt': p.createdAt?.toIso8601String(),
          'updatedAt': p.updatedAt?.toIso8601String(),
        }).toList(),
      });
    await _serialize(() async {
      if (!isCurrent()) return;
      final key = _key(origin, userId);
      await _storage.write(key: key, value: value);
      if (isCurrent()) _blocked.remove(key);
    });
  }

  Future<ActivitySnapshot?> read(String origin, int userId) async {
    try {
      final key = _key(origin, userId);
      if (_blocked.contains(key)) return null;
      final raw = await _storage.read(key: key);
      if (_blocked.contains(key)) return null;
      if (raw == null) return null;
      final data = jsonDecode(raw) as Map<String, dynamic>;
      final syncedAt = DateTime.parse(data['syncedAt'] as String);
      final payments = (data['payments'] as List).map((item) {
        final json = Map<String, dynamic>.from(item as Map);
        if (json['paymentId'] is! String || json['status'] is! String) {
          throw const FormatException('Invalid payment');
        }
        for (final key in ['merchantReceiveRequested', 'payerDebitQuoted', 'payerDebitPaid', 'merchantReceivePaid']) {
          final amount = json[key];
          if (amount != null && (amount is! Map || amount['value'] is! String ||
              !RegExp(r'^\d+$').hasMatch(amount['value'] as String) ||
              amount['assetCode'] is! String || amount['assetScale'] is! int ||
              (amount['assetScale'] as int) < 0 || (amount['assetScale'] as int) > 18)) {
            throw const FormatException('Invalid payment amount');
          }
        }
        final direction = switch (json['direction']) {
          'sent' => PaymentDirection.sent,
          'received' => PaymentDirection.received,
          _ => throw const FormatException('Invalid activity direction'),
        };
        return PaymentModel.fromJson(json, direction: direction);
      }).toList();
      return ActivitySnapshot(payments, syncedAt, cached: true);
    } catch (_) {
      return null;
    }
  }
}
