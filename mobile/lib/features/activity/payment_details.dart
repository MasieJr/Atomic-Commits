import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:flutter/material.dart';

void showPaymentDetails(BuildContext context, PaymentModel payment) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (context) => SafeArea(
      child: FractionallySizedBox(
        heightFactor: 0.9,
        child: PaymentReceipt(payment: payment),
      ),
    ),
  );
}

/// A receipt suitable for a screen, a list, or a bottom sheet.
class PaymentReceipt extends StatelessWidget {
  const PaymentReceipt({
    super.key,
    required this.payment,
    this.scrollable = true,
  });

  final PaymentModel payment;
  final bool scrollable;

  static const _cream = Color(0xFFFFF8E9);
  static const _cobalt = Color(0xFF193CA6);
  static const _orange = Color(0xFFF27A36);
  static const _ink = Color(0xFF182347);

  @override
  Widget build(BuildContext context) {
    final sent = payment.direction == PaymentDirection.sent;
    final completed = payment.isCompleted;
    final failed = payment.status == 'FAILED' || payment.status == 'REJECTED';
    final party = sent ? payment.merchantName : payment.payerName;
    final paid = sent ? payment.payerDebitPaid : payment.merchantReceivePaid;
    final debit = payment.payerDebitPaid;
    final received = payment.merchantReceivePaid;
    final differentAmounts =
        debit != null &&
        received != null &&
        (debit.value != received.value ||
            debit.assetCode != received.assetCode ||
            debit.assetScale != received.assetScale);
    final date = completed
        ? (payment.completedAt ?? payment.createdAt)
        : payment.createdAt;

    final content = Padding(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: _cobalt,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Icon(
                  sent ? Icons.north_east : Icons.south_west,
                  color: _cream,
                  size: 20,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  completed ? 'PAYMENT RECEIPT' : 'PAYMENT STATUS',
                  style: const TextStyle(
                    color: _cobalt,
                    fontWeight: FontWeight.w800,
                    fontSize: 12,
                    letterSpacing: 1.5,
                  ),
                ),
              ),
              Flexible(
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: completed
                        ? _cobalt
                        : (failed ? const Color(0xFF9D3027) : _ink),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    completed ? 'Completed' : payment.displayStatus,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 28),
          Text(
            completed ? (sent ? 'You sent' : 'You received') : 'Payment amount',
            style: const TextStyle(color: _ink, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            completed ? (paid?.formatted ?? 'Unavailable') : 'Not confirmed',
            style: const TextStyle(
              color: _cobalt,
              fontSize: 32,
              height: 1.1,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            '${sent ? 'To' : 'From'} ${_available(party)}',
            style: const TextStyle(
              color: _ink,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (!completed) ...[
            const SizedBox(height: 18),
            Text(
              payment.outcomeMessage,
              style: const TextStyle(color: _ink, height: 1.4),
            ),
          ],
          const SizedBox(height: 24),
          Container(height: 3, color: _orange),
          const SizedBox(height: 16),
          const Text(
            'TRANSACTION DETAILS',
            style: TextStyle(
              color: _cobalt,
              fontSize: 11,
              letterSpacing: 1.3,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 8),
          if (completed && differentAmounts) ...[
            _ReceiptRow(label: 'Payer debited', value: debit!.formatted),
            _ReceiptRow(label: 'Merchant received', value: received!.formatted),
          ],
          if (!completed) ...[
            if (payment.payerDebitQuoted != null)
              _ReceiptRow(
                label: 'Quoted payer debit',
                value: payment.payerDebitQuoted!.formatted,
              ),
            if (payment.merchantReceiveRequested != null)
              _ReceiptRow(
                label: 'Requested merchant amount',
                value: payment.merchantReceiveRequested!.formatted,
              ),
            if (debit != null)
              _ReceiptRow(
                label: 'Reported payer debit (unconfirmed)',
                value: debit.formatted,
              ),
            if (received != null)
              _ReceiptRow(
                label: 'Reported merchant receipt (unconfirmed)',
                value: received.formatted,
              ),
          ],
          _ReceiptRow(
            label: completed && payment.completedAt != null
                ? 'Completed at'
                : 'Created at',
            value: date == null ? 'Unavailable' : _localTime(date),
          ),
          _ReceiptRow(
            label: 'Payment reference',
            value: _available(payment.paymentId),
          ),
          if (payment.providerIncomingRef?.trim().isNotEmpty == true)
            _ReceiptRow(
              label: 'Provider incoming',
              value: payment.providerIncomingRef!,
            ),
          if (payment.providerOutgoingRef?.trim().isNotEmpty == true)
            _ReceiptRow(
              label: 'Provider outgoing',
              value: payment.providerOutgoingRef!,
            ),
        ],
      ),
    );
    return Material(
      color: _cream,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(28)),
      clipBehavior: Clip.antiAlias,
      child: scrollable ? SingleChildScrollView(child: content) : content,
    );
  }

  static String _localTime(DateTime date) {
    final local = date.toLocal();
    final offset = local.timeZoneOffset;
    final minutes = offset.inMinutes.abs();
    final sign = offset.isNegative ? '-' : '+';
    final hours = (minutes ~/ 60).toString().padLeft(2, '0');
    final remainder = (minutes % 60).toString().padLeft(2, '0');
    return '${local.toIso8601String().replaceFirst('T', ' ')} ${local.timeZoneName} (UTC$sign$hours:$remainder)';
  }

  static String _available(String? value) =>
      value == null || value.trim().isEmpty ? 'Unavailable' : value;
}

class _ReceiptRow extends StatelessWidget {
  const _ReceiptRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(color: Color(0xFF67718A), fontSize: 12),
          ),
          const SizedBox(height: 3),
          SelectableText(
            value,
            style: const TextStyle(
              color: PaymentReceipt._ink,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
