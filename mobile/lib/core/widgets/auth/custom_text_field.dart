import 'package:atomic_commits/app/theme/app_colours.dart';
import 'package:atomic_commits/core/utils.dart';
import 'package:flutter/material.dart';

class CustomTextField extends StatelessWidget {
  final double width;
  final Key inputKey;
  final String label;
  final String hint;
  final IconData icon;
  final TextEditingController controller;
  final FocusNode focusNode;
  final List<String> autofillHints;
  final TextInputAction textInputAction;
  final FocusNode? nextFocus;
  final String? Function(String?) validator;
  final TextInputType? keyboardType;
  final TextCapitalization textCapitalization;
  final bool obscure;
  final String? toggleTooltip;
  final VoidCallback? onToggle;
  final VoidCallback? onSubmitted;

  const CustomTextField({
    super.key,
    required this.width,
    required this.inputKey,
    required this.label,
    required this.hint,
    required this.icon,
    required this.controller,
    required this.focusNode,
    required this.autofillHints,
    required this.textInputAction,
    required this.validator,
    this.nextFocus,
    this.keyboardType,
    this.textCapitalization = TextCapitalization.none,
    this.obscure = false,
    this.toggleTooltip,
    this.onToggle,
    this.onSubmitted,
  });

  @override
  Widget build(BuildContext context) {
    final utils = Utils();
    final labelSize = utils.sized(width, 0.031, 10, 12);
    final inputSize = utils.sized(width, 0.0345, 12, 14);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 1, bottom: 4),
          child: ExcludeSemantics(
            child: Text(
              label,
              style: TextStyle(
                color: AppColours.labelInk,
                fontSize: labelSize,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.012 * labelSize,
              ),
            ),
          ),
        ),
        Semantics(
          label: label,
          child: TextFormField(
            key: inputKey,
            controller: controller,
            focusNode: focusNode,
            validator: validator,
            obscureText: obscure,
            keyboardType: keyboardType ?? TextInputType.text,
            autocorrect: keyboardType == TextInputType.name,
            enableSuggestions: keyboardType == TextInputType.name,
            textCapitalization: textCapitalization,
            textInputAction: textInputAction,
            autofillHints: autofillHints,
            style: TextStyle(
              color: AppColours.fieldText,
              fontSize: inputSize,
              fontWeight: FontWeight.w500,
            ),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: const TextStyle(
                color: AppColours.fieldHint,
                fontWeight: FontWeight.w400,
              ),
              errorStyle: const TextStyle(
                color: AppColours.error,
                fontSize: 11,
                height: 1.3,
              ),
              errorMaxLines: 3,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 8,
                vertical: 15,
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(color: AppColours.fieldBorder),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(color: AppColours.fieldBorder),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(
                  color: AppColours.fieldFocus,
                  width: 1.5,
                ),
              ),
              errorBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(color: AppColours.error),
              ),
              focusedErrorBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(13),
                borderSide: const BorderSide(
                  color: AppColours.error,
                  width: 1.5,
                ),
              ),
              filled: true,
              fillColor: AppColours.fieldFill,
              prefixIcon: Padding(
                padding: const EdgeInsets.only(left: 14, right: 10),
                child: Icon(icon, size: 18, color: AppColours.fieldIcon),
              ),
              prefixIconConstraints: const BoxConstraints(
                minHeight: 48,
                minWidth: 42,
              ),
              suffixIcon: onToggle != null
                  ? IconButton(
                      tooltip: toggleTooltip,
                      onPressed: onToggle,
                      padding: const EdgeInsets.all(7),
                      constraints: const BoxConstraints(
                        minWidth: 48,
                        minHeight: 48,
                      ),
                      icon: Icon(
                        obscure
                            ? Icons.visibility_outlined
                            : Icons.visibility_off_outlined,
                        size: 20,
                        color: AppColours.eyeIcon,
                      ),
                    )
                  : null,
              suffixIconConstraints: onToggle != null
                  ? const BoxConstraints(minWidth: 48, minHeight: 48)
                  : null,
            ),
            onFieldSubmitted: (_) {
              if (nextFocus != null) {
                FocusScope.of(context).requestFocus(nextFocus);
              } else {
                onSubmitted?.call();
              }
            },
          ),
        ),
      ],
    );
  }
}
