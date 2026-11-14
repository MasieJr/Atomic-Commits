import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/app/theme/app_spacing.dart';
import 'package:flutter/material.dart';

class AppHeader extends StatelessWidget implements PreferredSizeWidget {
  final String? title;
  final List<Widget>? actions;
  final bool showHelp;

  const AppHeader({super.key, this.title, this.actions, this.showHelp = true});

  @override
  Size get preferredSize => const Size.fromHeight(64);

  @override
  Widget build(BuildContext context) {
    return AppBar(
      toolbarHeight: 64,
      automaticallyImplyLeading: false,
      titleSpacing: AppSpacing.screenPadding,
      title: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AppColours.primary,
              borderRadius: BorderRadius.circular(7),
            ),
            child: const Text(
              'ac',
              style: TextStyle(
                color: Colors.white,
                fontSize: 15,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Text(
            title ?? 'Atomic Commits',
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
          ),
        ],
      ),
      actions: [
        ...?actions,
        if (showHelp)
          IconButton(
            onPressed: () {
              showAboutDialog(
                context: context,
                applicationName: 'Atomic Commits',
                applicationVersion: '0.1.0',
              );
            },
            icon: const Icon(Icons.help_outline_rounded),
          ),
        const SizedBox(width: 12),
      ],
      bottom: const PreferredSize(
        preferredSize: Size.fromHeight(1),
        child: Divider(height: 1),
      ),
    );
  }
}
