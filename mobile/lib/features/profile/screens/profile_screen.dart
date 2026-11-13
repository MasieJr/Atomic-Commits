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
      if (context.mounted) context.go(AppRoutes.login);
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
    final user = getIt<AuthController>().user;
    final name = user?.name ?? 'User';
    final email = user?.email ?? 'No email available';

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.screenPadding),
      children: [
        const SizedBox(height: 8),
        Text(
          'Profile',
          style: Theme.of(context).textTheme.headlineSmall
              ?.copyWith(color: AppColours.ink, fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: 20),
        Row(
          children: [
            Container(
              width: 50,
              height: 50,
              decoration: BoxDecoration(
                color: AppColours.cobalt,
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Icon(
                Icons.person_rounded,
                color: Colors.white,
                size: 28,
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w800,
                      color: AppColours.ink,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    email,
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColours.subtle,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),
        const Text(
          'ACCOUNT',
          style: TextStyle(
            fontSize: 11,
            letterSpacing: 1.4,
            fontWeight: FontWeight.w800,
            color: AppColours.eyebrow,
          ),
        ),
        const SizedBox(height: 10),
        _ProfileOption(
          icon: Icons.badge_outlined,
          title: 'Account details',
          subtitle: 'Name and email address',
          onTap: () => _showSheet(
            context,
            title: 'Account details',
            icon: Icons.badge_outlined,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Detail(label: 'NAME', value: name),
                const SizedBox(height: 16),
                _Detail(label: 'EMAIL', value: email, selectable: true),
              ],
            ),
          ),
        ),
        _ProfileOption(
          icon: Icons.help_outline_rounded,
          title: 'About',
          subtitle: 'Atomic Commits',
          onTap: () => _showSheet(
            context,
            title: 'About',
            icon: Icons.help_outline_rounded,
            child: const Text(
              'Atomic Commits',
              style: TextStyle(fontSize: 16, color: AppColours.ink),
            ),
          ),
        ),
        const SizedBox(height: 20),
        OutlinedButton.icon(
          onPressed: () => _confirmLogout(context),
          icon: const Icon(Icons.logout_rounded),
          label: const Text('Sign out'),
          style: OutlinedButton.styleFrom(
            foregroundColor: AppColours.error,
            side: const BorderSide(color: AppColours.fieldBorder),
            padding: const EdgeInsets.symmetric(vertical: 14),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
          ),
        ),
      ],
    );
  }

  void _confirmLogout(BuildContext context) {
    _showSheet(
      context,
      title: 'Sign out?',
      icon: Icons.logout_rounded,
      child: const Text('Are you sure you want to sign out of your account?'),
      actions: [
        OutlinedButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: AppColours.orange),
          onPressed: () {
            Navigator.pop(context);
            _logout(context);
          },
          child: const Text('Sign out'),
        ),
      ],
    );
  }

  void _showSheet(
    BuildContext context, {
    required String title,
    required IconData icon,
    required Widget child,
    List<Widget> actions = const [],
  }) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: EdgeInsets.only(
            left: 12,
            right: 12,
            bottom: MediaQuery.of(sheetContext).viewInsets.bottom + 12,
          ),
          child: SingleChildScrollView(
            child: Container(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
              decoration: BoxDecoration(
                color: AppColours.paperTop,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: AppColours.fieldBorder),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 36,
                      height: 4,
                      decoration: BoxDecoration(
                        color: AppColours.fieldBorder,
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      Icon(icon, color: AppColours.cobalt),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          title,
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w800,
                            color: AppColours.ink,
                          ),
                        ),
                      ),
                      IconButton(
                        onPressed: () => Navigator.pop(sheetContext),
                        icon: const Icon(
                          Icons.close_rounded,
                          color: AppColours.subtle,
                        ),
                        tooltip: 'Close',
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  DefaultTextStyle(
                    style: const TextStyle(
                      fontSize: 14,
                      color: AppColours.ink,
                      height: 1.45,
                    ),
                    child: child,
                  ),
                  if (actions.isNotEmpty) ...[
                    const SizedBox(height: 20),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: actions,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Detail extends StatelessWidget {
  const _Detail({
    required this.label,
    required this.value,
    this.selectable = false,
  });
  final String label;
  final String value;
  final bool selectable;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        label,
        style: const TextStyle(
          fontSize: 11,
          letterSpacing: 1,
          color: AppColours.eyebrow,
          fontWeight: FontWeight.w800,
        ),
      ),
      const SizedBox(height: 5),
      selectable
          ? SelectableText(
              value,
              style: const TextStyle(fontSize: 15, color: AppColours.ink),
            )
          : Text(
              value,
              style: const TextStyle(fontSize: 15, color: AppColours.ink),
            ),
    ],
  );
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
      color: AppColours.fieldFill,
      margin: const EdgeInsets.only(bottom: 9),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(15),
        side: const BorderSide(color: AppColours.fieldBorder),
      ),
      child: ListTile(
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: AppColours.cobalt.withValues(alpha: 0.09),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(icon, color: AppColours.cobalt, size: 21),
        ),
        title: Text(
          title,
          style: const TextStyle(
            fontWeight: FontWeight.w700,
            color: AppColours.ink,
          ),
        ),
        subtitle: Text(
          subtitle,
          style: const TextStyle(fontSize: 12, color: AppColours.subtle),
        ),
        trailing: const Icon(
          Icons.chevron_right_rounded,
          color: AppColours.fieldIcon,
        ),
        onTap: onTap,
      ),
    );
  }
}
