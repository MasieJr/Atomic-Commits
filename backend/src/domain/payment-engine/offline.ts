/**
 * Offline redemption credential types (L3 contract).
 *
 * These types describe the SHAPE of signed device instructions and their
 * redemption envelopes. Actual signature creation/verification is L5
 * scope; this module only defines declarative bindings and versioning,
 * with NO crypto implementation and NO Date.now inside domain logic.
 */

/**
 * Contract version for offline credential representation.
 * Any structural change bumps this and requires a migration note in
 * docs/payment-engine-contract.md.
 */
export const OFFLINE_INSTRUCTION_VERSION = "1" as const;

/** Opaque single-use nonce: NEVER reused across any two issued instructions. */
export type InstructionNonce = string;

/** A signed, device-issued instruction to debit up to maxDebitMinor without connectivity. */
export interface SignedInstruction {
  /** Schema version of the instruction; must equal OFFLINE_INSTRUCTION_VERSION. */
  readonly version: typeof OFFLINE_INSTRUCTION_VERSION;
  readonly instructionId: string;
  readonly nonce: InstructionNonce;
  /** Identifies which device/enrollment key signed this instruction. */
  readonly keyVersion: string;
  readonly instructionEpochMs: number;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  /** Upper bound on the potential payer debit for the instruction. */
  readonly maxDebitMinor: string;
  readonly assetCode: string;
  readonly assetScale: number;
  /**
   * Opcode-free opaque instruction bytes. Signing/verification lives in
   * L5; adapters must treat this as opaque.
   */
  readonly bytesB64Utf8: string;
}

/** Fully-formed, signed offline redemption envelope bound to one grant and one device. */
export interface OfflineEnvelope {
  readonly version: typeof OFFLINE_INSTRUCTION_VERSION;
  readonly envelopeId: string;
  readonly instruction: SignedInstruction;
  /** Authorization this envelope may redeem against. */
  readonly authorizationId: string;
  /** Grant-scoped revocation version at issuance time. */
  readonly grantRevocationVersion: number;
  /** Enrolled-device binding: an opaque enrollment identifier. */
  readonly deviceEnrollmentId: string;
  /** Merchant binding, present only when the credential is merchant-specific. */
  readonly merchantScopeId?: string;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

/**
 * Result-shaped claim record (NOT the enforcement port; see ports.ts).
 * A claim record says "credential X was redeemed under grant Y by user Z";
 * it never contains token material.
 */
export interface RedemptionClaim {
  readonly version: typeof OFFLINE_INSTRUCTION_VERSION;
  readonly instructionId: string;
  readonly nonce: InstructionNonce;
  readonly authorizationId: string;
  readonly userId: number;
  readonly envelopeId: string;
  readonly deviceEnrollmentId: string;
  readonly claimedAtEpochMs: number;
  /** Potential ceiling that was reserved at claim time. */
  readonly reservedMaxDebit: string;
}

/** True iff the clock time is inside the credential's validity window. */
export function isEnvelopeWithinValidityWindow(
  envelope: OfflineEnvelope,
  nowEpochMs: number
): boolean {
  return nowEpochMs >= envelope.issuedAtEpochMs && nowEpochMs <= envelope.expiresAtEpochMs;
}

/**
 * The envelope window is authoritative for redemption and must be a
 * subset of the signed instruction's own window; otherwise the two
 * representations disagree and the envelope is malformed.
 */
export function isEnvelopeWindowWithinInstruction(envelope: OfflineEnvelope): boolean {
  return (
    envelope.issuedAtEpochMs >= envelope.instruction.issuedAtEpochMs &&
    envelope.expiresAtEpochMs <= envelope.instruction.expiresAtEpochMs
  );
}

/**
 * True iff this instruction's nonce is not present in the supplied seen
 * set. This is a local, non-authoritative convenience check only: global
 * single-use enforcement belongs to AtomicClaimPort and must be
 * transactional across replicas.
 */
export function isNonceUnseen(
  envelope: OfflineEnvelope,
  seenNonces: readonly InstructionNonce[]
): boolean {
  const nonce = envelope.instruction.nonce;
  return !seenNonces.includes(nonce);
}
