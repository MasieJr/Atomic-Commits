import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/activity/payment_controller.dart';
import 'package:atomic_commits/features/activity/payment_details.dart';
import 'package:flutter/material.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  final _controller = getIt<PaymentController>();

  @override
  void initState() {
    super.initState();
    _controller.loadPayments();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColours.paperTop,
      body: ListenableBuilder(
        listenable: _controller,
        builder: (context, _) {
          final state = _controller.state;
          return RefreshIndicator(
            onRefresh: _controller.loadPayments,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(AppSpacing.screenPadding),
              children: [
                const SizedBox(height: 12),
                Text(
                  'Activity',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 20),
                if (state is ActivityUnavailable)
                  Text(state.message)
                else if (state is ActivityAvailable) ...[
                  if (state.snapshot.cached)
                    Text(
                      'Offline activity · Last synced ${state.snapshot.syncedAt.toLocal().toString().split('.').first}',
                      style: const TextStyle(
                        color: AppColours.subtle,
                        fontSize: 12,
                      ),
                    ),
                  if (state.snapshot.payments.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 36),
                      child: Column(
                        children: [
                          Icon(
                            Icons.receipt_long_outlined,
                            color: AppColours.cobalt,
                            size: 38,
                          ),
                          SizedBox(height: 12),
                          Text('No payments yet.'),
                        ],
                      ),
                    )
                  else
                    for (final payment in state.snapshot.payments)
                      Column(
                        children: [
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: CircleAvatar(
                              backgroundColor: AppColours.paperMid,
                              foregroundColor:
                                  payment.direction == PaymentDirection.sent
                                  ? AppColours.cobalt
                                  : AppColours.eyebrow,
                              child: Icon(
                                payment.direction == PaymentDirection.sent
                                    ? Icons.arrow_outward_rounded
                                    : Icons.south_west_rounded,
                              ),
                            ),
                            title: Text(
                              payment.direction == PaymentDirection.sent
                                  ? 'To ${payment.merchantName ?? 'Unknown'}'
                                  : 'From ${payment.payerName ?? 'Unknown'}',
                            ),
                            subtitle: Text(
                              '${payment.displayAmount?.formatted ?? 'Amount unavailable'}\n${payment.displayStatus} · ${payment.displayDate?.toLocal() ?? 'Time unavailable'}',
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => showPaymentDetails(
                              context,
                              payment,
                              cachedAt: state.snapshot.cached
                                  ? state.snapshot.syncedAt
                                  : null,
                            ),
                          ),
                          const Divider(height: 1),
                        ],
                      ),
                ] else
                  const Text('Loading activity…'),
                const SizedBox(height: 20),
              ],
            ),
          );
        },
      ),
    );
  }
}
