import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:flutter/material.dart';

void showPaymentDetails(BuildContext context, PaymentModel payment) {
  final sent = payment.direction == PaymentDirection.sent;
  final party = sent ? payment.merchantName : payment.payerName;
  showModalBottomSheet<void>(
    context: context,
    builder: (context) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        child: ListView(
          shrinkWrap: true,
          children: [
            Text(
              'Payment details',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            Text('Status: ${payment.displayStatus}'),
            Text(
              'Amount: ${payment.displayAmount?.formatted ?? 'Unavailable'}',
            ),
            Text('${sent ? 'Recipient' : 'Sender'}: ${party ?? 'Unknown'}'),
            Text('Time: ${payment.displayDate?.toLocal() ?? 'Unavailable'}'),
            SelectableText('Reference: ${payment.paymentId}'),
            if (payment.providerIncomingRef != null)
              SelectableText(
                'Provider incoming: ${payment.providerIncomingRef}',
              ),
            if (payment.providerOutgoingRef != null)
              SelectableText(
                'Provider outgoing: ${payment.providerOutgoingRef}',
              ),
            if (!payment.isCompleted) Text(payment.outcomeMessage),
          ],
        ),
      ),
    ),
  );
}
