import 'package:flutter/material.dart';

class Art extends StatelessWidget {
  const Art({super.key});

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 16 / 9,
      child: Image.asset(
        'assets/images/atomic-payment-banner.png',
        fit: BoxFit.contain,
        semanticLabel: 'Atomic Commits',
      ),
    );
  }
}
