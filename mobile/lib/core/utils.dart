class Utils {
  double sized(double width, double fraction, double min, double max) =>
      (width * fraction).clamp(min, max).toDouble();

  String? validateName(String? raw) {
    if (raw == null || raw.trim().isEmpty) return 'Enter your full name.';
    return null;
  }

  String? validateEmail(String? raw) {
    final value = raw?.trim() ?? '';
    if (value.isEmpty) return 'Enter your email address.';
    final pattern = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
    if (!pattern.hasMatch(value)) return 'Enter a valid email address.';
    return null;
  }

  String? validatePassword(String? raw) {
    final value = raw ?? '';
    if (value.isEmpty) return 'Enter a password.';
    if (value.length < 8) return 'Use at least 8 characters.';
    return null;
  }
}
