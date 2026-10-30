import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/screens/signup_screen.dart';
import '../features/payer/screens/payer_home_screen.dart';
import '../features/payer/screens/show_qr_screen.dart';
import '../features/merchant/screens/merchant_home_screen.dart';
import '../features/merchant/screens/scan_qr_screen.dart';
import '../features/merchant/screens/enter_code_screen.dart';
import '../features/welcome/screens/welcome_screen.dart';

abstract final class AppRoutes {
  static const welcome = '/';
  static const signup = '/signup';

  static const payer = '/payer';
  static const payerQr = '/payer/qr';

  static const merchant = '/merchant';
  static const merchantScan = '/merchant/scan';
  static const merchantEnterCode = '/merchant/enter-code';
}

final appRouter = GoRouter(
  initialLocation: AppRoutes.welcome,
  routes: [
    GoRoute(
      path: AppRoutes.welcome,
      name: 'welcome',
      builder: (context, state) => const WelcomeScreen(),
    ),
    GoRoute(
      path: AppRoutes.signup,
      name: 'signup',
      builder: (context, state) => const SignupScreen(),
    ),

    /**
     * Payer screens
     * /payer     ->  payer homePage
     * /payer/qr  ->  payer QR screen
     */
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

    /**
     * Merchant Screens
     * /merchant              -> merchant homePage
     * /merchant/scan         -> merchant qr-scan page
     * /merchant/enter-code   -> merchant enter code page
     */
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
