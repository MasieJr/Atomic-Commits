import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class MerchantHomeScreen extends StatelessWidget {
  const MerchantHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Receive payment')),
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
            'Activate checkout with your verified wallet, enter the purchase amount and type the customer’s payment code.',
            style: TextStyle(color: AppColours.textSecondary),
          ),
          const SizedBox(height: 24),
          SizedBox(
            height: 92,
            child: ElevatedButton.icon(
              onPressed: () => context.push(AppRoutes.merchantEnterCode),
              icon: const Icon(Icons.keyboard_outlined, size: 28),
              label: const Text('Open merchant checkout'),
            ),
          ),
          const SizedBox(height: 24),
          const Text(
            'The merchant device must be online. Each code can be used once.',
            style: TextStyle(color: AppColours.textSecondary),
          ),
        ],
      ),
    );
  }
}
