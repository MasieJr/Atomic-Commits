/**
 * Canonical serialization with explicit contract versioning (L3).
 *
 * PURPOSE: give the backend and the device (Flutter) an agreed, pure
 * canonical byte representation so both sides can compute identical
 * request fingerprints and sign identical bytes in L5. Raw signing is
 * NOT implemented here or anywhere in L3.
 *
 * CANONICAL FORM
 * - UTF-8 bytes.
 * - JSON with keys sorted recursively in ascending lexicographic order
 *   by their UTF-8 code unit order.
 * - No insignificant whitespace between tokens.
 * - Money values appear as strings (never numbers, never exponent forms).
 * - Unsupported version values, unknown top-level shapes, or non-canonical
 *   Money encoding MUST be rejected (throw Error) — never auto-repaired.
 */

export const PAYMENT_ENGINE_CONTRACT_VERSION = "1" as const;

/**
 * A canonicalization-conformant value: JSON-ready leaves where every
 * number is avoided (money is a string) or constrained to be an ample
 * safe integer (epoch milliseconds).
 */
export type CanonicalLeaf =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalLeaf[]
  | { readonly [key: string]: CanonicalLeaf };

export interface CanonicalProtocol {
  readonly version: typeof PAYMENT_ENGINE_CONTRACT_VERSION;
  readonly body: CanonicalLeaf;
}

export interface CanonicalRepresentation {
  readonly json: string;
}

const utf8Encoder = new TextEncoder();

/**
 * UTF-8 byte lexicographic order. UTF-8 preserves code-point order, so
 * this comparator matches a code-point comparison while remaining the
 * exact rule device implementations must reproduce.
 */
function compareUtf8Keys(a: string, b: string): number {
  const aBytes = utf8Encoder.encode(a);
  const bBytes = utf8Encoder.encode(b);
  const commonLength = Math.min(aBytes.length, bBytes.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = aBytes[index] - bBytes[index];
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return aBytes.length < bBytes.length ? -1 : aBytes.length > bBytes.length ? 1 : 0;
}

/** Rejects unsupported protocol versions — never silently coerces. */
function requireSupportedVersion(version: string): void {
  if (version !== PAYMENT_ENGINE_CONTRACT_VERSION) {
    throw new Error("Unsupported payment-engine contract version.");
  }
}

/**
 * Produce a canonical JSON string for the given typed body. Pure, no
 * side effects, no ambient time. Throws on non-canonicalizable leaves.
 */
export function canonicalize(protocol: CanonicalProtocol): CanonicalRepresentation {
  requireSupportedVersion(protocol.version);
  // Bind the version into the canonical bytes so a body shape shared by
  // two protocol versions cannot produce identical fingerprints.
  const json = canonicalJson({
    body: protocol.body,
    version: protocol.version,
  });
  return { json };
}

/**
 * Pure canonical JSON encoder: sorted keys, no whitespace. Money values
 * MUST already be strings before passing here; this function never
 * converts between representations.
 */
export function canonicalJson(value: CanonicalLeaf): string {
  if (value === undefined) {
    throw new Error("Canonical JSON does not support undefined values; omit optional keys.");
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical JSON requires safe integers for numbers.");
    }
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") {
    throw new Error("Canonical JSON does not support this value type.");
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Canonical JSON only accepts plain objects.");
  }
  const keys = Object.keys(value).sort(compareUtf8Keys);
  const parts: string[] = [];
  for (const key of keys) {
    const untyped = (value as { [key: string]: CanonicalLeaf })[key];
    if (untyped === undefined) {
      throw new Error("Canonical JSON does not support undefined values; omit optional keys.");
    }
    parts.push(JSON.stringify(key) + ":" + canonicalJson(untyped));
  }
  return "{" + parts.join(",") + "}";
}

/** Exact UTF-8 bytes of the canonical representation. */
export function canonicalUtf8Bytes(representation: CanonicalRepresentation): Uint8Array {
  return utf8Encoder.encode(representation.json);
}

/** Pure UTF-8 byte length for the canonical representation. */
export function canonicalUtf8ByteLength(representation: CanonicalRepresentation): number {
  return canonicalUtf8Bytes(representation).byteLength;
}
