import 'dart:convert';

class Utils {
  double sized(double width, double fraction, double min, double max) =>
      (width * fraction).clamp(min, max).toDouble();

  String? validateName(String? raw) {
    final length = raw?.trim().runes.length ?? 0;
    if (length < 2 || length > 80) return 'Use a name between 2 and 80 characters.';
    return null;
  }

  String? validateEmail(String? raw) {
    final value = raw?.trim() ?? '';
    if (value.isEmpty) return 'Enter your email address.';
    if (value.length > 254) return 'Enter a valid email address.';
    final pattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
    if (!pattern.hasMatch(value)) return 'Enter a valid email address.';
    return null;
  }

  String? validatePassword(String? raw) {
    final value = raw ?? '';
    if (value.isEmpty) return 'Enter a password.';
    if (value.length < 8) return 'Use at least 8 characters.';
    if (utf8.encode(value).length > 72) return 'Use a password of at most 72 UTF-8 bytes.';
    return null;
  }
}
