import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/features/activity/data/payment_repository.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:flutter/material.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  late Future<List<PaymentModel>> _payments;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() => _payments = getIt<PaymentRepository>().getPayments();

  void _details(PaymentModel payment) {
    final party = payment.direction == PaymentDirection.sent
        ? payment.merchantName
        : payment.payerName;
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
              Text(
                '${payment.direction == PaymentDirection.sent ? 'Recipient' : 'Sender'}: ${party ?? 'Unknown'}',
              ),
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: FutureBuilder<List<PaymentModel>>(
        future: _payments,
        builder: (context, snapshot) => RefreshIndicator(
          onRefresh: () async {
            setState(_load);
            try {
              await _payments;
            } catch (_) {
              // FutureBuilder displays the refresh error.
            }
          },
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.screenPadding),
            children: [
              const SizedBox(height: 12),
              Text(
                'Your transactions',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 6),
              const Text(
                'Track your sent and received payments.',
                style: TextStyle(color: AppColours.textSecondary),
              ),
              const SizedBox(height: 24),
              if (snapshot.connectionState != ConnectionState.done)
                const Center(child: CircularProgressIndicator())
              else if (snapshot.hasError)
                const Text(
                  'Payment history is unavailable. Check your connection and refresh.',
                )
              else if (snapshot.data!.isEmpty)
                const Text('No transactions yet.')
              else
                for (final payment in snapshot.data!)
                  Card(
                    child: ListTile(
                      leading: Icon(
                        payment.direction == PaymentDirection.sent
                            ? Icons.arrow_upward
                            : Icons.arrow_downward,
                      ),
                      title: Text(
                        payment.displayAmount?.formatted ??
                            'Amount unavailable',
                      ),
                      subtitle: Text(
                        '${payment.direction == PaymentDirection.sent ? 'To ${payment.merchantName ?? 'Unknown'}' : 'From ${payment.payerName ?? 'Unknown'}'}\n${payment.displayStatus} · ${payment.displayDate?.toLocal() ?? 'Time unavailable'}',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => _details(payment),
                    ),
                  ),
              const SizedBox(height: 20),
              TextButton.icon(
                onPressed: () => setState(_load),
                icon: const Icon(Icons.refresh),
                label: const Text('Refresh'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
