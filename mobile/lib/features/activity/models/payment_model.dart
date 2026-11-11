enum PaymentDirection { sent, received }

class PaymentAmount {
  final String value;
  final String assetCode;
  final int assetScale;

  const PaymentAmount({
    required this.value,
    required this.assetCode,
    required this.assetScale,
  });

  factory PaymentAmount.fromJson(Map<String, dynamic> json) {
    return PaymentAmount(
      value: json['value']?.toString() ?? '0',
      assetCode: json['assetCode'] as String? ?? 'EUR',
      assetScale: (json['assetScale'] as num?)?.toInt() ?? 2,
    );
  }

  String get formatted {
    final minorUnits = int.tryParse(value) ?? 0;
    final divisor = 10.0 * (assetScale > 0 ? assetScale : 0);
    final amount =
        minorUnits /
        (assetScale == 0
            ? 1
            : (assetScale == 1
                  ? 10
                  : (assetScale == 2
                        ? 100
                        : (assetScale == 3 ? 1000 : 10000))));

    return '${assetCode == 'EUR' ? '€' : '$assetCode '}${amount.toStringAsFixed(assetScale)}';
  }
}

class PaymentModel {
  final String paymentId;
  final String status;
  final String? merchantName;
  final PaymentAmount? merchantReceiveRequested;
  final PaymentAmount? payerDebitQuoted;
  final PaymentAmount? payerDebitPaid;
  final PaymentAmount? merchantReceivePaid;
  final DateTime? completedAt;
  final String? errorCode;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final PaymentDirection direction;

  const PaymentModel({
    required this.paymentId,
    required this.status,
    required this.direction,
    this.merchantName,
    this.merchantReceiveRequested,
    this.payerDebitQuoted,
    this.payerDebitPaid,
    this.merchantReceivePaid,
    this.completedAt,
    this.errorCode,
    this.createdAt,
    this.updatedAt,
  });

  factory PaymentModel.fromJson(
    Map<String, dynamic> json, {
    required PaymentDirection direction,
  }) {
    PaymentAmount? parseAmount(String key) {
      final value = json[key];
      if (value == null) return null;

      return PaymentAmount.fromJson(Map<String, dynamic>.from(value as Map));
    }

    DateTime? parseDate(String key) {
      final value = json[key];
      return value == null ? null : DateTime.tryParse(value.toString());
    }

    return PaymentModel(
      paymentId: json['paymentId']?.toString() ?? '',
      status: json['status']?.toString() ?? 'UNKNOWN',
      direction: direction,
      merchantName: json['merchantName'] as String?,
      merchantReceiveRequested: parseAmount('merchantReceiveRequested'),
      payerDebitQuoted: parseAmount('payerDebitQuoted'),
      payerDebitPaid: parseAmount('payerDebitPaid'),
      merchantReceivePaid: parseAmount('merchantReceivePaid'),
      completedAt: parseDate('completedAt'),
      errorCode: json['errorCode'] as String?,
      createdAt: parseDate('createdAt'),
      updatedAt: parseDate('updatedAt'),
    );
  }

  bool get isCompleted => status == 'COMPLETED';

  PaymentAmount? get displayAmount {
    if (direction == PaymentDirection.sent) {
      return payerDebitPaid ?? payerDebitQuoted ?? merchantReceiveRequested;
    }

    return merchantReceivePaid ?? merchantReceiveRequested;
  }

  String get displayStatus {
    return status
        .replaceAll('_', ' ')
        .toLowerCase()
        .split(' ')
        .map(
          (word) => word.isEmpty
              ? word
              : '${word[0].toUpperCase()}${word.substring(1)}',
        )
        .join(' ');
  }

  DateTime? get displayDate => completedAt ?? createdAt;
}
