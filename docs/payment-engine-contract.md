# Payment Engine — Domain Contract (L3)

Owner of this document: L3 contract work. Consumers: **Josue** (API/persistence adapters) and **Massi** (Flutter client); **Leeroy** (engine decision tests with in-memory fakes).

## 0. What this is, and what it is NOT

L3 defines the transport-independent payment-engine domain: types, errors, and explicit ports under `backend/src/domain/payment-engine/`. The L4/L5 draft adds backend signature verification and offline policy alongside those contracts; it has **no device signing, adapters, controllers, SQL/DB code, notification workers, Flutter code, or live provider operations**. See `docs/offline-spending-and-signed-qr.md` for the draft's separate wire format and integration gates.

Contract version: `PAYMENT_ENGINE_CONTRACT_VERSION = "1"` (`serialization.ts`). Offline instruction schema version: `OFFLINE_INSTRUCTION_VERSION = "1"` (`offline.ts`).

These contracts support independent adapter development with in-memory fakes. The 2026-10-28 live Proof C run **PASSED** for the configured Test Wallet pair, including two rotations and a confirmed transfer after 25 minutes. That observation does not by itself enable offline redemption, durable recovery or real-money use. See `docs/payment-proof-c.md` for the evidence and limits.

## 1. File map and exported API surface

| File | Exports |
| --- | --- |
| `money.ts` | `Money`, `MinorUnitsString`, `isValidMoney`, `isCanonicalUnsignedIntegerString`, `makeMoney`, `sameAsset`, `compareValuesWithinAsset`, `isWithinCeiling` |
| `errors.ts` | `PaymentEngineErrorCode` (closed union), `PAYMENT_ENGINE_ERROR_CODES`, `PAYMENT_ENGINE_ERROR_MESSAGES`, `PaymentEngineError`, `isPaymentEngineErrorCode` |
| `payments.ts` | `UserId`, `isValidUserId`, `PaymentStatus`, `IN_PROGRESS_PAYMENT_STATUSES`, `UNRESOLVED_PAYMENT_STATUSES`, `NON_TERMINAL_PAYMENT_STATUSES`, `TERMINAL_PAYMENT_STATUSES`, `PAYMENT_STATUSES`, `isPaymentStatus`, `isTerminalStatus`, `isUnresolvedStatus`, `isInProgressStatus`, `PayeeIdentity`, `PaymentIntent`, `PaymentAttempt`, `PaymentResult`, `OnlinePaymentCommand`, `OfflineRedemptionCommand`, `PaymentQuote`, `EligibilityDecisionInput`, `EligibilityDecision` |
| `grants.ts` | `GrantAuthorizationStatus`, `GrantAccessKind`, `GrantAuthorityRef`, `GrantAuthorization`, `isGrantWithinValidityWindow`, `grantAllowsMerchantScope` |
| `offline.ts` | `OFFLINE_INSTRUCTION_VERSION`, `InstructionNonce`, `SignedInstruction`, `OfflineEnvelope`, `RedemptionClaim`, `isEnvelopeWithinValidityWindow`, `isEnvelopeWindowWithinInstruction`, `isNonceUnseen` |
| `events.ts` | `PaymentEventType`, `SanitizedPaymentEvent`, `SanitizedEventPayload`, `isPayloadSanitized` |
| `idempotency.ts` | `IdempotentOwnerScope`, `RequestFingerprint`, `IdempotencyResolution`, `isWellFormedFingerprint` |
| `serialization.ts` | `PAYMENT_ENGINE_CONTRACT_VERSION`, `CanonicalLeaf`, `CanonicalProtocol`, `CanonicalRepresentation`, `canonicalize`, `canonicalJson`, `canonicalUtf8Bytes`, `canonicalUtf8ByteLength` |
| `ports.ts` | `ClockPort`, `PaymentsProviderPort`, `QuoteRequest`, `ProviderStatusRequest`, `ProviderConfirmedStatus`, `ProviderStatusReconciliation`, `GrantLifecyclePort`, `GrantLookup`, `GrantRotationOutcome`, `PaymentRepositoryPort`, `IdempotencyResolutionView`, `IdempotentLookup`, `IdempotentCreate`, `AttemptLookup`, `AttemptCreate`, `ResultPersist`, `AtomicClaimPort`, `ClaimRequest`, `ClaimResult`, `ReleaseRequest`, `RecordClaimRequest`, `DeviceVerificationPort`, `DeviceVerificationRequest`, `DeviceVerificationOutcome`, `PaymentEventsPort`, `PaymentEligibilityPort`, `PaymentEngine`, `PaymentStatusLookup`, `DenialCode` |
| `index.ts` | Barrel re-exporting all of the above |

## 2. Money — exact rules (read this twice)

- Every `Money.value` is a **canonical unsigned-integer minor-units string**: digits only, no sign, no separators, no leading zeros (the literal `"0"` is allowed). It is **never a JS number and never a float**.
- `assetCode` is a non-empty, non-whitespace exact string. The domain deliberately does not constrain which asset codes are valid beyond that — provider/adapter policy owns the allowed list.
- `assetScale` is an integer `0..255`.
- **Payer debit and merchant receive are DIFFERENT concepts.** They live in the same fields' shapes (`PaymentQuote.payerDebit` vs `PaymentQuote.merchantReceive`) but may be different assets/scales and must **never be compared, summed, or converted** across by domain logic. There is **no currency conversion implementation anywhere in the domain**.
- **Ceilings apply to the PAYER DEBIT**, taken **from the provider quote** (`PaymentQuote.payerDebit`), never to merchant-receive units. `GrantAuthorization.perPaymentMaxDebit` and `maxDebitMinor` on offline instructions are all payer-debit quantities.

## 3. Errors

`PaymentEngineError` has a **closed, UPPER_SNAKE code union** with constant, **data-free messages** (see `PAYMENT_ENGINE_ERROR_MESSAGES`). Adapters must never embed provider error text, tokens, secrets, or free-form PII into errors. Key codes:

- `GRANT_REAUTHORIZATION_REQUIRED`, `GRANT_INVALID`, `GRANT_NOT_FOUND`
- `OFFLINE_CREDENTIAL_EXPIRED`, `OFFLINE_CREDENTIAL_ALREADY_CLAIMED`
- `OVER_TRANSACTION_CEILING`, `CUMULATIVE_BUDGET_EXCEEDED`
- `PAYMENT_OUTCOME_UNKNOWN`
- `MERCHANT_NOT_VERIFIED`, `DEVICE_NOT_VERIFIED`
- `IDEMPOTENCY_CONFLICT`
- `CLAIM_CONFLICT`, `CLAIM_INSUFFICIENT_BUDGET`, `CLAIM_INVALID`
- `INVALID_MONEY`, `INVALID_PAYMENT_REQUEST`
- `PAYMENT_NOT_FOUND`, `PAYMENT_NOT_ACCESSIBLE`

## 4. Ownership and idempotency semantics

- **Ownership:** every read/write is scoped to a `userId` that must be a **positive safe integer** (`isValidUserId`). Foreign-owner lookups behave as *not found* (`PAYMENT_NOT_FOUND`); a mismatch must never reveal another user's payment identifiers or amount values. `PaymentEngine.statusOf` therefore throws `PaymentEngineError(PAYMENT_NOT_FOUND)` for unknown or foreign payments rather than returning undefined. `PAYMENT_NOT_ACCESSIBLE` exists if an adapter ever needs to acknowledge existence without disclosure — this should be avoided in favor of uniform not-found responses (open owner decision, §11).
- **Idempotency key scope:** `(userId, idempotencyKey)` is globally unique in the persistence layer. Two different users may independently use the same key string.
- **Same key + same canonical request fingerprint** → return the previous attempt/result (`IdempotencyResolution.kind = "PREVIOUS"`). Adapters must not create a second attempt.
- **Same key + different fingerprint** → hard conflict, `IDEMPOTENCY_CONFLICT` (`IdempotencyResolution.kind = "CONFLICT"`). `PaymentRepositoryPort` returns this same union, including `CONFLICT`; adapters must not hide it as a new row.
- The fingerprint is computed over the **canonical UTF-8 bytes** of the command (§9) and is a **lowercase 64-character SHA-256 hex string** (`isWellFormedFingerprint`). Provider-supplied refs (quote ids, attempt ids from the provider) are NOT part of the fingerprint.
- **No retries from the domain:** a resubmission with the same key/fingerprint never re-submits; it only reads back.

## 5. Payment status and events

- App-visible statuses are exactly: `"AWAITING_AUTHORIZATION" | "SUBMITTING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "REJECTED"`.
- Status partition: in-progress `AWAITING_AUTHORIZATION, SUBMITTING, PROCESSING`; unresolved `UNKNOWN`; terminal `SUCCEEDED, FAILED, REJECTED`. `isTerminalStatus(UNKNOWN)` is **false**.
- **`UNKNOWN` means "not determinable"**, distinct from `FAILED`. Engine code must never auto-retry past `UNKNOWN`; any claim/budget reservation stays held until explicit reconciliation. Explicit owner resolution is required (open owner decision on the UX, §11). Only a **confirmed** failure releases a reservation; a confirmed success converts it into a claim.
- Internal proof/polling/claim-reservation states **must not leak** into `PaymentStatus`; they belong to adapters or the internal state machine.
- **Events:** `eventId` is the caller-generated, globally unique once-only identity of one state transition (deterministic for that transition so retries reuse it). The adapter enforces at most one persisted event per `(userId, eventId)`. Payloads are sanitized: **no access tokens, no private keys, no raw provider error text, no unnecessary PII**. `isPayloadSanitized` rejects unknown extra keys and wrong field shapes; untyped free text is dropped, not smuggled in.
- The event `GRANT_REAUTHORIZATION_REQUIRED` is emitted (with kind `"failure"` payload) when the grant lifecycle requires owner action. `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, and `PAYMENT_REJECTED` accompany terminal statuses; `PAYMENT_OUTCOME_UNKNOWN` accompanies the unresolved `UNKNOWN` status.
- For **Josue**: persist events *alongside* payment state in the same transaction, and persist exactly once per event identity. The transactional outbox is adapter-owned; the domain never inspects or drains it.

## 6. Grants (GrantAuthorization)

- `GrantAuthorization` contains **no raw access tokens, no token continuations, no wallet secrets** — only opaque authority references (`authorityRef`). Where actual secret material lives at rest is adapter-owned storage.
- Statuses: `ACTIVE | ROTATING | BLOCKED | REAUTHORIZATION_REQUIRED | REVOKED | EXPIRED`. None of these alone means "may spend"; eligibility re-checks scope, budget, device, envelope, and clock per payment.
- Budgets: `perPaymentMaxDebit` (payer debit ceiling, from provider quote units), `cumulativeCap` and `cumulativeSpent` (same asset as payer debit).
- Validity window `[validFromEpochMs, validUntilEpochMs]` checked with injected time, never `Date.now`.
- Revocation is monotone via `revocationVersion`; adapters must reject instructions issued against a grant whose `revocationVersion` has since increased.
- `merchantScopeId` is **absent for an unbound grant** (any verified merchant) and exact-match when present. Do not use a sentinel string such as `"ANY"`; `grantAllowsMerchantScope` implements the rule.
- `GrantLifecyclePort.rotateAuthority` may return `UNRESOLVED` on ambiguous outcome. **An unknown rotation outcome must stay unknown**: adapters must not trigger fresh interactive consent, must not double-spend, and must not clear the pre-rotation authority without explicit resolution.

## 7. Offline redemption

- `SignedInstruction`/`OfflineEnvelope`/`RedemptionClaim` all carry explicit `version: "1"`.
- The instruction **nonce is single-use** across the whole system.
- The envelope binds: envelope id, device enrollment id (`deviceEnrollmentId`), authorization id (`authorizationId`), and the grant's `revocationVersion` at issuance. Claims after revocation must fail.
- Validity window `issuedAtEpochMs .. expiresAtEpochMs` is enforced with injected time; expired envelopes deny with `OFFLINE_CREDENTIAL_EXPIRED`; a replayed instruction denies with `OFFLINE_CREDENTIAL_ALREADY_CLAIMED`.
- The **envelope window is authoritative** for redemption and must be a subset of the signed instruction's window (`isEnvelopeWindowWithinInstruction`); adapters and eligibility must reject a malformed envelope whose windows disagree.
- `maxDebitMinor` on the instruction is the **potential debit ceiling** the claim reserves.
- Optional `merchantScopeId` on the envelope restricts redemptions to that merchant.
- **No signature verification implementation exists in L3.** `DeviceVerificationPort` is the only verification boundary; its adapter decides enrollment/revocation/signature validity and returns `VERIFIED` only when all three pass **before** any claim.

## 8. Ports (summary)

| Port | Core responsibilities |
| --- | --- |
| `PaymentsProviderPort` | `QuoteRequest` carries the full `PayeeIdentity`, payer-debit cap, and merchant receive; `createQuote` returns provider refs + payerDebit + merchantReceive; `submitPayment` is **single-shot, never re-issued after UNKNOWN** (ambiguity ⇒ `UNKNOWN`); `readProviderStatus` uses the optional captured `providerAttemptRef` (absent ⇒ `UNRESOLVED`), and a confirmed status may only be `PROCESSING` or terminal |
| `GrantLifecyclePort` | load/validate authority, rotate (never triggers fresh consent), cancel |
| `PaymentRepositoryPort` | idempotency lookup/insert returning `PREVIOUS/NEW/CONFLICT`, attempt/result load/save, grant lookup; adapter owns transactions/outbox; no SQL here |
| `AtomicClaimPort` | `claimInstructionAndReserveBudget` keys global single-use on the **instruction nonce** (and carries envelope/authorization ids), returns `CLAIMED/ALREADY_CLAIMED/INSUFFICIENT_BUDGET/CONFLICT/INVALID`; reservation held on UNKNOWN, released only on confirmed failure, never over-ceiling; `recordClaim` carries the reserved amount and device binding needed to build `RedemptionClaim` |
| `ClockPort` | injected `nowEpochMs()`; no ambient time in domain |
| `PaymentEventsPort` | `record(sanitizedEvent)` with exactly-once `(userId, eventId)` identity (adapter responsibility alongside the payment state transaction) |
| `DeviceVerificationPort` | verify enrollment/revocation/signature **before** claim; no crypto implementation |
| `PaymentEligibilityPort` | pure policy: grant/envelope/amount/merchant/device/clock → allow/deny with a closed-union error code; input carries the already-computed `merchantVerified` result |
| `PaymentEngine` | `online`, `redeemOffline`, `statusOf` — orchestration contract, no implementation in L3 |

For reservation release, the adapter retains the `(userId, instructionId, authorizationId)` association with the nonce-keyed reservation created by the atomic claim. Release is allowed only after confirmed failure, and it must preserve the nonce's replay record. `recordClaim` must verify that the supplied amount and identity fields match that stored reservation. `saveResult` may reconcile `UNKNOWN` to a confirmed outcome; confirmed terminal outcomes remain final.

## 9. Canonical serialization and versioning

- `canonicalize({ version, body })` → canonical JSON with the **version bound into the bytes** as a top-level `version` property: **UTF-8 bytes, keys sorted recursively in ascending UTF-8 byte order, no insignificant whitespace, money as strings**. Different protocol versions produce different canonical bytes for the same body.
- Only plain objects, arrays, strings, booleans, null, and safe-integer numbers are accepted. `undefined` optional properties must be omitted before canonicalization; `undefined`, class instances, floats, `NaN`, and infinities are rejected rather than silently rewritten.
- Unsupported `version` values **throw**; nothing is auto-migrated or silently coerced.
- `canonicalUtf8Bytes` returns the exact bytes to hash/sign; `canonicalUtf8ByteLength` exposes the byte length. Device and backend must produce byte-identical output for the same command (Massi's Flutter implementation included).
- Actual signing/verification of these bytes is **L5 scope**, not this contract.

## 10. Deliberately out of scope

- DB adapters, migrations, SQL, transactional outbox wiring (Josue).
- Express routes, controllers, middleware (Josue).
- Open Payments SDK wiring, live provider operations (future adapters).
- FCM / notification workers; Flutter client (Massi).
- Real cryptographic signing (L5).
- Deployment/ops concerns.

## 11. Open owner decisions

1. Whether foreign-owner reads return `PAYMENT_NOT_FOUND` uniformly or false-positive `PAYMENT_NOT_ACCESSIBLE` for a subset — current contract prefers uniform not-found for non-disclosure.
2. What the human UX for "resolve UNKNOWN" looks like (explicit owner resolution flow is not modeled yet).
3. `PayeeIdentity.merchantScopeId` vs `GrantAuthorization.merchantScopeId` match rules — absent grant scope means unbound; a present scope is exact equality. If prefix/pattern matching is wanted, add a dedicated policy decision.
4. Concrete SHA-256 hashing over canonical UTF-8 bytes is adapter-provided (crypto stays behind the boundary); the lowercase-hex format is fixed by this contract.
5. `revocationVersion` range/rollover convention.
6. Whether `MerchantIdentity` should eventually grow verified presentment data (currently capped at opaque ids).
