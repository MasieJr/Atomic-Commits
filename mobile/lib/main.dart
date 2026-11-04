import 'package:atomic_commits/app/app.dart';
import 'package:atomic_commits/app/dependencies.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await configureDependencies();
  runApp(const AtomicCommitsApp());
}
