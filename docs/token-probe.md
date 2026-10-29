# Test Wallet token lifecycle probe

`payment:token-probe` is a development-only live diagnostic for provider token management. It requests temporary grants, rotates and revokes access tokens, then cancels the grants. It does **not** create outgoing payments, but it does change Test Wallet grant/token state and requires an owner's approval before execution. It refuses production mode.

Run from `backend/`:

```text
npm run payment:token-probe -- resource
npm run payment:token-probe -- outgoing
npm run payment:token-probe -- all
```

The default mode is `resource`. Resource mode requests a non-interactive incoming-payment grant. Outgoing mode requests one interactive payer-approved outgoing grant bounded by `PAYMENT_PROOF_BUDGET_MINOR`; `all` runs the resource check first and proceeds to outgoing only if it completed as expected. Outgoing mode requires the payer to approve in the provider UI.

For each token with a management URI the probe rotates once, checks that the prior token is rejected, revokes the replacement, then checks that the revoked token is rejected. An ambiguous or unexpected result stops that lifecycle rather than continuing against uncertain authority. The outgoing grant's returned payer, scope and debit cap are validated before token management calls.

The probe prints observed outcomes and advertised lifetimes, without logging token values, management URIs, continuation URIs or free-form provider descriptions. It attempts to cancel every retained grant and marks cleanup failures as unsuccessful. The approval URL is shown to the operator for the one-time provider interaction and must not be shared. Reports and locks live in the existing local `.env.payment-proofs` directory.

This diagnostic does not establish provider spending-counter continuity or a 25-minute usable permission window. The separate [Proof C](payment-proof-c.md) documents that experiment and its observed result.
