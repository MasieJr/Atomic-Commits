import 'package:atomic_commits/features/auth/models/user_model.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

Future<void> showTempDialog({
  required BuildContext context,
  required UserModel user,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => AlertDialog(
      title: Text('Welcome, ${user.name}'),
      content: const Text('What would you like to do?'),
      actions: [
        TextButton(
          onPressed: () {
            Navigator.of(dialogContext).pop();
            context.go('/payer');
          },
          child: const Text('Make a payment'),
        ),
        ElevatedButton(
          onPressed: () {
            Navigator.of(dialogContext).pop();
            context.go('/merchant');
          },
          child: const Text('Receive a payment'),
        ),
      ],
    ),
  );
}
