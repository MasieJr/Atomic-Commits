import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:flutter/material.dart';

class Secondary extends StatelessWidget {
  final double width;
  const new({super.key, required this.width});

  @override
  Widget build(BuildContext context) {
    Utils utils = Utils();
    final secondarySize = utils.sized(width, 0.03, 11, 13);

    void showLoginPlaceholder() {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(const SnackBar(content: Text('Log in is coming soon.')));
    }

    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 4,
      children: [
        Text(
          'Already with us?',
          style: TextStyle(
            color: AppColours.secondary,
            fontSize: secondarySize,
            height: 1.6,
          ),
        ),
        TextButton(
          onPressed: showLoginPlaceholder,
          style: TextButton.styleFrom(
            foregroundColor: AppColours.cobalt,
            minimumSize: const Size(64, 48),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
            textStyle: Theme.of(context).textTheme.labelLarge?.copyWith(
              fontSize: secondarySize,
              fontWeight: FontWeight.w800,
            ),
          ),
          child: const Text('Log in'),
        ),
      ],
    );
  }
}
