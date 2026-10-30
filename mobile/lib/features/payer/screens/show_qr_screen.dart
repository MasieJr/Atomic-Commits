import 'package:flutter/material.dart';

import '../../../../app/theme/app_colours.dart';
import '../../../../app/theme/app_spacing.dart';

class ShowQrScreen extends StatelessWidget {
  const ShowQrScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Show to shop')),
      body: Padding(
        padding: const EdgeInsets.all(AppSpacing.screenPadding),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.qr_code_2_rounded,
              size: 200,
              color: AppColours.primary,
            ),
            const SizedBox(height: 24),
            const Text(
              '482 916',
              style: TextStyle(fontSize: 36, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            const Text('Customer ID: 7K3M'),
            const SizedBox(height: 16),
            const Text(
              'Show this screen to the merchant.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            const Text(
              'Demo only — not a valid payment QR',
              style: TextStyle(color: AppColours.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
