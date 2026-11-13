import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  createDataEncryption,
  createDataEncryptionFromEnv,
  DataEncryptionError,
  parseEncryptionKey,
} from '../src/services/data-encryption';
import { createTotpReplayDigests } from '../src/services/totp-replay-digests';

const keyA = randomBytes(32);
const keyB = randomBytes(32);

test('encrypt then decrypt returns the original secret and never contains the plaintext', () => {
  const enc = createDataEncryption(new Map([[1, keyA]]), 1);
  const sealed = enc.encrypt('JBSWY3DPEHPK3PXP', 'ctx-1');
  assert.equal(sealed.keyVersion, 1);
  assert.equal(sealed.ciphertext.includes(Buffer.from('JBSWY3DPEHPK3PXP')), false);
  assert.equal(enc.decrypt(sealed, 'ctx-1'), 'JBSWY3DPEHPK3PXP');
});

test('the same plaintext encrypts differently each time (fresh IV)', () => {
  const enc = createDataEncryption(new Map([[1, keyA]]), 1);
  assert.notDeepEqual(enc.encrypt('same', 'c').ciphertext, enc.encrypt('same', 'c').ciphertext);
});

test('wrong context, tampered bytes and a wrong key all fail with a generic error', () => {
  const enc = createDataEncryption(new Map([[1, keyA]]), 1);
  const sealed = enc.encrypt('secret', 'row-1');

  assert.throws(() => enc.decrypt(sealed, 'row-2'), DataEncryptionError);

  const tampered = Buffer.from(sealed.ciphertext);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => enc.decrypt({ ...sealed, ciphertext: tampered }, 'row-1'), DataEncryptionError);

  const other = createDataEncryption(new Map([[1, keyB]]), 1);
  assert.throws(() => other.decrypt(sealed, 'row-1'), /could not be decrypted/);
  assert.throws(() => enc.decrypt({ ciphertext: Buffer.alloc(3), keyVersion: 1 }, 'row-1'), DataEncryptionError);
});

test('an old key version can still decrypt after the current key rotates', () => {
  const v1 = createDataEncryption(new Map([[1, keyA]]), 1);
  const sealed = v1.encrypt('old secret', 'ctx');
  const v2 = createDataEncryption(new Map([[1, keyA], [2, keyB]]), 2);
  assert.equal(v2.decrypt(sealed, 'ctx'), 'old secret');
  assert.equal(v2.encrypt('new', 'ctx').keyVersion, 2);
});

test('keys must be exactly 32 bytes of base64 and the error never echoes the key', () => {
  assert.throws(() => parseEncryptionKey(undefined), DataEncryptionError);
  assert.throws(() => parseEncryptionKey('short'), DataEncryptionError);
  const bad = Buffer.alloc(16, 7).toString('base64');
  try {
    parseEncryptionKey(bad);
    assert.fail('should throw');
  } catch (error) {
    assert.equal((error as Error).message.includes(bad), false);
  }
  assert.equal(parseEncryptionKey(keyA.toString('base64')).length, 32);
});

test('a new configured key version does not overwrite access to older ciphertext', () => {
  const old = createDataEncryptionFromEnv({ DATA_ENCRYPTION_KEY: keyA.toString('base64') });
  const sealed = old.encrypt('old secret', 'ctx');
  const freshOnly = createDataEncryptionFromEnv({ DATA_ENCRYPTION_KEY: keyB.toString('base64'), DATA_ENCRYPTION_KEY_VERSION: '2' });
  assert.equal(freshOnly.encrypt('new secret', 'ctx').keyVersion, 2);
  assert.throws(() => freshOnly.decrypt(sealed, 'ctx'), DataEncryptionError);
  const restored = createDataEncryptionFromEnv({
    DATA_ENCRYPTION_KEY: keyB.toString('base64'), DATA_ENCRYPTION_KEY_VERSION: '2', DATA_ENCRYPTION_KEY_V1: keyA.toString('base64'),
  });
  assert.equal(restored.decrypt(sealed, 'ctx'), 'old secret');
});

test('replay checks cover digests created by the current and previous encryption keys', () => {
  const oldDigest = createTotpReplayDigests(new Map([[1, keyA]]))('device-a', '123456').get(1)!;
  const newDigest = createTotpReplayDigests(new Map([[2, keyB]]))('device-a', '123456').get(2)!;
  const both = createTotpReplayDigests(new Map([[2, keyB], [1, keyA]]))('device-a', '123456');
  assert.ok(both.get(1)?.equals(oldDigest));
  assert.ok(both.get(2)?.equals(newDigest));
  assert.ok(!both.get(1)?.equals(createTotpReplayDigests(new Map([[1, keyA]]))('device-b', '123456').get(1)!));
});
