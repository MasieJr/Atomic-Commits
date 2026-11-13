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
      value: json['value'] as String,
      assetCode: json['assetCode'] as String,
      assetScale: (json['assetScale'] as num).toInt(),
    );
  }

  String get formatted {
    final digits = value.padLeft(assetScale + 1, '0');
    final amount = assetScale == 0
        ? digits
        : '${digits.substring(0, digits.length - assetScale)}.${digits.substring(digits.length - assetScale)}';
    return '$assetCode $amount';
  }
}

class PaymentModel {
  final String paymentId;
  final String status;
  final String? merchantName;
  final String? payerName;
  final String? providerIncomingRef;
  final String? providerOutgoingRef;
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
    this.payerName,
    this.providerIncomingRef,
    this.providerOutgoingRef,
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
      payerName: json['payerName'] as String?,
      providerIncomingRef: json['providerIncomingRef'] as String?,
      providerOutgoingRef: json['providerOutgoingRef'] as String?,
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

  bool get isCompleted =>
      status == 'SUCCEEDED' &&
      payerDebitPaid != null &&
      merchantReceivePaid != null &&
      providerIncomingRef != null;

  String get outcomeMessage {
    if (isCompleted) return 'Received ${merchantReceivePaid!.formatted}';
    if (status == 'FAILED' || status == 'REJECTED') {
      return switch (errorCode) {
        'QUOTE_EXCEEDS_LIMIT' => 'The quoted debit exceeds the payer’s per-payment maximum or remaining allowance. Use a smaller amount or approve a higher limit.',
        'PROVIDER_FAILED' => 'The provider reported that the transfer failed. Check the sender wallet and provider payment history.',
        'PROVIDER_REJECTED' => 'The provider rejected the transfer. Check the sender wallet funds and spending permission.',
        'QUOTE_FAILED' => 'A payment quote could not be obtained. Check the wallet details and try again when the provider is available.',
        'QUOTE_EXPIRED' => 'The payment quote expired before submission. Start a new checkout with a fresh code.',
        'GRANT_NOT_SPENDABLE' => 'The payer’s spending permission is unavailable or expired. Authorize a new grant.',
        _ => 'The payment failed or was rejected. Check its details and provider history before trying again.',
      };
    }
    return 'The provider has not confirmed receipt. Do not submit the same payment again.';
  }

  PaymentAmount? get displayAmount {
    if (direction == PaymentDirection.sent) {
      return payerDebitPaid ?? payerDebitQuoted;
    }

    return merchantReceivePaid ?? merchantReceiveRequested;
  }

  String get displayStatus {
    if (status == 'SUCCEEDED' && !isCompleted) return 'Confirmation incomplete';
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
