import 'package:atomic_commits/app/dependencies.dart';
import 'package:atomic_commits/app/navigation/main_navigation.dart';
import 'package:atomic_commits/features/activity/screens/activity_screen.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/auth/screens/login_screen.dart';
import 'package:atomic_commits/features/auth/screens/signup_screen.dart';
import 'package:atomic_commits/features/dashboard/screens/dashboard_screen.dart';
import 'package:atomic_commits/features/merchant/screens/enter_code_screen.dart';
import 'package:atomic_commits/features/merchant/screens/merchant_home_screen.dart';
import 'package:atomic_commits/features/merchant/screens/scan_qr_screen.dart';
import 'package:atomic_commits/features/payer/screens/payer_home_screen.dart';
import 'package:atomic_commits/features/profile/screens/profile_screen.dart';
import 'package:atomic_commits/features/wallet/screens/wallet_screen.dart';
import 'package:atomic_commits/features/welcome/screens/welcome_screen.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

abstract final class AppRoutes {
  static const welcome = '/';
  static const signup = '/signup';
  static const login = '/login';

  static const home = '/home';
  static const activity = '/activity';
  static const wallet = '/wallet';
  static const profile = '/profile';

  static const payer = '/payer';
  static const payerQr = '/payer/qr';

  static const merchant = '/merchant';
  static const merchantScan = '/merchant/scan';
  static const merchantEnterCode = '/merchant/enter-code';
}

final AuthController _authController = getIt<AuthController>();

final appRouter = GoRouter(
  initialLocation: AppRoutes.welcome,
  refreshListenable: _authController,

  redirect: (context, state) {
    if (!_authController.isInitialized) {
      return null;
    }

    final currentPath = state.matchedLocation;
    final isAuthenticated = _authController.isAuthenticated;

    final isAuthRoute =
        currentPath == AppRoutes.welcome ||
        currentPath == AppRoutes.login ||
        currentPath == AppRoutes.signup;

    final isProtectedRoute =
        currentPath == AppRoutes.home ||
        currentPath == AppRoutes.activity ||
        currentPath == AppRoutes.wallet ||
        currentPath == AppRoutes.profile ||
        currentPath.startsWith('/payer') ||
        currentPath.startsWith('/merchant');

    if (!isAuthenticated && isProtectedRoute) {
      return AppRoutes.login;
    }

    if (isAuthenticated && isAuthRoute) {
      return _authController.isNewAccount ? AppRoutes.wallet : AppRoutes.home;
    }

    return null;
  },

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

    GoRoute(
      path: AppRoutes.login,
      name: 'login',
      builder: (context, state) => const LoginScreen(),
    ),

    // Main authenticated application
    StatefulShellRoute.indexedStack(
      builder: (context, state, navigationShell) {
        return MainNavigation(navigationShell: navigationShell);
      },
      branches: [
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: AppRoutes.home,
              name: 'home',
              builder: (context, state) => const DashboardScreen(),
            ),
          ],
        ),

        StatefulShellBranch(
          routes: [
            GoRoute(
              path: AppRoutes.activity,
              name: 'activity',
              builder: (context, state) => const ActivityScreen(),
            ),
          ],
        ),

        StatefulShellBranch(
          routes: [
            GoRoute(
              path: AppRoutes.wallet,
              name: 'wallet',
              builder: (context, state) => const WalletScreen(),
            ),
          ],
        ),

        StatefulShellBranch(
          routes: [
            GoRoute(
              path: AppRoutes.profile,
              name: 'profile',
              builder: (context, state) => const ProfileScreen(),
            ),
          ],
        ),
      ],
    ),

    // Payer flow
    GoRoute(
      path: AppRoutes.payer,
      name: 'payer',
      builder: (context, state) => const PayerHomeScreen(),
      routes: [
        GoRoute(
          path: 'qr',
          name: 'payer-qr',
          builder: (context, state) => const PayerHomeScreen(),
        ),
      ],
    ),

    // Merchant flow
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
