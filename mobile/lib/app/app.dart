import 'package:flutter/material.dart';

import 'theme/app_theme.dart';

class AtomicCommitsApp extends StatelessWidget {
  const AtomicCommitsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Atomic Commits',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light,
      home: const Scaffold(body: Center(child: Text('Atomic Commits'))),
    );
  }
}
