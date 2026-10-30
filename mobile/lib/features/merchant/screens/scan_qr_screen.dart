import 'package:flutter/material.dart';

class ScanQrScreen extends StatelessWidget {
  const ScanQrScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan payment QR')),
      body: const Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.qr_code_scanner, size: 120),
            SizedBox(height: 24),
            Text('QR scanner coming soon'),
            SizedBox(height: 8),
            Text('Camera scanning will be added here.'),
          ],
        ),
      ),
    );
  }
}
