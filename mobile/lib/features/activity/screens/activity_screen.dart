import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/features/activity/data/payment_repository.dart';
import 'package:atomic_commits/features/activity/models/payment_model.dart';
import 'package:atomic_commits/features/activity/payment_details.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:flutter/material.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  late Future<List<PaymentModel>> _payments;
  final _auth = getIt<AuthController>();
  int? _ownerId;

  @override
  void initState() {
    super.initState();
    _ownerId = _auth.user?.id;
    _auth.addListener(_accountChanged);
    _load();
  }

  @override
  void dispose() {
    _auth.removeListener(_accountChanged);
    super.dispose();
  }

  void _accountChanged() {
    if (_ownerId == _auth.user?.id) return;
    setState(() {
      _ownerId = _auth.user?.id;
      _load();
    });
  }

  void _load() => _payments = _ownerId == null
      ? Future.value(const <PaymentModel>[])
      : getIt<PaymentRepository>().getPayments();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColours.paperTop,
      body: FutureBuilder<List<PaymentModel>>(
        key: ValueKey(_ownerId),
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
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(AppSpacing.screenPadding),
            children: [
              const SizedBox(height: 12),
              Text(
                'Activity',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 20),
              if (snapshot.connectionState != ConnectionState.done)
                const Text('Loading activity…')
              else if (snapshot.hasError)
                const Text('Activity unavailable. Pull to refresh.')
              else if (snapshot.data!.isEmpty)
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
                for (final payment in snapshot.data!)
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
                        onTap: () => showPaymentDetails(context, payment),
                      ),
                      const Divider(height: 1),
                    ],
                  ),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }
}
