String? parseMinorAmount(String input, int scale) {
  if (scale < 0 || scale > 18) return null;
  final match = RegExp(r'^([0-9]{1,12})(?:\.([0-9]+))?$')
      .firstMatch(input.trim());
  if (match == null) return null;
  final fractional = match.group(2) ?? '';
  if (fractional.length > scale) return null;
  final value = BigInt.parse(
    '${match.group(1)}${fractional.padRight(scale, '0')}',
  );
  return value > BigInt.zero && value.toString().length <= 18
      ? value.toString()
      : null;
}
