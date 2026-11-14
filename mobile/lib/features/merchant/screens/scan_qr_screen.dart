import 'dart:async';

import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class ScanQrScreen extends StatefulWidget {
  const ScanQrScreen({super.key});

  @override
  State<ScanQrScreen> createState() => _ScanQrScreenState();
}

class _ScanQrScreenState extends State<ScanQrScreen> {
  final _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  final _auth = getIt<AuthController>();
  late final int? _ownerId;
  bool _accepted = false;
  bool _invalidCode = false;

  @override
  void initState() {
    super.initState();
    _ownerId = _auth.user?.id;
    _auth.addListener(_accountChanged);
  }

  void _accountChanged() {
    if (_auth.user?.id == _ownerId || _accepted) return;
    _accepted = true;
    unawaited(_controller.stop().catchError((Object _) {}));
    if (mounted && Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  void _detected(BarcodeCapture capture) {
    if (_accepted || !mounted || _auth.user?.id != _ownerId) return;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue?.trim().toUpperCase();
      if (value != null &&
          RegExp(r'^[A-Z0-9]{4,12}-[0-9]{6}$').hasMatch(value)) {
        _accepted = true;
        unawaited(_returnCode(value));
        return;
      }
    }
    if (!_invalidCode) setState(() => _invalidCode = true);
  }

  Future<void> _returnCode(String code) async {
    try {
      await _controller.stop();
    } catch (_) {
      // Closing the scanner still returns the captured code.
    }
    if (mounted &&
        _auth.user?.id == _ownerId &&
        Navigator.of(context).canPop()) {
      Navigator.of(context).pop(code);
    }
  }

  @override
  void dispose() {
    _auth.removeListener(_accountChanged);
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColours.paperTop,
      appBar: AppBar(
        backgroundColor: AppColours.paperTop,
        title: const Text('Scan payment code'),
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Scan the customer’s QR code',
                style: TextStyle(
                  color: AppColours.ink,
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 20),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(22),
                  child: MobileScanner(
                    controller: _controller,
                    onDetect: _detected,
                    placeholderBuilder: (_) =>
                        const Center(child: CircularProgressIndicator()),
                    errorBuilder: (context, error) => Container(
                      color: AppColours.paperMid,
                      padding: const EdgeInsets.all(24),
                      child: const Center(
                        child: Text(
                          'Camera unavailable. Allow camera access or enter the code manually.',
                          textAlign: TextAlign.center,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (_invalidCode)
                const Text(
                  'That is not an Atomic payment code. Try another QR code.',
                  style: TextStyle(color: AppColours.error),
                ),
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Enter code manually'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
