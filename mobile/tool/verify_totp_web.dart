import 'package:atomic_commits/features/payer/totp.dart';

void main() {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (final (seconds, expected) in [
    (59, '287082'),
    (1111111109, '081804'),
    (1111111111, '050471'),
    (1234567890, '005924'),
    (2000000000, '279037'),
    (20000000000, '353130'),
  ]) {
    if (decimalTotp(secret, seconds ~/ 30) != expected) {
      throw StateError('TOTP failed for $seconds seconds.');
    }
  }
  // ignore: avoid_print
  print('TOTP JavaScript interoperability vectors passed.');
}
