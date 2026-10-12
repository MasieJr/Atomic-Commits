import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../app/router.dart';
import '../../../../app/theme/app_colours.dart';
import '../../../../app/theme/app_spacing.dart';
import '../../../../core/widgets/app_header.dart';

class PayerHomeScreen extends StatefulWidget {
  const PayerHomeScreen({super.key});

  @override
  State<PayerHomeScreen> createState() => _PayerHomeScreenState();
}

class _PayerHomeScreenState extends State<PayerHomeScreen> {
  int validityMinutes = 5;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const AppHeader(),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        children: [
          const Align(
            alignment: Alignment.centerLeft,
            child: Chip(
              avatar: Icon(Icons.wifi, size: 18, color: AppColours.primary),
              label: Text('Online · Ready to pay'),
            ),
          ),

          const SizedBox(height: 12),

          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Your payment code'),
                      Text(
                        '● Active',
                        style: TextStyle(color: AppColours.success),
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  const Text('Your ID  7K3M'),
                  const SizedBox(height: 4),
                  Text(
                    '482 916',
                    style: Theme.of(context).textTheme.displayLarge,
                  ),
                  const Divider(height: 32),
                  const Row(
                    children: [
                      Icon(
                        Icons.timer_outlined,
                        color: AppColours.primary,
                        size: 34,
                      ),
                      SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          'Valid for 3:55\n'
                          'One payment only',
                        ),
                      ),
                      Icon(Icons.copy_outlined, color: AppColours.primary),
                    ],
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 16),

          OutlinedButton.icon(
            onPressed: () {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Code regeneration coming soon')),
              );
            },
            icon: const Icon(Icons.refresh),
            label: const Text('Get a new code'),
          ),

          const SizedBox(height: 8),
          const Text(
            'Getting a new code stops the old one working.',
            style: TextStyle(color: AppColours.textSecondary, fontSize: 12),
          ),

          const SizedBox(height: 24),
          const Text(
            'How long should your code last?',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 12),

          _validityOption(
            title: '5 minutes · Safer',
            subtitle: 'Less time for someone else to use it.',
            minutes: 5,
          ),

          const SizedBox(height: 8),

          _validityOption(
            title: '30 minutes · More time',
            subtitle: "Use this if you're waiting in a queue.",
            minutes: 30,
          ),

          const SizedBox(height: 24),

          Card(
            color: AppColours.surfaceMuted,
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Max per payment R50'),
                  const SizedBox(height: 12),
                  const Text('Left this month R500 of R500'),
                  const SizedBox(height: 12),
                  LinearProgressIndicator(
                    value: 1,
                    minHeight: 7,
                    borderRadius: BorderRadius.circular(10),
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 24),
          const Text('Each code works once.', textAlign: TextAlign.center),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: ElevatedButton.icon(
            onPressed: () => context.push(AppRoutes.payerQr),
            icon: const Icon(Icons.qr_code),
            label: const Text('Show to shop'),
          ),
        ),
      ),
    );
  }

  Widget _validityOption({
    required String title,
    required String subtitle,
    required int minutes,
  }) {
    final selected = validityMinutes == minutes;

    return Card(
      child: RadioListTile<int>(
        value: minutes,
        groupValue: validityMinutes,
        onChanged: (value) {
          if (value != null) {
            setState(() => validityMinutes = value);
          }
        },
        title: Text(title),
        subtitle: Text(subtitle),
        activeColor: AppColours.primary,
        selected: selected,
      ),
    );
  }
}
