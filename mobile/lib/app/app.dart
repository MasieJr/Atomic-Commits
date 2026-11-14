import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:flutter/material.dart';

import 'dependencies.dart';
import 'router.dart';
import 'theme/app_theme.dart';

class AtomicCommitsApp extends StatelessWidget {
  const AtomicCommitsApp({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = getIt<AuthController>();
    return ListenableBuilder(
      listenable: auth,
      builder: (context, child) {
        if (!auth.isInitialized) {
          return MaterialApp(
            title: 'Atomic Commits',
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light,
            home: const Scaffold(
              body: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Atomic Commits'),
                    SizedBox(height: 20),
                    CircularProgressIndicator(),
                  ],
                ),
              ),
            ),
          );
        }
        return MaterialApp.router(
          title: 'Atomic Commits',
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light,
          routerConfig: appRouter,
        );
      },
    );
  }
}
