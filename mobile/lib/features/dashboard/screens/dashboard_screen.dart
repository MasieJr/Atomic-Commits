import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class DashboardScreen extends StatelessWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        children: [
          const SizedBox(height: 12),

          Text(
            'Welcome back',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 6),
          const Text(
            'Manage your payments in one place.',
            style: TextStyle(color: AppColours.textSecondary),
          ),

          const SizedBox(height: 24),

          // Balance card
          Container(
            padding: const EdgeInsets.all(22),
            decoration: BoxDecoration(
              color: AppColours.primary,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Available balance',
                  style: TextStyle(color: Colors.white70),
                ),
                const SizedBox(height: 10),
                const Text(
                  'Balance unavailable',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 25,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'Your wallet balance will appear here.',
                  style: TextStyle(color: Colors.white70, fontSize: 12),
                ),
              ],
            ),
          ),

          const SizedBox(height: 28),

          Text('Quick actions', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 14),

          Row(
            children: [
              Expanded(
                child: _ActionButton(
                  label: 'Send',
                  description: 'Make a payment',
                  icon: Icons.arrow_upward_rounded,
                  onPressed: () => context.push(AppRoutes.payer),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: _ActionButton(
                  label: 'Receive',
                  description: 'Collect a payment',
                  icon: Icons.arrow_downward_rounded,
                  onPressed: () => context.push(AppRoutes.merchant),
                ),
              ),
            ],
          ),

          const SizedBox(height: 30),

          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Recent transactions',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              TextButton(
                onPressed: () => context.go(AppRoutes.activity),
                child: const Text('See all'),
              ),
            ],
          ),

          const SizedBox(height: 8),

          const _EmptyTransactions(),

          const SizedBox(height: 28),

          Text(
            "Today's overview",
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 14),

          Card(
            color: AppColours.surfaceMuted,
            child: const Padding(
              padding: EdgeInsets.all(18),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _OverviewItem(
                    label: 'Payments sent',
                    value: '0',
                    icon: Icons.arrow_upward_rounded,
                  ),
                  _OverviewItem(
                    label: 'Payments received',
                    value: '0',
                    icon: Icons.arrow_downward_rounded,
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 20),
        ],
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final String label;
  final String description;
  final IconData icon;
  final VoidCallback onPressed;

  const _ActionButton({
    required this.label,
    required this.description,
    required this.icon,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 115,
      child: ElevatedButton(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          padding: const EdgeInsets.all(16),
          alignment: Alignment.centerLeft,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 26),
            const SizedBox(height: 10),
            Text(
              label,
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
            ),
            Text(description, style: const TextStyle(fontSize: 11)),
          ],
        ),
      ),
    );
  }
}

class _EmptyTransactions extends StatelessWidget {
  const _EmptyTransactions();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 16),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).dividerColor),
        borderRadius: BorderRadius.circular(14),
      ),
      child: const Column(
        children: [
          Icon(
            Icons.receipt_long_outlined,
            size: 36,
            color: AppColours.textSecondary,
          ),
          SizedBox(height: 10),
          Text(
            'No transactions yet',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          SizedBox(height: 5),
          Text(
            'Your recent payments will appear here.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColours.textSecondary, fontSize: 12),
          ),
        ],
      ),
    );
  }
}

class _OverviewItem extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const _OverviewItem({
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: AppColours.primary),
        const SizedBox(height: 8),
        Text(
          value,
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
        ),
        Text(
          label,
          style: const TextStyle(fontSize: 12, color: AppColours.textSecondary),
        ),
      ],
    );
  }
}
