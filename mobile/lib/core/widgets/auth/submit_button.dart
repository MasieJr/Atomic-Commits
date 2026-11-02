import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:flutter/material.dart';

class SubmitButton extends StatelessWidget {
  final double width;
  final VoidCallback submit;
  const SubmitButton({super.key, required this.width, required this.submit});

  @override
  Widget build(BuildContext context) {
    Utils utils = Utils();
    final buttonFontSize = utils.sized(width, 0.037, 13, 15);
    final buttonTextStyle = Theme.of(context).textTheme.labelLarge
        ?.copyWith(fontSize: buttonFontSize, fontWeight: FontWeight.w800);

    return ElevatedButton(
      onPressed: submit,
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColours.cobalt,
        foregroundColor: Colors.white,
        minimumSize: const Size.fromHeight(52),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
        elevation: 0,
        shadowColor: const Color(0x2B0941BA),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
        textStyle: buttonTextStyle,
      ),
      child: const Text('Create account'),
    );
  }
}
