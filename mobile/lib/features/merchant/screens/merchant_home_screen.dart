import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/core/widgets/app_header.dart';

class MerchantHomeScreen extends StatelessWidget {
  const MerchantHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const AppHeader(),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        children: [
          const SizedBox(height: 20),
          Text(
            'Collect a payment',
            style: Theme.of(context).textTheme.headlineMedium,
          ),
          const SizedBox(height: 20),
          const Text(
            "Scan payment QR code from the customer or "
            "enter their ID and code.",
            style: TextStyle(color: AppColours.textSecondary),
          ),
          const SizedBox(height: 20),
          SizedBox(
            height: 92,
            child: ElevatedButton.icon(
              onPressed: () => context.push(AppRoutes.merchantScan),
              icon: const Icon(Icons.qr_code_rounded, size: 30),
              label: const Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Scan QR', style: TextStyle(fontSize: 18)),
                  Text(
                    "Use the customer's screen",
                    style: TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 20),

          SizedBox(
            height: 92,
            child: OutlinedButton.icon(
              onPressed: () => context.push(AppRoutes.merchantEnterCode),
              icon: const Icon(Icons.keyboard_outlined, size: 28),
              label: const Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Enter code', style: TextStyle(fontSize: 18)),
                  Text(
                    'Type the ID and six digits',
                    style: TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 24),

          Card(
            color: AppColours.surfaceMuted,
            child: Padding(
              padding: const EdgeInsets.all(22),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Today',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 24),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      _stat('0', 'Payments'),
                      _stat('R0.00', 'Total collected'),
                    ],
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 36),

          const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.verified_user_outlined,
                color: AppColours.textSecondary,
              ),
              SizedBox(width: 8),
              Text(
                'Each code works once.',
                style: TextStyle(color: AppColours.textSecondary),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _stat(String value, String label) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(color: AppColours.textSecondary)),
      ],
    );
  }
}
