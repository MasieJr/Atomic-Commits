import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatPaymentCode,
  generateTotp,
  parsePaymentCode,
  TOTP_TIME_STEP_MS,
  verifyTotp,
} from '../src/domain/payment-engine/totp';

// Public RFC 6238 SHA1 seed: ASCII "12345678901234567890".
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHORT_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY';

// Independently calculated from RFC 6238 Appendix B using Python's hmac and
// struct libraries: 31-bit HOTP truncation encoded as six uppercase base36
// characters. The RFC publishes the same truncation modulo 10^8.
const VECTORS = [
  { seconds: 59, code: 'I3IDBE', hotp8: '94287082' },
  { seconds: 1111111109, code: 'F01WSS', hotp8: '07081804' },
  { seconds: 1111111111, code: '6UIJDZ', hotp8: '14050471' },
  { seconds: 1234567890, code: 'BE7SDG', hotp8: '89005924' },
  { seconds: 2000000000, code: 'Y7ZTX9', hotp8: '69279037' },
  { seconds: 20000000000, code: 'O8FLPM', hotp8: '65353130' },
] as const;

test('base36 vectors match independent HMAC and RFC 6238 truncation', () => {
  for (const vector of VECTORS) {
    const time = vector.seconds * 1000;
    const step = Math.floor(time / TOTP_TIME_STEP_MS);
    const generated = generateTotp(RFC_SEED, time);
    assert.deepEqual(generated, { code: vector.code, timeStep: step, expiresAtEpochMs: (step + 1) * TOTP_TIME_STEP_MS });
    assert.equal(String(parseInt(generated.code, 36) % 100_000_000).padStart(8, '0'), vector.hotp8);
    assert.deepEqual(verifyTotp(RFC_SEED, vector.code, time, 0), { valid: true, timeStep: step });
  }
});

test('codes are stable within a 30-second step and rotate at the boundary', () => {
  assert.deepEqual(generateTotp(RFC_SEED, 30_000), generateTotp(RFC_SEED, 59_999));
  assert.deepEqual(generateTotp(RFC_SEED, 59_999), { code: 'I3IDBE', timeStep: 1, expiresAtEpochMs: 60_000 });
  assert.deepEqual(generateTotp(RFC_SEED, 60_000), { code: '29S300', timeStep: 2, expiresAtEpochMs: 90_000 });
  assert.deepEqual(verifyTotp(RFC_SEED, 'I3IDBE', 59_999, 0), { valid: true, timeStep: 1 });
  assert.deepEqual(verifyTotp(RFC_SEED, 'I3IDBE', 60_000, 0), { valid: false });
  assert.deepEqual(verifyTotp(RFC_SEED, 'I3IDBE', 60_000, 1), { valid: true, timeStep: 1 });
});

test('leading zeroes survive code generation, formatting and parsing', () => {
  const generated = generateTotp(RFC_SEED, 17_400_000);
  assert.equal(generated.code, '00COIR');
  assert.equal(formatPaymentCode('4RTW', generated.code), '4RTW-00COIR');
  assert.deepEqual(parsePaymentCode('4RTW-00COIR'), { prefix: '4RTW', code: '00COIR' });
  assert.deepEqual(verifyTotp(RFC_SEED, '00COIR', 17_400_000, 0), { valid: true, timeStep: 580 });
});

test('drift accepts only the configured adjacent steps and returns the actual step', () => {
  const now = 60_000;
  assert.deepEqual(verifyTotp(RFC_SEED, '29S300', now, 1), { valid: true, timeStep: 2 });
  assert.deepEqual(verifyTotp(RFC_SEED, 'I3IDBE', now, 1), { valid: true, timeStep: 1 });
  const next = generateTotp(RFC_SEED, 90_000).code;
  assert.deepEqual(verifyTotp(RFC_SEED, next, now, 1), { valid: true, timeStep: 3 });
  assert.deepEqual(verifyTotp(RFC_SEED, 'L8WRH4', now, 1), { valid: false });
  assert.deepEqual(verifyTotp(RFC_SEED, 'L8WRH4', 0, 1), { valid: true, timeStep: 0 });
  for (const drift of [-1, 2, 0.5, NaN, Infinity]) {
    assert.throws(() => verifyTotp(RFC_SEED, 'I3IDBE', now, drift), /drift window/);
  }
});

test('four-character prefixes and six-character alphanumeric codes are strict', () => {
  assert.equal(formatPaymentCode('4RTW', 'I3IDBE'), '4RTW-I3IDBE');
  assert.equal(formatPaymentCode('A1B2', '000000'), 'A1B2-000000');
  assert.deepEqual(parsePaymentCode('4RTW-I3IDBE'), { prefix: '4RTW', code: 'I3IDBE' });
  for (const value of ['ABC', 'ABCDE', 'ab12', 'AB1!', '4RTW\n', '', 'A B2']) {
    assert.throws(() => formatPaymentCode(value, 'I3IDBE'), /prefix/i);
  }
  for (const value of ['I3IDB', 'I3IDBEE', 'i3idbe', 'I3IDB!', 'I3IDBE\n', '', ' I3IDBE']) {
    assert.throws(() => formatPaymentCode('4RTW', value), /six uppercase/i);
    assert.deepEqual(verifyTotp(RFC_SEED, value, 59_000, 1), { valid: false });
  }
  for (const value of ['4RTW-I3IDBE\n', '4rtw-I3IDBE', '4RTW-i3idbe', '4RTWX-I3IDBE', '4RTW-I3IDB', '4RTW--I3IDBE', ' 4RTW-I3IDBE', '4RTW-I3IDBE!']) {
    assert.equal(parsePaymentCode(value), undefined, value);
  }
});

test('valid decimal strings are not accepted unless they are the exact alphanumeric code', () => {
  // This is the old decimal TOTP for the RFC vector. It must not be accepted
  // as a substitute for the complete BASE36-HOTP31 value.
  assert.deepEqual(verifyTotp(RFC_SEED, '287082', 59_000, 0), { valid: false });
  assert.deepEqual(verifyTotp(RFC_SEED, 'I3IDBE', 59_000, 0), { valid: true, timeStep: 1 });
});

test('canonical Base32 secrets accept case and padding and reject malformed variants', () => {
  const time = 59_000;
  assert.equal(generateTotp(RFC_SEED.toLowerCase(), time).code, 'I3IDBE');
  assert.equal(generateTotp(`${SHORT_SEED}======`, time).code, generateTotp(SHORT_SEED, time).code);
  const invalid: unknown[] = [
    '', `${RFC_SEED}\n`, ` ${RFC_SEED}`, `${RFC_SEED}=`, `${SHORT_SEED}=====`,
    `${RFC_SEED.slice(0, 20)}ß${RFC_SEED.slice(21)}`, `${RFC_SEED.slice(0, 20)}ı${RFC_SEED.slice(21)}`,
    `${RFC_SEED.slice(0, 10)}=${RFC_SEED.slice(10)}`, 'A'.repeat(33), 'A'.repeat(30),
    `${SHORT_SEED.slice(0, 25)}Z`, 'A'.repeat(24), 123, null,
  ];
  for (const secret of invalid) {
    assert.throws(() => generateTotp(secret as string, time), /malformed|strength floor/);
    assert.deepEqual(verifyTotp(secret as string, 'I3IDBE', time, 0), { valid: false });
  }
});

test('invalid times fail closed and unsafe expiries are rejected', () => {
  for (const time of [-1, 1.5, NaN, Infinity, '0', null]) {
    assert.throws(() => generateTotp(RFC_SEED, time as number), /non-negative whole number/);
    assert.deepEqual(verifyTotp(RFC_SEED, 'I3IDBE', time as number, 0), { valid: false });
  }
  assert.throws(() => generateTotp(RFC_SEED, Number.MAX_SAFE_INTEGER), /non-negative whole number/);
});

test('separate time steps can collide and require durable backend replay protection', () => {
  // Known collision for the public RFC seed, obtained with an independent
  // search. These steps are different even though the displayed code repeats.
  const first = generateTotp(RFC_SEED, 56_251 * TOTP_TIME_STEP_MS);
  const second = generateTotp(RFC_SEED, 56_758 * TOTP_TIME_STEP_MS);
  assert.equal(first.code, 'TOWFNA');
  assert.equal(second.code, first.code);
  assert.deepEqual(verifyTotp(RFC_SEED, first.code, 56_758 * TOTP_TIME_STEP_MS, 0), { valid: true, timeStep: 56_758 });
});
