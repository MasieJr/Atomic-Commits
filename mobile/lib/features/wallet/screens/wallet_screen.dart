import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:flutter/material.dart';

class WalletScreen extends StatelessWidget {
  const WalletScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        children: [
          const SizedBox(height: 12),

          Text('Your wallet', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 6),

          const Text(
            'Manage your payment authorisations and devices.',
            style: TextStyle(color: AppColours.textSecondary),
          ),

          const SizedBox(height: 24),

          // Wallet overview
          Card(
            color: AppColours.surfaceMuted,
            child: const Padding(
              padding: EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.account_balance_wallet_outlined,
                    size: 30,
                    color: AppColours.primary,
                  ),
                  SizedBox(height: 14),
                  Text(
                    'Wallet overview',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  SizedBox(height: 6),
                  Text(
                    'Your payment wallet is ready to use.',
                    style: TextStyle(
                      color: AppColours.textSecondary,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 28),

          Text(
            'Payment management',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 12),

          _WalletOption(
            icon: Icons.verified_user_outlined,
            title: 'Payment authorisations',
            description: 'View and manage approved payment grants.',
            onTap: () {
              _showComingSoon(context, 'Payment authorisations');
            },
          ),

          _WalletOption(
            icon: Icons.speed_outlined,
            title: 'Spending limits',
            description: 'Manage your authorised payment limits.',
            onTap: () {
              _showComingSoon(context, 'Spending limits');
            },
          ),

          const SizedBox(height: 24),

          Text('Devices', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),

          _WalletOption(
            icon: Icons.smartphone_outlined,
            title: 'Registered devices',
            description: 'Manage devices linked to your wallet.',
            onTap: () {
              _showComingSoon(context, 'Registered devices');
            },
          ),

          const SizedBox(height: 20),
        ],
      ),
    );
  }

  void _showComingSoon(BuildContext context, String feature) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('$feature will be available soon.')));
  }
}

class _WalletOption extends StatelessWidget {
  final IconData icon;
  final String title;
  final String description;
  final VoidCallback onTap;

  const _WalletOption({
    required this.icon,
    required this.title,
    required this.description,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: Icon(icon, color: AppColours.primary, size: 26),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(description, style: const TextStyle(fontSize: 12)),
        trailing: const Icon(Icons.chevron_right_rounded),
        onTap: onTap,
      ),
    );
  }
}
