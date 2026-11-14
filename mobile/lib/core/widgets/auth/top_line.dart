import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:atomic_commits/app/router.dart';

class TopLine extends StatelessWidget {
  final double width;
  const TopLine({super.key, required this.width});

  void _goBack(BuildContext context) {
    if (context.canPop()) {
      context.pop();
    } else {
      // Direct-link resilience: the route may be opened without a caller
      // stacked on top, so route home instead of popping.
      context.go(AppRoutes.welcome);
    }
  }

  @override
  Widget build(BuildContext context) {
    Utils utils = Utils();
    final backSize = utils.sized(width, 0.032, 10, 13);
    final tagSize = utils.sized(width, 0.0245, 9, 10);

    return Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 12,
      runSpacing: 4,
      children: [
        TextButton.icon(
          onPressed: () => _goBack(context),
          style: TextButton.styleFrom(
            foregroundColor: AppColours.topline,
            minimumSize: const Size(64, 48),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
            textStyle: Theme.of(context).textTheme.labelLarge?.copyWith(
              fontSize: backSize,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.05 * backSize,
            ),
          ),
          icon: const Icon(Icons.arrow_back, size: 16),
          label: const Text('BACK'),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: const BoxDecoration(
                  color: AppColours.orange,
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(color: Color(0x30FF9B58), spreadRadius: 4),
                  ],
                ),
              ),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  'ATOMIC COMMITS',
                  style: TextStyle(
                    color: AppColours.tagline,
                    fontSize: tagSize,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.13 * tagSize,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
