/**
 * Money — canonical domain type for payment-engine amounts (L3 contract).
 *
 * INVARIANTS
 * - `value` is ALWAYS a string holding an unsigned integer in the asset's
 *   MINOR UNITS (e.g. cents). It is never a JS number and never a float.
 *   Rationale: JS numbers silently round above 2^53; provider quotes are
 *   exact integers.
 * - Canonical form: no leading zeros (the literal "0" is fine), no sign,
 *   no separators. Canonicalization is the FIRST validation step; a value
 *   that has leading zeros is rejected, not rewritten.
 * - `assetCode` is a non-empty exact string (e.g. "USD"). This layer only
 *   validates non-emptiness; it does NOT constrain the permitted set of
 *   codes and NEVER performs currency conversion.
 * - `assetScale` is an integer 0..255: how many of the numeric digits
 *   after the ledger's decimal separator constitute the minor unit.
 *
 * PAYER DEBIT vs MERCHANT RECEIVE — two DIFFERENT concepts:
 * Money in a payer-debit field is measured against the provider quote for
 * the PAYER (ceiling amounts therefore apply to the payer debit money),
 * while Money in a merchant-receive field describes units the merchant
 * receives. They live in possibly different assets/scales and MUST NEVER
 * be compared or converted with each other by domain logic.
 */

import { PaymentEngineError } from "./errors";

/** Canonical unsigned-integer minor-units string; "0" allowed, no leading zeros. */
export type MinorUnitsString = string;

export interface Money {
  readonly value: MinorUnitsString;
  readonly assetCode: string;
  readonly assetScale: number;
}

/** Pure predicate. Returns true iff `money` is structurally and canonically valid. */
export function isValidMoney(money: unknown): money is Money {
  if (typeof money !== "object" || money === null) return false;
  const candidate = money as Partial<Money>;
  const scale = (candidate as { assetScale?: unknown }).assetScale;
  return (
    isCanonicalUnsignedIntegerString(candidate.value) &&
    typeof candidate.assetCode === "string" &&
    candidate.assetCode.trim().length > 0 &&
    typeof scale === "number" &&
    Number.isSafeInteger(scale) &&
    scale >= 0 &&
    scale <= 255
  );
}

/**
 * True iff the string is a canonical unsigned integer:
 * digits only, no leading zeros unless the entire string is "0".
 * Longer strings beyond Number.MAX_SAFE_INTEGER are still lexically valid
 * here; numeric-consumption boundaries must handle bigint precision.
 */
export function isCanonicalUnsignedIntegerString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (!/^[0-9]+$/.test(value)) return false;
  if (value.length > 1 && value.startsWith("0")) return false;
  return true;
}

/** Non-canonical but parseable unsigned integer string (digits, maybe leading zeros). */
function isUnsignedIntegerStringLoose(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value) && value.length > 0;
}

/**
 * Canonicalize an arbitrary string into a Money instance.
 * Throws Error (caller maps to INVALID_MONEY) on malformed input.
 * Rejects signs, separators, floats, negative values, non-integers,
 * and values with leading zeros — they fail canonical-form check even
 * though they might numerically equal a canonical value.
 */
export function makeMoney(value: string, assetCode: string, assetScale: number): Money {
  if (
    !isUnsignedIntegerStringLoose(value) ||
    !isCanonicalUnsignedIntegerString(value) ||
    typeof assetCode !== "string" ||
    assetCode.trim().length === 0 ||
    !Number.isSafeInteger(assetScale) ||
    assetScale < 0 ||
    assetScale > 255
  ) {
    throw new PaymentEngineError("INVALID_MONEY");
  }
  return { value, assetCode, assetScale };
}

/** True iff both amounts belong to the same asset (code AND scale). */
export function sameAsset(a: Money, b: Money): boolean {
  return a.assetCode === b.assetCode && a.assetScale === b.assetScale;
}

/**
 * Lexicographic comparison valid ONLY for canonical unsigned strings
 * (which our validation guarantees). Never use with non-Money-carrying
 * values or across different assets.
 * Returns a negative number if a < b, 0 if equal, positive if a > b.
 */
export function compareValuesWithinAsset(a: Money, b: Money): number {
  if (!sameAsset(a, b)) {
    throw new Error("compareValuesWithinAsset must never be called across different assets.");
  }
  const aTrim = stripLeadingZeros(a.value);
  const bTrim = stripLeadingZeros(b.value);
  const lenDiff = aTrim.length - bTrim.length;
  if (lenDiff !== 0) return lenDiff < 0 ? -1 : 1;
  if (aTrim === bTrim) return 0;
  return aTrim < bTrim ? -1 : 1;
}

function stripLeadingZeros(value: string): string {
  if (value === "0") return value;
  const trimmed = value.replace(/^0+/, "");
  return trimmed.length === 0 ? "0" : trimmed;
}

/** True iff a <= b within the same asset. */
export function isWithinCeiling(debit: Money, ceiling: Money): boolean {
  return compareValuesWithinAsset(debit, ceiling) <= 0;
}
