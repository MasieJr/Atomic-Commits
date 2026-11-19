// L3 contract tests — canonical serialization and fingerprint-format.
// Pure domain only; no network or storage.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalize,
  canonicalJson,
  canonicalUtf8ByteLength,
  canonicalUtf8Bytes,
  isWellFormedFingerprint,
  PAYMENT_ENGINE_CONTRACT_VERSION,
} from "../src/domain/payment-engine/index";
import type { CanonicalProtocol } from "../src/domain/payment-engine/index";

test("PAYMENT_ENGINE_CONTRACT_VERSION is the documented version \"1\"", () => {
  assert.equal(PAYMENT_ENGINE_CONTRACT_VERSION, "1");
});

test("canonicalJson sorts keys recursively in UTF-8 byte order with no whitespace", () => {
  const json = canonicalJson({
    b: 1,
    a: { d: true, c: null, arr: ["x", "y"] },
    money: "123456789012345678901234567890",
  });
  assert.equal(json, '{"a":{"arr":["x","y"],"c":null,"d":true},"b":1,"money":"123456789012345678901234567890"}');
  assert.ok(!/\s/.test(json));
  // Money strings pass through verbatim: no numbers, no exponent forms.
  assert.ok(json.includes('"money":"123456789012345678901234567890"'));
});

test("canonicalJson orders Unicode/emoji keys by UTF-8 bytes, not default code-unit sort", () => {
  // "Ａ" is U+FF21 (UTF-8: EF BC 81) and "😀" is U+1F600 (UTF-8: F0 9F 98 80).
  // Code-unit order puts the surrogate pair first; UTF-8 byte order puts Ａ first.
  const input: Record<string, string> = { "😀": "emoji", "Ａ": "fullwidth" };
  const json = canonicalJson(input as { readonly [key: string]: string });
  assert.equal(json, '{"Ａ":"fullwidth","😀":"emoji"}');
  assert.ok(
    json.indexOf("Ａ") < json.indexOf("😀"),
    "UTF-8 byte order must beat UTF-16 code-unit order"
  );
});

test("canonicalJson preserves array element order", () => {
  assert.equal(canonicalJson(["b", "a", 3]), '["b","a",3]');
  assert.equal(canonicalJson({ z: [{ y: 2, x: 1 }] }), '{"z":[{"x":1,"y":2}]}');
});

test("canonicalJson produces stable, identical bytes for reordered input objects", () => {
  const forward = canonicalJson({ a: 1, b: "x", c: { p: 1, q: 2 } });
  const reverse = canonicalJson({ c: { q: 2, p: 1 }, b: "x", a: 1 });
  assert.equal(forward, reverse);
  const bytesA = canonicalUtf8Bytes(canonicalize({ version: "1", body: { a: 1, b: "x" } }));
  const bytesB = canonicalUtf8Bytes(canonicalize({ version: "1", body: { b: "x", a: 1 } }));
  assert.equal(Buffer.compare(Buffer.from(bytesA), Buffer.from(bytesB)), 0);
  // Top-level wrapper participates in reorder stability too.
  const wrapperA = canonicalize({ version: "1", body: { a: 1 } });
  const wrapperB = canonicalize({ version: "1", body: { a: 1 } });
  assert.equal(wrapperA.json, wrapperB.json);
});

test("canonicalize rejects unsupported versions and never auto-repairs", () => {
  for (const bad of ["2", "0", "", "1.0", " 1", "01"]) {
    assert.throws(
      () => canonicalize({ version: bad as unknown as "1", body: { a: 1 } } as unknown as CanonicalProtocol),
      /Unsupported payment-engine contract version/
    );
  }
  assert.doesNotThrow(() => canonicalize({ version: "1", body: { a: 1 } }));
});

test("canonicalize binds version into the canonical bytes as a top-level key", () => {
  const representation = canonicalize({ version: "1", body: { a: 1 } });
  assert.equal(representation.json, '{"body":{"a":1},"version":"1"}');
  assert.ok(
    representation.json.includes("body") && representation.json.includes("version"),
    "canonical JSON carries both version and body"
  );
  // Bars use the top-level wrapper too.
  const barRepresentation = canonicalize({ version: "1", body: ["x", "y"] });
  assert.equal(barRepresentation.json, '{"body":["x","y"],"version":"1"}');
});

test("canonicalJson rejects non-canonicalizable leaves when reachable", () => {
  const asLeaf = (value: unknown) => value as unknown as Parameters<typeof canonicalJson>[0];
  // undefined property and undefined array element
  let broken: Record<string, unknown> = { a: undefined };
  assert.throws(() => canonicalJson(asLeaf(broken)), /undefined/);
  broken = { a: [1, undefined] };
  assert.throws(() => canonicalJson(asLeaf(broken)), /undefined/);
  // floats, NaN, Infinity
  assert.throws(() => canonicalJson(asLeaf(1.5)), /safe integers/);
  assert.throws(() => canonicalJson(asLeaf(0.1)), /safe integers/);
  assert.throws(() => canonicalJson(asLeaf(Number.NaN)), /safe integers/);
  assert.throws(() => canonicalJson(asLeaf(Number.POSITIVE_INFINITY)), /safe integers/);
  assert.throws(() => canonicalJson(asLeaf(Number.NEGATIVE_INFINITY)), /safe integers/);
  assert.throws(() => canonicalJson(asLeaf(2 ** 53)), /safe integers/);
  // non-plain-object values
  class Custom {}
  assert.throws(
    () => canonicalJson(asLeaf(new Custom())),
    /plain objects/
  );
  assert.throws(() => canonicalJson(asLeaf(new Map())), /plain objects/);
  // bigint and function
  assert.throws(() => canonicalJson(asLeaf(10n)));
  assert.throws(() => canonicalJson(asLeaf(() => 1)));
  assert.throws(() => canonicalJson(asLeaf(Symbol("s"))));
  // no auto-repair: the same bad input throws every time
  const bad = asLeaf(new Custom());
  assert.throws(() => canonicalJson(bad));
  assert.throws(() => canonicalJson(bad));
});

test("canonicalUtf8Bytes and canonicalUtf8ByteLength match TextEncoder", () => {
  const body: Record<string, string> = { "＿key": "valü 😀", "ascii": "plain" };
  const representation = canonicalize({ version: "1", body });
  const expected = new TextEncoder().encode(representation.json);
  const actual = canonicalUtf8Bytes(representation);
  assert.equal(actual.byteLength, expected.byteLength);
  assert.equal(Buffer.compare(Buffer.from(actual), Buffer.from(expected)), 0);
  assert.equal(canonicalUtf8ByteLength(representation), expected.byteLength);
  // Multi-byte content must not be measured in characters.
  const asciiOnly = canonicalize({ version: "1", body: "abc" });
  assert.equal(
    canonicalUtf8ByteLength(asciiOnly),
    '{"body":"abc","version":"1"}'.length,
    "pure-ASCII json measures as its character count"
  );
  const emojiOnly = canonicalize({ version: "1", body: "😀" });
  assert.ok(
    canonicalUtf8ByteLength(emojiOnly) > emojiOnly.json.length,
    "a surrogate-pair emoji occupies 4 UTF-8 bytes but 2 UTF-16 units"
  );
  assert.equal(
    canonicalUtf8ByteLength(emojiOnly),
    '{"body":"😀","version":"1"}'.length - ('{"body":"😀","version":"1"}'.length - new TextEncoder().encode('{"body":"😀","version":"1"}').byteLength),
    "byte length accounts for the 4-byte emoji encoding"
  );
});

// ---------------- Fingerprint format ----------------

const ALL_ZEROS = "0".repeat(64);
const ALL_F = "f".repeat(64);

test("isWellFormedFingerprint accepts exactly 64 lowercase hex chars", () => {
  assert.equal(isWellFormedFingerprint(ALL_ZEROS), true);
  assert.equal(isWellFormedFingerprint(ALL_F), true);
  assert.equal(isWellFormedFingerprint("a".repeat(64)), true);
  const mixed = "0123456789abcdef".repeat(4);
  assert.equal(isWellFormedFingerprint(mixed), true);
});

test("isWellFormedFingerprint rejects malformed shapes", () => {
  assert.equal(isWellFormedFingerprint(""), false);
  assert.equal(isWellFormedFingerprint("A".repeat(64)), false, "uppercase rejected");
  assert.equal(isWellFormedFingerprint("a".repeat(63)), false, "short rejected");
  assert.equal(isWellFormedFingerprint("a".repeat(65)), false, "long rejected");
  assert.equal(isWellFormedFingerprint("g".repeat(64)), false, "non-hex rejected");
  assert.equal(isWellFormedFingerprint(`${"a".repeat(32)}${"A".repeat(32)}`), false);
  assert.equal(isWellFormedFingerprint(`${"a".repeat(32)} ${"a".repeat(31)}`), false, "whitespace rejected");
  assert.equal(isWellFormedFingerprint(undefined), false);
  assert.equal(isWellFormedFingerprint(null), false);
  assert.equal(isWellFormedFingerprint(123), false);
});
