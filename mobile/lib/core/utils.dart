class Utils {
  double sized(double width, double fraction, double min, double max) =>
      (width * fraction).clamp(min, max).toDouble();
}
