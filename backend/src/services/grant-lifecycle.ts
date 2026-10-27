import { OpenPaymentsClientError, type AccessToken, type OutgoingPaymentGrantSpentAmounts } from "@interledger/open-payments";

import { testWalletUrl } from "./grant-interaction";
import { validateReturnedOutgoingGrant, type SanitizedMoney } from "./outgoing-grant-validation";
import { minorValue, sameAsset, type Amount } from "./payment-proof-run";

// why a lifecycle operation stopped. no category, detail or message implies renewed consent,
// or that the grant was revoked or expired; only evidence-backed classifications are exposed.
// REAUTH_REQUIRED is set explicitly via markReauthRequired() and means "owner action needed",
// never "the underlying provider grant is proven to have expired".
export type GrantLifecycleErrorCategory =
  | "ROTATION_BUSY"
  | "ROTATION_REJECTED"
  | "UNVERIFIABLE_AUTHORITY"
  | "UNVERIFIABLE_SCOPE"
  | "UNVERIFIABLE_COUNTER"
  | "AMBIGUOUS_ROTATION"
  | "REAUTH_REQUIRED";

// explicit lifecycle phase, kept readable for tests and evidence
export type GrantLifecyclePhase = "READY" | "ROTATION_IN_FLIGHT" | "BLOCKED" | "REAUTH_REQUIRED";

// safe, sanitized rotation-rejection evidence: enumerated provider fields only.
// error.description is never included; it would have to pass a known redactor first.
export interface GrantLifecycleErrorDetail {
  classification: "DEFINITIVE_PROVIDER_REJECTION" | "UNKNOWN_OUTCOME";
  providerStatus?: number;
  providerCode?: string;
}

// constant, data-free messages; provider errors, tokens and URIs must never be appended
export class GrantLifecycleError extends Error {
  constructor(
    readonly category: GrantLifecycleErrorCategory,
    message: string,
    readonly detail?: GrantLifecycleErrorDetail,
  ) {
    super(message);
    this.name = "GrantLifecycleError";
  }
}

// SDK operations and environment, injectable so the whole lifecycle is mockable.
// rotateToken matches client.token.rotate({ url, accessToken }) -> AccessToken;
// readSpentAmounts matches client.outgoingPayment.getGrantSpentAmounts({ url, accessToken }).
export interface GrantLifecyclePorts {
  rotateToken(args: { url: string; accessToken: string }): Promise<AccessToken>;
  readSpentAmounts(args: { url: string; accessToken: string }): Promise<OutgoingPaymentGrantSpentAmounts>;
  // monotonic wall clock in milliseconds, injected so timing decisions stay testable
  clock(): number;
  // registers secrets for redaction before any validation or logging; string values only
  rememberSecret(value: string): void;
}

// the current, already-validated outgoing authority; rotation returns the same shape.
// continuation (grant continue uri/token) is deliberately absent: token rotation replaces
// only the access token and its manage URI, while the grant continuation stays separate
// and remains the authority for a later grant.cancel.
export interface OutgoingGrantAuthority {
  accessToken: string;
  // manage URI of the current token; rotation is impossible without a usable one
  manageUrl?: string;
  // advertised expiry of the current token in ms epoch; absent means unverifiable, never unbounded
  expiresAt?: number;
  payerId: string;
  // the resource-server base URL used to read the provider spent counter
  resourceServerUrl: string;
  // the currently accepted debit cap, already validated and possibly provider-narrowed
  budget: SanitizedMoney;
  // undefined = deliberately unrestricted approval, as in Proof B
  receiver?: string;
}

export interface ValidatedSpentCounter {
  // clock milliseconds at which this reading was requested
  readAt: number;
  // provider-reported debit spending in the grant cap's exact units
  spentDebit: SanitizedMoney;
}

// small development safety margin kept before attempting a rotation on a nearly expired
// token; deliberately not a product lifetime. any computed expiry value must still satisfy
// the safe-integer and Date checks after the request.
const ROTATION_REQUEST_MARGIN_MS = 1000;

// mirror of the submission code's definitive-rejection rule: a 4xx response without
// validation problems is a definite provider answer, so the rotation request itself
// was refused. 408 and validator failures remain ambiguous; returns the narrowed error
// only when the rejection is definitive.
function definitiveRotationRejection(error: unknown): OpenPaymentsClientError | null {
  if (!(error instanceof OpenPaymentsClientError)) return null;
  const definitive = error.status !== undefined && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && !error.validationErrors?.length;
  return definitive ? error : null;
}

// protocol enum from the SDK's generated auth-server error schema: the only code values
// an authorization-server grant/token response can carry. anything else is free-form
// provider text and must never enter sanitized evidence detail.
const PROTOCOL_ERROR_CODES = [
  "invalid_client",
  "invalid_request",
  "request_denied",
  "too_fast",
  "invalid_continuation",
  "invalid_rotation",
] as const;

// keep only actual known auth SDK enum values; arbitrary provider strings are omitted
function knownProtocolCode(code: string | undefined): string | undefined {
  return code !== undefined && (PROTOCOL_ERROR_CODES as readonly string[]).includes(code) ? code : undefined;
}

// parse the project's exact integer minor-unit grammar, allowing zero (idle counters),
// and classify any violation under the caller's category without echoing provider data
function parseExactAmount(amount: Amount, description: string, category: GrantLifecycleErrorCategory): bigint {
  if (typeof amount !== "object" || amount === null) {
    throw new GrantLifecycleError(category, `The ${description} is missing or malformed.`);
  }
  if (typeof amount.value !== "string") {
    throw new GrantLifecycleError(category, `The ${description} value is not an exact integer string.`);
  }
  if (typeof amount.assetCode !== "string" || amount.assetCode === "") {
    throw new GrantLifecycleError(category, `The ${description} carries no asset code.`);
  }
  if (typeof amount.assetScale !== "number" || !Number.isInteger(amount.assetScale) || amount.assetScale < 0 || amount.assetScale > 255) {
    throw new GrantLifecycleError(category, `The ${description} asset scale is malformed or outside the supported range.`);
  }
  try {
    return minorValue(amount.value);
  } catch {
    throw new GrantLifecycleError(category, `The ${description} is not a valid integer minor-unit string.`);
  }
}

// development harness for the lifecycle of ONE payer-approved outgoing spending grant:
// validate a rotation in place (never a fresh consent or auto-granted renewal), keep the
// spent counter honest across rotations, and block all further spending the moment any
// authority, scope, counter or outcome becomes unverifiable. any validation error after a
// rotation may have reached the provider poisons the lifecycle; the block is released by a
// human decision, never by issuing new payments. this is in-memory proof state, not a
// durable production service.
export class OutgoingGrantLifecycle {
  private inFlight = false;
  private blocked?: GrantLifecycleError;
  private ownerActionRequired?: GrantLifecycleError;
  // token values and token/manage pairs already consumed by successful rotations.
  // replay protection tracks pairs: providers may repeat a manage URL with a genuinely
  // new token, so no URL is banned by itself; consumed tokens are never reused.
  private readonly consumedTokenValues = new Set<string>();
  private readonly consumedPairs = new Set<string>();
  // the token/management pair this lifecycle currently trusts, when it has seen one already
  private current?: { accessToken: string; manageUrl?: string };

  constructor(private readonly ports: GrantLifecyclePorts) {}

  get phase(): GrantLifecyclePhase {
    if (this.inFlight) return "ROTATION_IN_FLIGHT";
    if (this.blocked) return "BLOCKED";
    if (this.ownerActionRequired) return "REAUTH_REQUIRED";
    return "READY";
  }

  get blockReason(): GrantLifecycleErrorCategory | undefined {
    return (this.blocked ?? this.ownerActionRequired)?.category;
  }

  // spending seams (a future payment submission path) call this before any debit attempt
  requireSpendable(): void {
    if (this.blocked) throw this.blocked;
    if (this.ownerActionRequired) throw this.ownerActionRequired;
    if (this.inFlight) {
      throw new GrantLifecycleError("ROTATION_BUSY", "A token rotation is in flight, so spending must wait for its outcome.");
    }
  }

  // record an explicit owner-action outcome: this does not assert that the provider grant
  // expired, was revoked, or lost consent; it says a human must authorize further use.
  markReauthRequired(): void {
    if (!this.blocked) {
      this.ownerActionRequired ??= new GrantLifecycleError("REAUTH_REQUIRED", "Owner re-authorization is required before this grant can be used again; this flag alone does not claim the provider grant expired.");
    }
  }

  // one rotation at a time; the lock is set synchronously before anything is awaited
  async rotate(authority: OutgoingGrantAuthority): Promise<OutgoingGrantAuthority> {
    if (this.inFlight) {
      throw new GrantLifecycleError("ROTATION_BUSY", "Another token rotation is already in flight for this grant.");
    }
    if (this.blocked) throw this.blocked;
    if (this.ownerActionRequired) throw this.ownerActionRequired;
    this.inFlight = true;
    try {
      return await this.rotateAuthority(authority);
    } finally {
      this.inFlight = false;
    }
  }

  // read and strictly validate the provider's spent counter. reads stay possible while
  // BLOCKED (for diagnostics), but any invalid counter poisons spending until release.
  async verifySpentCounter(authority: { accessToken: string; budget: SanitizedMoney; resourceServerUrl: string }): Promise<ValidatedSpentCounter> {
    const readAt = this.ports.clock();
    let amounts: OutgoingPaymentGrantSpentAmounts;
    try {
      amounts = await this.ports.readSpentAmounts({ url: authority.resourceServerUrl, accessToken: authority.accessToken });
    } catch {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_COUNTER", "The provider's spent counter could not be read; debits stay blocked until it is known."));
    }
    try {
      if (typeof amounts !== "object" || amounts === null) {
        throw new GrantLifecycleError("UNVERIFIABLE_COUNTER", "The provider returned no usable spent counter; debits stay blocked until it is known.");
      }
      const spent = amounts.spentDebitAmount;
      // an absent counter cannot be verified against the cap; a genuinely idle provider
      // behavior here stays a reconciling question for a human, not a passing assumption
      if (spent === null) {
        throw new GrantLifecycleError("UNVERIFIABLE_COUNTER", "The provider reported no debit spending counter, so it cannot be verified against the grant cap.");
      }
      const spentValue = parseExactAmount(spent, "provider spent debit amount", "UNVERIFIABLE_COUNTER");
      if (!sameAsset(spent, authority.budget)) {
        throw new GrantLifecycleError("UNVERIFIABLE_COUNTER", "The provider's spent counter uses a different asset or scale than the grant cap.");
      }
      const budgetValue = parseExactAmount(authority.budget, "accepted grant cap", "UNVERIFIABLE_COUNTER");
      if (spentValue > budgetValue) {
        throw new GrantLifecycleError("UNVERIFIABLE_COUNTER", "The provider's spent counter exceeds the accepted grant cap, so the reported spending cannot be verified.");
      }
      // fresh sanitized reading; the counter may legitimately be zero on an idle grant
      return {
        readAt,
        spentDebit: {
          value: spentValue.toString(),
          assetCode: spent.assetCode,
          assetScale: spent.assetScale,
        },
      };
    } catch (error) {
      // nothing here may leave the lifecycle trusting an unverifiable counter
      if (error instanceof GrantLifecycleError) throw this.poison(error);
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_COUNTER", "The provider's spent counter could not be validated; debits stay blocked until it is known."));
    }
  }

  private async rotateAuthority(authority: OutgoingGrantAuthority): Promise<OutgoingGrantAuthority> {
    // pre-call checks fail closed without poisoning: nothing was sent yet
    const manage = this.requireRotatableAuthority(authority);
    const requestStartedAt = this.ports.clock();
    // the counter must be provable before asking anything to rotate
    const before = await this.verifySpentCounter(authority);
    // network reads take time; never POST a rotation on a token whose advertised deadline
    // no longer leaves a safe request margin
    const beforeDeadline = authority.expiresAt;
    if (typeof beforeDeadline !== "number" || beforeDeadline - this.ports.clock() <= ROTATION_REQUEST_MARGIN_MS) {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The current token's advertised deadline leaves no safe request margin, so rotation was not attempted.");
    }

    let rotated: AccessToken;
    try {
      rotated = await this.ports.rotateToken({ url: manage, accessToken: authority.accessToken });
    } catch (error) {
      // a definitive refusal describes only this rotation request; a generic 401 or
      // invalid_rotation is never read as "grant revoked/expired/consent lost"
      const provider = definitiveRotationRejection(error);
      if (provider) {
        const providerCode = knownProtocolCode(provider.code);
        throw this.poison(new GrantLifecycleError("ROTATION_REJECTED", "The provider definitively refused this rotation request; this refuses the rotation itself and makes no claim about the grant's consent or expiry.", {
          classification: "DEFINITIVE_PROVIDER_REJECTION",
          ...(provider.status === undefined ? {} : { providerStatus: provider.status }),
          // whitelisted protocol enum only; free-form provider code text is omitted
          ...(providerCode === undefined ? {} : { providerCode }),
        }));
      }
      throw this.poison(new GrantLifecycleError("AMBIGUOUS_ROTATION", "The rotation outcome is unknown; an earlier attempt may have succeeded. Reconcile with the provider before any further use.", {
        classification: "UNKNOWN_OUTCOME",
      }));
    }
    // register every new secret before any validation or logging, string values only
    const rotatedToken = rotated?.access_token;
    if (typeof rotatedToken?.value !== "string" || rotatedToken.value === "") {
      throw this.poison(new GrantLifecycleError("AMBIGUOUS_ROTATION", "The rotation response carried no usable access token value, so the replacement state is unknown."));
    }
    this.ports.rememberSecret(rotatedToken.value);
    if (typeof rotatedToken.manage === "string") this.ports.rememberSecret(rotatedToken.manage);

    if (rotatedToken.value === authority.accessToken) {
      throw this.poison(new GrantLifecycleError("AMBIGUOUS_ROTATION", "The provider returned the same token value, so token replacement could not be confirmed."));
    }
    // a value that ANY earlier rotation already consumed is never acceptable again,
    // whatever manage URI it arrived with; poison before installing the current pair
    // or reading the post-rotation counter
    if (this.consumedTokenValues.has(rotatedToken.value)) {
      throw this.poison(new GrantLifecycleError("AMBIGUOUS_ROTATION", "The provider returned a token value that an earlier rotation already consumed, so the replacement state cannot be distinct."));
    }

    // revalidate the rotated rights strictly against the CURRENT accepted cap/payer/receiver,
    // never against the original, wider request; even provider-narrowing fails the
    // unchanged-cap requirement of this experiment, and any changed rights fail closed
    let validated;
    try {
      validated = validateReturnedOutgoingGrant(
        { access_token: rotatedToken, continue: { access_token: { value: "" }, uri: "" } },
        {
          payerId: authority.payerId,
          requestedDebit: authority.budget,
          ...(authority.receiver === undefined ? {} : { requestedReceiver: authority.receiver }),
        },
      );
    } catch (error) {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_SCOPE", "The rotated grant's rights did not revalidate against the accepted authorization."));
    }
    if (minorValue(validated.budget.value) !== minorValue(authority.budget.value)) {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_SCOPE", "The rotated grant's total debit cap differs from the accepted cap; this experiment requires an unchanged total."));
    }
    // the rotated manage URI must be usable immediately; without it no further rotation or
    // revocation is possible, and the old authority is already consumed server-side
    if (typeof rotatedToken.manage !== "string" || rotatedToken.manage === "") {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The rotated token carries no management URI, so its lifecycle cannot be continued or revoked."));
    }
    try {
      testWalletUrl(rotatedToken.manage);
    } catch {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The rotated token's management URI is outside the supported Test Wallet endpoints."));
    }
    // conservative, request-anchored expiry: measured from before the rotation was sent
    const expiresAt = requestStartedAt + validated.expiresInSeconds * 1000;
    if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime())) {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_SCOPE", "The rotated token advertises an expiry that machine arithmetic cannot represent safely."));
    }

    // the old authority is consumed from now on, whatever it still looked like locally
    this.consumedTokenValues.add(authority.accessToken);
    this.consumedPairs.add(`${authority.accessToken}\n${manage}`);
    this.current = { accessToken: rotatedToken.value, manageUrl: rotatedToken.manage };

    // the counter must survive the rotation exactly: invalid, reset or moved readings block
    const after = await this.verifySpentCounter({ accessToken: rotatedToken.value, budget: validated.budget, resourceServerUrl: authority.resourceServerUrl });
    if (minorValue(after.spentDebit.value) !== minorValue(before.spentDebit.value)) {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_COUNTER", "The provider's spent counter changed across rotation, which cannot be explained while no payment is in flight."));
    }
    // network delay can exhaust the advertised window; a live deadline is required for use
    if (this.ports.clock() >= expiresAt) {
      throw this.poison(new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The rotated token's usable deadline already passed, so no spending authority can be verified."));
    }

    return {
      accessToken: rotatedToken.value,
      manageUrl: rotatedToken.manage,
      expiresAt,
      payerId: authority.payerId,
      resourceServerUrl: authority.resourceServerUrl,
      budget: validated.budget,
      ...(validated.limits.receiver === undefined ? {} : { receiver: validated.limits.receiver }),
    };
  }

  // pre-call authority validation: fail closed on absent/expired tokens or unusable manage URIs
  private requireRotatableAuthority(authority: OutgoingGrantAuthority): string {
    if (typeof authority !== "object" || authority === null) {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "No current outgoing authority was supplied.");
    }
    if (typeof authority.accessToken !== "string" || authority.accessToken === "") {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The current outgoing access token is absent.");
    }
    const manage = authority.manageUrl;
    if (typeof manage !== "string" || manage === "") {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The provider did not give this token a management URI, so it cannot be rotated.");
    }
    try {
      testWalletUrl(manage);
    } catch {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The token management URI is outside the supported Test Wallet endpoints.");
    }
    if (
      this.consumedTokenValues.has(authority.accessToken) ||
      this.consumedPairs.has(`${authority.accessToken}\n${manage}`)
    ) {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "This token authority was already consumed by an earlier rotation and may not be reused.");
    }
    if (this.current && (this.current.accessToken !== authority.accessToken || this.current.manageUrl !== manage)) {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The supplied authority does not match the current grant token held by this lifecycle.");
    }
    const budgetValue = parseExactAmount(authority.budget, "accepted grant cap", "UNVERIFIABLE_AUTHORITY");
    if (budgetValue <= 0n) {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The accepted grant cap must be a positive amount.");
    }
    // absent expiry is unverifiable timing, not an assumed long-lived token
    const expiresAt = authority.expiresAt;
    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || !Number.isFinite(new Date(expiresAt).getTime()) || expiresAt <= this.ports.clock()) {
      throw new GrantLifecycleError("UNVERIFIABLE_AUTHORITY", "The current outgoing token is already expired or its deadline cannot be verified.");
    }
    return manage;
  }

  private poison(error: GrantLifecycleError): GrantLifecycleError {
    // keep the first block reason; spending stays blocked until a human releases it
    this.blocked ??= error;
    return this.blocked;
  }
}
