import type { GrantWithAccessToken } from "@interledger/open-payments";

import { minorValue, sameAsset, type Amount } from "./payment-proof-run";

// the returned grant's access entries use the authorization-server schemas;
// derive the outgoing variants from the installed SDK types instead of inventing shapes
type ReturnedAccessEntry = GrantWithAccessToken["access_token"]["access"][number];
export type ReturnedOutgoingAccessEntry = Extract<ReturnedAccessEntry, { type: "outgoing-payment" }>;
// the raw SDK-derived limits variant (no longer returned to callers; kept for tests/inspection)
export type ReturnedOutgoingLimits = NonNullable<ReturnedOutgoingAccessEntry["limits"]>;

// fresh, narrow money/limit shapes handed to callers so raw provider objects and
// provider-specific extra fields can never reach reports, evidence or downstream code
export interface SanitizedMoney {
  value: string;      // exact integer minor-unit string
  assetCode: string;
  assetScale: number; // integer within the SDK amount schema's 0..255 range
}

export interface SanitizedOutgoingLimits {
  debitAmount: SanitizedMoney;
  // only present when a receiver restriction was requested and matched exactly
  receiver?: string;
}

// what the code intended the provider to approve before it answered
export interface IntendedOutgoingApproval {
  payerId: string;
  requestedDebit: Amount;
  // absent: deliberately unrestricted approval, as in Proof B
  requestedReceiver?: string;
}

// validated pieces of the returned grant that payments and reports may rely on
export interface ValidatedOutgoingGrant {
  budget: SanitizedMoney;   // the provider's own returned debit cap; no fallback to the request
  limits: SanitizedOutgoingLimits;
  expiresInSeconds: number; // positive seconds whose millisecond value is a safe integer
}

// reuse the project's exact integer minor-unit grammar (no sign, no leading zeros, <=18 digits)
function strictPositiveAmount(amount: Amount, description: string): bigint {
  if (typeof amount !== "object" || amount === null) {
    throw new Error(`The ${description} debit amount is missing or malformed.`);
  }
  if (typeof amount.value !== "string") {
    throw new Error(`The ${description} debit amount value is not an exact integer string.`);
  }
  if (typeof amount.assetCode !== "string" || amount.assetCode === "") {
    throw new Error(`The ${description} debit amount carries no asset code.`);
  }
  if (typeof amount.assetScale !== "number" || !Number.isInteger(amount.assetScale) || amount.assetScale < 0 || amount.assetScale > 255) {
    throw new Error(`The ${description} debit amount asset scale is malformed or outside the supported range.`);
  }
  let value: bigint;
  try {
    value = minorValue(amount.value);
  } catch {
    throw new Error(`The ${description} debit amount is not a valid integer minor-unit string.`);
  }
  if (value <= 0n) {
    throw new Error(`The ${description} debit amount must be a positive minor-unit value.`);
  }
  return value;
}

function validateIntended(intended: IntendedOutgoingApproval): bigint {
  if (typeof intended !== "object" || intended === null) {
    throw new Error("The intended outgoing approval must be described to validate a returned grant.");
  }
  if (typeof intended.payerId !== "string" || intended.payerId === "") {
    throw new Error("The intended payer wallet identifier is missing.");
  }
  const requestedValue = strictPositiveAmount(intended.requestedDebit, "requested");
  if (
    intended.requestedReceiver !== undefined &&
    (typeof intended.requestedReceiver !== "string" || intended.requestedReceiver === "")
  ) {
    throw new Error("The requested receiver restriction must be an address string or deliberately absent.");
  }
  return requestedValue;
}

// decide what the provider actually granted, strictly, before any payment uses it.
// pure and deterministic: no provider calls, no wall clock, no token values in messages.
// scope, budget, receiver and timing must all be verifiable or the grant is rejected (fail closed).
export function validateReturnedOutgoingGrant(
  grant: GrantWithAccessToken,
  intended: IntendedOutgoingApproval,
): ValidatedOutgoingGrant {
  // reject null/malformed top-level shapes with a constant error instead of a TypeError
  if (typeof grant !== "object" || grant === null) {
    throw new Error("The provider returned no verifiable grant for the outgoing payment.");
  }
  const token = grant.access_token;
  if (typeof token !== "object" || token === null) {
    throw new Error("The provider returned no verifiable access token for the outgoing payment.");
  }
  // validate what was requested before spending attention on the returned data
  const requestedValue = validateIntended(intended);

  // additional access entries of any type are authority we did not ask for
  const access = token.access;
  if (!Array.isArray(access) || access.length !== 1) {
    throw new Error("The provider returned an access scope list that does not match the single requested outgoing-payment scope.");
  }
  const entry = access[0];
  if (typeof entry?.type !== "string" || entry.type !== "outgoing-payment") {
    throw new Error("The finalized grant does not carry exactly one outgoing-payment scope for the intended payer.");
  }
  const outgoing = entry as ReturnedOutgoingAccessEntry;
  if (outgoing.identifier !== intended.payerId) {
    throw new Error("The provider granted outgoing access for a wallet other than the intended payer.");
  }
  const actions = outgoing.actions;
  if (!Array.isArray(actions) || actions.length !== 2 || !actions.includes("create") || !actions.includes("read")) {
    throw new Error("The provider granted outgoing-payment actions other than exactly create and read.");
  }

  const limits = outgoing.limits;
  if (typeof limits !== "object" || limits === null) {
    throw new Error("The provider returned no usable spending limits; a debit cap is required.");
  }

  // limit fields outside this grant's purpose describe authority whose semantics cannot be
  // verified here; fail closed with a constant message that echoes no provider data
  for (const key of Object.keys(limits)) {
    if (key !== "receiver" && key !== "debitAmount") {
      throw new Error("The provider returned unrequested limit fields whose authority semantics cannot be verified.");
    }
  }
  if (!("debitAmount" in limits)) {
    throw new Error("The provider returned no debit cap for the outgoing grant; an unverifiable budget cannot be trusted.");
  }

  // receiver restrictions must match what was requested in both directions
  if (intended.requestedReceiver === undefined) {
    if (limits.receiver !== undefined) {
      throw new Error("The provider bound the unrestricted grant to a receiver that was not requested.");
    }
  } else if (limits.receiver === undefined) {
    throw new Error("The provider omitted the requested receiver restriction from the returned grant.");
  } else if (limits.receiver !== intended.requestedReceiver) {
    throw new Error("The provider granted a receiver restriction different from the one requested.");
  }

  // accept exact or provider-narrowed positive budgets only
  const returnedDebit = limits.debitAmount;
  const returnedValue = strictPositiveAmount(returnedDebit, "returned");
  if (!sameAsset(returnedDebit, intended.requestedDebit)) {
    throw new Error("The provider returned a debit cap in a different asset or scale than requested.");
  }
  if (returnedValue > requestedValue) {
    throw new Error("The provider returned a debit cap larger than the requested budget.");
  }

  // absent/invalid timing cannot become assumed permission; SDK permits omission, so this is deliberate
  // policy. only reject what machine arithmetic cannot verify exactly: no product lifetime is invented.
  const expiresIn = token.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isSafeInteger(expiresIn * 1000)) {
    throw new Error("The provider did not advertise a finite positive expiry that yields safe integer milliseconds.");
  }

  // rebuild fresh objects with only verified fields; the value is re-serialized from the
  // parsed BigInt, and the receiver comes from the request it was proven equal to
  const budget: SanitizedMoney = {
    value: returnedValue.toString(),
    assetCode: returnedDebit.assetCode,
    assetScale: returnedDebit.assetScale,
  };
  const sanitizedLimits: SanitizedOutgoingLimits = {
    debitAmount: budget,
    ...(intended.requestedReceiver === undefined ? {} : { receiver: intended.requestedReceiver }),
  };
  return { budget, limits: sanitizedLimits, expiresInSeconds: expiresIn };
}
