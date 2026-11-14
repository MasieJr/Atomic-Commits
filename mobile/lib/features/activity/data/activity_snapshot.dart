import 'package:atomic_commits/features/activity/models/payment_model.dart';

class ActivitySnapshot {
  const ActivitySnapshot({
    required this.payments,
    required this.syncedAt,
    required this.cached,
  });

  final List<PaymentModel> payments;
  final DateTime syncedAt;
  final bool cached;

  Map<String, dynamic> toJson() {
    Map<String, dynamic>? amount(PaymentAmount? value) => value == null
        ? null
        : {
            'value': value.value,
            'assetCode': value.assetCode,
            'assetScale': value.assetScale,
          };
    return {
      'syncedAt': syncedAt.toUtc().toIso8601String(),
      'payments': payments
          .map(
            (payment) => {
              'paymentId': payment.paymentId,
              'status': payment.status,
              'direction': payment.direction.name,
              'merchantName': payment.merchantName,
              'payerName': payment.payerName,
              'providerIncomingRef': payment.providerIncomingRef,
              'providerOutgoingRef': payment.providerOutgoingRef,
              'merchantReceiveRequested': amount(
                payment.merchantReceiveRequested,
              ),
              'payerDebitQuoted': amount(payment.payerDebitQuoted),
              'payerDebitPaid': amount(payment.payerDebitPaid),
              'merchantReceivePaid': amount(payment.merchantReceivePaid),
              'errorCode': payment.errorCode,
              'completedAt': payment.completedAt?.toIso8601String(),
              'createdAt': payment.createdAt?.toIso8601String(),
              'updatedAt': payment.updatedAt?.toIso8601String(),
            },
          )
          .toList(),
    };
  }

  static ActivitySnapshot? fromCache(Map<String, dynamic>? data) {
    if (data == null) return null;
    try {
      final syncedAt = DateTime.parse(data['syncedAt'] as String);
      final items = data['payments'] as List;
      if (items.length > 100) return null;
      final payments = items.map((item) {
        final json = Map<String, dynamic>.from(item as Map);
        if (json['paymentId'] is! String ||
            (json['paymentId'] as String).isEmpty ||
            json['status'] is! String) {
          throw const FormatException('Invalid cached payment');
        }
        for (final key in [
          'merchantReceiveRequested',
          'payerDebitQuoted',
          'payerDebitPaid',
          'merchantReceivePaid',
        ]) {
          final amount = json[key];
          if (amount != null &&
              (amount is! Map ||
                  amount['value'] is! String ||
                  !RegExp(r'^(0|[1-9][0-9]{0,17})$')
                      .hasMatch(amount['value'] as String) ||
                  amount['assetCode'] is! String ||
                  (amount['assetCode'] as String).isEmpty ||
                  amount['assetScale'] is! int ||
                  (amount['assetScale'] as int) < 0 ||
                  (amount['assetScale'] as int) > 18)) {
            throw const FormatException('Invalid cached amount');
          }
        }
        final direction = switch (json['direction']) {
          'sent' => PaymentDirection.sent,
          'received' => PaymentDirection.received,
          _ => throw const FormatException('Invalid cached direction'),
        };
        return PaymentModel.fromJson(json, direction: direction);
      }).toList();
      return ActivitySnapshot(
        payments: payments,
        syncedAt: syncedAt,
        cached: true,
      );
    } catch (_) {
      return null;
    }
  }
}
