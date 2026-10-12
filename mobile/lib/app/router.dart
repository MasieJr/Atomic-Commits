import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../features/payer/screens/payer_home_screen.dart';
import '../features/payer/screens/show_qr_screen.dart';
import '../features/merchant/screens/merchant_home_screen.dart';
import '../features/merchant/screens/scan_qr_screen.dart';
import '../features/merchant/screens/enter_code_screen.dart';

abstract final class AppRoutes {
  static const payer = '/payer';
  static const payerQr = '/payer/qr';

  static const merchant = '/merchant';
  static const merchantScan = '/merchant/scan';
  static const merchantEnterCode = '/merchant/enter-code';
}

final appRouter = GoRouter(
  initialLocation: AppRoutes.payer,
  routes: [
    GoRoute(
      path: AppRoutes.payer,
      name: 'payer',
      builder: (context, state) => const PayerHomeScreen(),
      routes: [
        GoRoute(
          path: 'qr',
          name: 'payer-qr',
          builder: (context, state) => const ShowQrScreen(),
        ),
      ],
    ),
    GoRoute(
      path: AppRoutes.merchant,
      name: 'merchant',
      builder: (context, state) => const MerchantHomeScreen(),
      routes: [
        GoRoute(
          path: 'scan',
          name: 'merchant-scan',
          builder: (context, state) => const ScanQrScreen(),
        ),
        GoRoute(
          path: 'enter-code',
          name: 'merchant-enter-code',
          builder: (context, state) => const EnterCodeScreen(),
        ),
      ],
    ),
  ],
  errorBuilder: (context, state) =>
      Scaffold(body: Center(child: Text('Page not found: ${state.uri}'))),
);
