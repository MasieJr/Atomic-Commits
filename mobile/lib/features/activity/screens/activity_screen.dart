import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:flutter/material.dart';

class ActivityScreen extends StatelessWidget {
  const ActivityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
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

          // Transaction filters
          Wrap(
            spacing: 8,
            children: [
              _FilterChip(label: 'All', selected: true),
              _FilterChip(label: 'Sent'),
              _FilterChip(label: 'Received'),
            ],
          ),

          const SizedBox(height: 24),

          // Empty transaction state
          Container(
            padding: const EdgeInsets.symmetric(vertical: 45, horizontal: 20),
            decoration: BoxDecoration(
              border: Border.all(color: Theme.of(context).dividerColor),
              borderRadius: BorderRadius.circular(16),
            ),
            child: const Column(
              children: [
                Icon(
                  Icons.receipt_long_outlined,
                  size: 48,
                  color: AppColours.textSecondary,
                ),
                SizedBox(height: 16),
                Text(
                  'No transactions yet',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                ),
                SizedBox(height: 8),
                Text(
                  'Your payment history will appear here '
                  'once you start sending or receiving payments.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: AppColours.textSecondary,
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  final String label;
  final bool selected;

  const _FilterChip({required this.label, this.selected = false});

  @override
  Widget build(BuildContext context) {
    return FilterChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) {},
      showCheckmark: false,
    );
  }
}
