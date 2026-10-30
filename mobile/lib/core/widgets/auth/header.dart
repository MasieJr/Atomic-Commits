import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:flutter/material.dart';

class Header extends StatelessWidget {
  final double width;
  const Header({super.key, required this.width});

  @override
  Widget build(BuildContext context) {
    Utils utils = Utils();

    final headingSize = utils.sized(width, 0.076, 25, 32);
    final subSize = utils.sized(width, 0.0325, 11, 13);
    final eyebrowSize = utils.sized(width, 0.027, 9, 11);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Container(
              width: 20,
              height: 3,
              decoration: BoxDecoration(
                color: AppColours.orange,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(width: 9),
            Flexible(
              child: Text(
                'EVERYDAY PAYMENTS',
                style: TextStyle(
                  color: AppColours.eyebrow,
                  fontSize: eyebrowSize,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.18 * eyebrowSize,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text.rich(
          TextSpan(
            text: 'Join the ',
            children: [
              TextSpan(
                text: 'colony.',
                style: const TextStyle(color: AppColours.orange),
              ),
            ],
          ),
          style: TextStyle(
            color: AppColours.ink,
            fontSize: headingSize,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.058 * headingSize,
            height: 1.04,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'Gwinya for now. Bread for home. Airtime for later.',
          style: TextStyle(
            color: AppColours.subtle,
            fontSize: subSize,
            height: 1.55,
          ),
        ),
      ],
    );
  }
}
