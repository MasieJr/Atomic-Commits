import 'dart:typed_data';

import 'package:crypto/crypto.dart';

String decimalTotp(String secret, int step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  final key = <int>[];
  var bits = 0;
  var buffer = 0;
  for (final character in secret.split('')) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key.add((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  final counter = ByteData(8)
    ..setUint32(0, step ~/ 0x100000000, Endian.big)
    ..setUint32(4, step % 0x100000000, Endian.big);
  final digest = Hmac(sha1, key).convert(counter.buffer.asUint8List()).bytes;
  final offset = digest.last & 0x0f;
  final value =
      ((digest[offset] & 0x7f) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3];
  return (value % 1000000).toString().padLeft(6, '0');
}
