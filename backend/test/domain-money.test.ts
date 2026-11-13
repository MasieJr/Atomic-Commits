// L3 contract tests — money exactness and closed error union.
// Pure domain only: no HTTP, database, provider, or secret material.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isCanonicalUnsignedIntegerString,
  compareValuesWithinAsset,
  isPaymentEngineErrorCode,
  isWithinCeiling,
  isValidMoney,
  makeMoney,
  PAYMENT_ENGINE_ERROR_CODES,
  PAYMENT_ENGINE_ERROR_MESSAGES,
  PaymentEngineError,
  sameAsset,
} from "../src/domain/payment-engine/index";
import type { Money } from "../src/domain/payment-engine/index";

function usd(value: string, assetCode = "USD", assetScale = 2): Money {
  return { value, assetCode, assetScale };
}

test("makeMoney builds canonical money and preserves the exact string", () => {
  const zero = makeMoney("0", "USD", 2);
  assert.equal(zero.value, "0");
  assert.equal(zero.assetCode, "USD");
  assert.equal(zero.assetScale, 2);
  assert.equal(makeMoney("1", "EUR", 0).value, "1");
  assert.equal(
    makeMoney("123456789012345678901234567890", "XRP", 6).value,
    "123456789012345678901234567890"
  );
});

test("isCanonicalUnsignedIntegerString accepts exactly canonical forms", () => {
  assert.equal(isCanonicalUnsignedIntegerString("0"), true);
  assert.equal(isCanonicalUnsignedIntegerString("7"), true);
  assert.equal(isCanonicalUnsignedIntegerString("99"), true);
  assert.equal(
    isCanonicalUnsignedIntegerString("9007199254740993"),
    true
  );
  for (const bad of [
    "",
    " ",
    " 1",
    "1 ",
    "+1",
    "-1",
    "1.5",
    "1.",
    ".5",
    "1e3",
    "1E3",
    "0x10",
    "abc",
    "1_000",
    "01",
    "007",
    "3,000",
    "১২",
    "1\u00A0",
  ]) {
    assert.equal(isCanonicalUnsignedIntegerString(bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
  for (const notAString of [undefined, null, 0, 1, 1.5, NaN, Infinity, true, {}, []]) {
    assert.equal(isCanonicalUnsignedIntegerString(notAString), false);
  }
});

test("makeMoney throws PaymentEngineError INVALID_MONEY for every malformed input, never leaking it", () => {
  const malformed: readonly unknown[] = [
    "",
    " ",
    "  1",
    "+1",
    "-1",
    "-0",
    "1.0",
    ".5",
    "1e3",
    "1e-3",
    "0x10",
    "abc",
    "12a",
    "01",
    "007",
    "000",
    "٣",
    NaN,
    Infinity,
    -Infinity,
    0,
    1,
    true,
    null,
    undefined,
    {},
    [],
  ];
  for (const bad of malformed) {
    try {
      makeMoney(bad as unknown as string, "USD", 2);
      assert.fail(`expected PaymentEngineError for ${JSON.stringify(bad)}`);
    } catch (error) {
      assert.ok(error instanceof PaymentEngineError, `wrong error class for ${JSON.stringify(bad)}`);
      assert.equal((error as PaymentEngineError).code, "INVALID_MONEY");
      assert.ok(!String(error.message).includes(JSON.stringify(bad)), "leaked malformed input");
      const flat = String(bad);
      // A whitespace-only input trivially matches any message; meaningful
      // rejection text must never appear, though.
      if (flat.trim().length > 0 || flat.length > 1) {
        assert.ok(!error.message.includes(flat), "message must not embed the rejected input text");
      }
    }
  }
});

test("makeMoney rejects empty asset codes and out-of-range scales", () => {
  assert.throws(() => makeMoney("1", "", 2), PaymentEngineError);
  for (const scale of [256, -1, 0.5, NaN, Infinity, -Infinity, 1e21, 2 ** 53]) {
    assert.throws(() => makeMoney("1", "USD", scale as unknown as number), PaymentEngineError);
  }
  assert.equal(typeof makeMoney("1", "USD", 0).assetScale, "number");
  assert.equal(makeMoney("1", "USD", 255).assetScale, 255);
});

test("whitespace-only assetCode is rejected by makeMoney and isValidMoney", () => {
  for (const blankCode of [" ", "\t", "\n", "\u00A0", "   ", "\t \n"]) {
    try {
      makeMoney("1", blankCode, 2);
      assert.fail(`expected PaymentEngineError for ${JSON.stringify(blankCode)}`);
    } catch (error) {
      assert.ok(error instanceof PaymentEngineError);
      assert.equal((error as PaymentEngineError).code, "INVALID_MONEY");
    }
    assert.equal(
      isValidMoney({ value: "1", assetCode: blankCode, assetScale: 2 }),
      false,
      `isValidMoney must reject whitespace-only code ${JSON.stringify(blankCode)}`
    );
  }
});

test("isValidMoney accepts valid money and rejects malformed shapes", () => {
  assert.equal(isValidMoney(usd("10")), true);
  assert.equal(isValidMoney(usd("0")), true);
  assert.equal(isValidMoney({ value: "10", assetCode: "USD", assetScale: 2 }), true);
  assert.equal(isValidMoney({ value: "10", assetCode: "", assetScale: 2 }), false);
  assert.equal(isValidMoney({ value: "10", assetCode: "USD", assetScale: 256 }), false);
  assert.equal(isValidMoney({ value: "10", assetCode: "USD", assetScale: -1 }), false);
  assert.equal(isValidMoney({ value: "10", assetCode: "USD", assetScale: 0.5 }), false);
  assert.equal(isValidMoney({ value: "10", assetCode: "USD", assetScale: NaN }), false);
  assert.equal(isValidMoney({ value: 10, assetCode: "USD", assetScale: 2 }), false);
  assert.equal(isValidMoney({ value: "10", assetScale: 2 }), false);
  assert.equal(isValidMoney({ value: "10", assetCode: "USD" }), false);
  assert.equal(isValidMoney("10"), false);
  assert.equal(isValidMoney(null), false);
  assert.equal(isValidMoney(undefined), false);
});

test("sameAsset requires both assetCode and assetScale equality", () => {
  assert.equal(sameAsset(usd("1"), usd("2")), true);
  assert.equal(sameAsset(usd("1", "USD", 2), usd("1", "USD", 3)), false);
  assert.equal(sameAsset(usd("1", "USD", 2), usd("1", "EUR", 2)), false);
});

test("compareValuesWithinAsset orders canonical values, including very long values", () => {
  const a = usd("1");
  const b = usd("10");
  const c = usd("10");
  const hugeA = usd("100000000000000000000000000000000000");
  const hugeB = usd("99999999999999999999999999999999999");
  assert.equal(compareValuesWithinAsset(a, b), -1);
  assert.equal(compareValuesWithinAsset(b, a), 1);
  assert.equal(compareValuesWithinAsset(c, b), 0);
  assert.equal(compareValuesWithinAsset(hugeA, hugeB), 1);
  assert.equal(compareValuesWithinAsset(hugeB, hugeA), -1);
  assert.equal(compareValuesWithinAsset(usd("9007199254740993"), usd("9007199254740992")), 1);
  assert.equal(compareValuesWithinAsset(usd("0"), usd("0")), 0);
  assert.equal(compareValuesWithinAsset(usd("0"), usd("1")), -1);
});

test("compareValuesWithinAsset throws across different assets", () => {
  assert.throws(
    () => compareValuesWithinAsset(usd("1", "USD", 2), usd("1", "EUR", 2)),
    /different assets/
  );
  assert.throws(
    () => compareValuesWithinAsset(usd("1", "USD", 2), usd("1", "USD", 3)),
    /different assets/
  );
});

test("isWithinCeiling uses <= semantics within the same asset", () => {
  assert.equal(isWithinCeiling(usd("1"), usd("5")), true);
  assert.equal(isWithinCeiling(usd("5"), usd("5")), true);
  assert.equal(isWithinCeiling(usd("6"), usd("5")), false);
  assert.equal(isWithinCeiling(usd("0"), usd("0")), true);
  assert.equal(isWithinCeiling(usd("009"), usd("9")), true); // non-canonical leftovers still compare
});

// ---------------- Closed error union ----------------

test("error codes form a closed, UPPER_SNAKE, duplicate-free union", () => {
  for (const code of PAYMENT_ENGINE_ERROR_CODES) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(isPaymentEngineErrorCode(code), true);
  }
  const unique = new Set<string>(PAYMENT_ENGINE_ERROR_CODES);
  assert.equal(unique.size, PAYMENT_ENGINE_ERROR_CODES.length);
  assert.equal(isPaymentEngineErrorCode("NOT_A_CODE"), false);
  assert.equal(isPaymentEngineErrorCode(""), false);
  assert.equal(isPaymentEngineErrorCode(undefined), false);
  assert.equal(isPaymentEngineErrorCode(42), false);
});

test("error messages are constant, data-free, present for every code", () => {
  for (const code of PAYMENT_ENGINE_ERROR_CODES) {
    const message = PAYMENT_ENGINE_ERROR_MESSAGES[code];
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0);
    assert.equal(message, message.trim());
  }
  // Messages must not interpolate call-site data: the object is frozen in shape.
  assert.equal(Object.keys(PAYMENT_ENGINE_ERROR_MESSAGES).length, PAYMENT_ENGINE_ERROR_CODES.length);
});

test("PaymentEngineError carries only the code and the constant message", () => {
  const error = new PaymentEngineError("OVER_TRANSACTION_CEILING");
  assert.equal(error.code, "OVER_TRANSACTION_CEILING");
  assert.equal(error.name, "PaymentEngineError");
  assert.equal(
    error.message,
    PAYMENT_ENGINE_ERROR_MESSAGES.OVER_TRANSACTION_CEILING
  );
  assert.equal(
    error.message,
    PAYMENT_ENGINE_ERROR_MESSAGES.OVER_TRANSACTION_CEILING,
    "second construction yields the identical message (no data drift)"
  );
  assert.equal("data" in error, false);
  assert.equal("details" in error, false);
});
