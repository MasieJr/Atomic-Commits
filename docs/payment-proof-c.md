# Proof C: long-lived consent across provider token rotations

This document records what Proof C is designed to demonstrate, how it is run safely, and what it does not claim. A **proof** here means an empirical integration experiment against Interledger Test Wallet with simulated funds. It is not a production-readiness claim.

Companion reading: the theory and the historical evidence for Proofs A/B live in
[payment-proofs.md](payment-proofs.md). The dry command reports `NOT_RUN`; live results are reported separately and do not imply a passing result unless the full proof succeeds.

## 1. Hypothesis

One explicit, interactive, bounded outgoing-payment approval can stay usable for at least 25 minutes after the payer approved it — across at least two provider token rotations performed proactively before each advertised token deadline — while the provider's spent counter stays consistent with the payments actually made.

This targets the gap Proof B left open (its own `limitations` field): provider token expiry/refresh behavior.

## 2. Status: NOT_RUN by default

`npm run payment:proof-c` (no arguments) is a **dry** run. It performs zero provider, consent, payment, or rotation calls and never uses a credential. Note that loading the module imports `dotenv/config`, so local settings (including `backend/.env`) are read from disk — that file read is not a credential use: no credential is consumed, transmitted or exercised, and no network connection of any kind is made. The dry output is a redacted status summary like:

```json
{ "event": "payment-proof-c", "status": "NOT_RUN", "mode": "dry", "intendedTransfers": 3, "live": false }
```

It reads only local settings. If the required money settings are missing, the dry output names them (`configError`) and still exits 0: a dry run is a check, not an execution.

The real experiment requires an explicit `--live` flag:

```
npm run payment:proof-c -- --live
```

`--live` performs network/credential/consent activity and **must only be run with explicit owner approval for that run**: the owner or an agent/operator the owner has approved may execute it. Approval of one run does not authorize a retry. The consent click at the wallet UI is always the owner's own decision (or their approved operator acting per instruction), and the wallet must belong to whoever authorizes the run. Proof runs must also stay in development mode: the command refuses to start when `NODE_ENV=production`.

### Observed live run — 2026-10-28 UTC

One owner-approved Test Wallet run completed as **INCONCLUSIVE**. It recorded one payer interaction, but the initial provider spent counter could not be verified (`UNVERIFIABLE_COUNTER`), so it stopped before any debit: **zero transfers and zero rotations**. Cleanup reported no warnings and no authorities retained for unresolved payments. The outer run report is `FAILED` because the proof did not pass; this is not evidence of a failed payment. The report did not capture whether the counter was missing or its read failed, so that underlying cause remains unknown. Neither the 25-minute capability nor counter continuity has been demonstrated by this run.

## 3. Configuration (explicit; no defaults apply to Proof C)

Set all of these in `backend/.env` before a live run. Credential names are exactly those already documented in [payment-reproduction.md](payment-reproduction.md) (`SENDING_WALLET_ADDRESS_URL`, `RECEIVING_WALLET_ADDRESS_URL`, developer key material); no new values are introduced here.

| Setting | Meaning |
| --- | --- |
| `PAYMENT_PROOF_BUDGET_MINOR` | Aggregate grant cap in payer minor units (the whole consent budget) |
| `PAYMENT_PROOF_C_MAX_DEBIT_MINOR` | Explicit per-payment payer-debit ceiling, ≤ aggregate budget |
| `PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR` | Fixed receive amount in recipient minor units (per transfer) |
| `PAYMENT_PROOF_C_PAYER_ASSET_CODE` / `PAYMENT_PROOF_C_PAYER_ASSET_SCALE` | Expected payer asset; compared with wallet metadata before any consent |
| `PAYMENT_PROOF_C_RECIPIENT_ASSET_CODE` / `PAYMENT_PROOF_C_RECIPIENT_ASSET_SCALE` | Expected recipient asset; compared the same way |

Consent/callback knobs reuse the existing names `PAYMENT_PROOF_CALLBACK_PORT`, `PAYMENT_PROOF_CONSENT_TIMEOUT_SECONDS`, and `PAYMENT_PROOF_SETTLEMENT_TIMEOUT_SECONDS`.

Example for an operator **approval request** (test values only, not a product policy): `PAYMENT_PROOF_BUDGET_MINOR=600` + payer asset `ZAR` scale `2` (6.00 ZAR total, 2.00 ZAR maximum per transfer), `PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR=10` + `EUR` scale `2` (0.10 EUR received per transfer). Quote/FX decides each transfer's payer debit; if a quote exceeds the ceiling, the run stops — it never spends over the ceiling, and the operator may treat that stop as part of the answer.

## 4. What the live run does

Exactly one interactive outgoing-consent approval (receiver-unbound, like Proof B), then a schedule driven by the provider's own conservative, request-anchored token expiry:

1. Immediately after consent: transfer 1 (fresh incoming payment + provider quote per transfer; conversion comes from the quote).
2. The scheduler rotates the access token proactively — 60 s before each advertised deadline (`rotationEarlyMarginMs`, development operational slack, not policy) — so a live token exists when needed.
3. Strictly after the originally advertised access deadline passes: transfer 2.
4. Strictly after 25 minutes since the approval (and after transfer 2): transfer 3.
5. Before every transfer: fresh non-interactive incoming/quote resource grants; if the provider demanded an interaction for them, the run stops.

At most three transfers happen. A successful rotation alone never shortens or reinterprets the 25-minute gate.

## 5. Rules that protect the payer

- Every token/management URI is registered for redaction *before* any validation. Rotation re-validates against the currently accepted authority (never the original, wider request), requires an unchanged total cap, and uses the rotation's own request-anchored expiry — never a re-derived `expires_in`.
- After every confirmed rotation the spending holder is replaced atomically inside `createProofCPorts` (the exported, side-effect-free port-composition factory the CLI uses and tests can exercise): later `pay()` and spent-counter reads only ever see the rotated token and its conservative deadline, while the original grant continuation is kept unchanged for cleanup.
- A fresh, explicit spent-counter reading must say exactly zero before any transfer; an absent counter is never assumed to be zero (that outcome is `INCONCLUSIVE` with zero submissions).
- Both the aggregate remaining allowance (from the authoritative counter) and the per-payment ceiling are enforced per submission, including on a refreshed quote; no transfer is ever re-tried.
- After each confirmed transfer, bounded read-only polling waits until the counter equals the cumulative quoted debits; a counter reset or overshoot is never tolerated.
- Any unknown debit (`UNKNOWN` state) stops everything, preserves the recorded provider IDs, and cleanup retains the outgoing and incoming read authorities for reconciliation; cleanup failures downgrade the run to `INCONCLUSIVE`.
- No new consent and no new outgoing grant is ever requested after a failure. The run is in-memory evidence only: after the process exits there is **no durable recovery** — reconcile provider history manually and never submit a second debit for an unknown payment.

## 6. Classification

`PASSED` requires: exactly one interactive approval; three transfers executed and confirmed; at least two rotations confirmed before their respective deadlines with an unbroken counter; explicit initial zero reading; the counter matching cumulative quoted debits after every confirmed transfer; clean cleanup (nothing retained, no warnings).

`FAILED` means a definitive contradiction was observed: the provider refused a required rotation, marked/rejected a transfer, the counter drifted from confirmed payments, or a quote exceeded the configured ceiling.

`INCONCLUSIVE` means the outcome stayed unknown: unknown transfer states, an ambiguous rotation, lifecycle verification failures (authority/scope/counter), a missing or unconfirmed counter, schedule-margin failures, or cleanup problems. Evidence stays as observed; nothing is claimed.

`FAILED` vs `INCONCLUSIVE` is visible in the redacted evidence itself, via these observational fields — each turns true only after an actual observation: `originalAccessTokenLifetimeSeconds` and `originalDeadlineAt` (from the approved token's conservative deadline), `paymentAfterOriginalExpiryConfirmed`, `paymentAfterMinute25Confirmed`, `providerSpentCounterConsistent`, `grantRestrictionsPreserved`, `payerInteractions` (a documented alias of `interactiveApprovals`), plus `lifecycleFailures` entries carrying only the safe lifecycle category, its classification and the SDK's whitelisted status/code fields — never a raw provider description. Any counter reading below an earlier reading counts as a reset and fails the run, even if a later reading would recover to the expected total.

For future runs, `rotationCounterObservations` retains each actual validated before/after rotation reading with its attempt number, timestamp and sanitized amount; an unobserved reading is omitted rather than inferred. `lifecycleFailures.counterReason` distinguishes a missing, malformed, mismatched or excessive counter, a failed read, and a changed rotation counter without retaining raw provider text. These fields do not retroactively reveal the cause of the 2026-10-28 run. Report-finalization and lock-release failures are printed as separate constant, sanitized errors.

The bounded counter polling handles valid delayed counters: it reads repeatedly within `counterSettleMs` and stops as soon as the counter equals the confirmed cumulative debit. A counter read that errors or is aborted (operators pressing Ctrl+C included) intentionally stops the run as `INCONCLUSIVE` — a deliberately conservative fail-closed behavior: no read is retried and no debit is re-attempted, and an `INCONCLUSIVE` result explicitly does not disprove the provider capability; it says the evidence cannot be completed. Nothing in this path triggers a new consent, a re-authorization request, or a submission retry.

## 7. SDK references

The runner only orchestrates existing calls: `grant.request`/interactive continuation, `token.rotate` and `outgoingPayment.getGrantSpentAmounts` (via the injected lifecycle ports), `incomingPayment.create/get/complete`, `quote.create`, `outgoingPayment.create/get`, and `grant.cancel` during cleanup. Token and URI values are redacted from all reports. The official SDK is the Interledger Open Payments JavaScript client, `@interledger/open-payments`: https://github.com/interledger/open-payments (the `@interledger/open-payments` npm package, version 7.4.x in this backend).

## 8. Scope exclusions

Not demonstrated: multi-merchant wallets, offline redemption, any durable service behavior, production key/identity handling, or any result on real funds. The runner is a side-effect-free experiment core with injectable clock/sleep/provider seams; instant fake-clock variations belong to tests, never to additional real-money schedules.
