import 'package:flutter/material.dart';

import 'router.dart';
import 'theme/app_theme.dart';

class AtomicCommitsApp extends StatelessWidget {
  const AtomicCommitsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Atomic Commits',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      routerConfig: appRouter,
    );
  }
}
