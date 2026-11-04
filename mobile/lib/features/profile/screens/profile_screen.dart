import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/router.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  Future<void> _logout(BuildContext context) async {
    try {
      await getIt<AuthController>().logout();

      if (context.mounted) {
        context.go(AppRoutes.login);
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Unable to sign out. Please try again.'),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final authController = getIt<AuthController>();
    final user = authController.user;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.screenPadding),
      children: [
        const SizedBox(height: 12),

        Text('Your profile', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 6),

        const Text(
          'Manage your account and application settings.',
          style: TextStyle(color: AppColours.textSecondary),
        ),

        const SizedBox(height: 28),

        // Account information
        Card(
          color: AppColours.surfaceMuted,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                const CircleAvatar(
                  radius: 35,
                  child: Icon(Icons.person_outline_rounded, size: 38),
                ),
                const SizedBox(height: 14),
                Text(
                  user?.name ?? 'User',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 4),
                Text(
                  user?.email ?? '',
                  style: const TextStyle(color: AppColours.textSecondary),
                ),
              ],
            ),
          ),
        ),

        const SizedBox(height: 28),

        Text('Account', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),

        _ProfileOption(
          icon: Icons.person_outline,
          title: 'Personal information',
          subtitle: 'View your account details',
          onTap: () {},
        ),

        _ProfileOption(
          icon: Icons.security_outlined,
          title: 'Security',
          subtitle: 'Manage account security',
          onTap: () {},
        ),

        _ProfileOption(
          icon: Icons.help_outline_rounded,
          title: 'Help and support',
          subtitle: 'Get help using Atomic Commits',
          onTap: () {
            showAboutDialog(
              context: context,
              applicationName: 'Atomic Commits',
              applicationVersion: '0.1.0',
            );
          },
        ),

        const SizedBox(height: 28),

        OutlinedButton.icon(
          onPressed: () => _confirmLogout(context),
          icon: const Icon(Icons.logout_rounded),
          label: const Text('Sign out'),
          style: OutlinedButton.styleFrom(
            foregroundColor: Colors.red,
            padding: const EdgeInsets.symmetric(vertical: 14),
          ),
        ),

        const SizedBox(height: 20),

        const Center(
          child: Text(
            'Atomic Commits v0.1.0',
            style: TextStyle(color: AppColours.textSecondary, fontSize: 12),
          ),
        ),
      ],
    );
  }

  void _confirmLogout(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text(
          'Are you sure you want to sign out of your account?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () {
              Navigator.pop(dialogContext);
              _logout(context);
            },
            child: const Text('Sign out', style: TextStyle(color: Colors.red)),
          ),
        ],
      ),
    );
  }
}

class _ProfileOption extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _ProfileOption({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: Icon(icon, color: AppColours.primary),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(subtitle, style: const TextStyle(fontSize: 12)),
        trailing: const Icon(Icons.chevron_right_rounded),
        onTap: onTap,
      ),
    );
  }
}
