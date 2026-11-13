import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
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
            'Welcome back, ${getIt<AuthController>().user?.name ?? 'there'}',
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
                  'Your wallet',
                  style: TextStyle(color: Colors.white70),
                ),
                const SizedBox(height: 10),
                const Text(
                  'Manage your wallet',
                  style: TextStyle(
                    color: Colors.white,
                    fontSize: 25,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  'View your actual balance in the provider dashboard.',
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

          OutlinedButton(
            onPressed: () => context.go(AppRoutes.activity),
            child: const Text('Open payment history'),
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
