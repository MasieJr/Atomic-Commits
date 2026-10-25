# Atomic Commits payment flows

These box-and-arrow flowcharts describe the intended customer/merchant journey. Client screens are external API consumers; the project owner's implementation scope is the backend. The detailed [sequence diagram](payment-flows.mmd) is retained alongside this document.

**Status:** the production flows below are design targets. Local Test Wallet commands demonstrated a confirmed transfer and bounded grant reuse. App-facing payment endpoints and client onboarding remain pending.

Start with [backend architecture/API exposure](backend-payments.md) for backend scope; that document also holds the proposed API/data/token contracts and open product decisions. The [proofs/theory](payment-proofs.md) covers the experimental evidence and the [reproduction guide](payment-reproduction.md) shows how to run it.

## 1. Production target: signup and wallet setup

```mermaid
flowchart TD
    Signup["Create an Atomic Commits account or log in"] --> Setup["Wallet setup"]
    Setup --> Choice{"Already have a provider wallet?"}
    Choice -->|"Yes"| Address["Enter a wallet address or payment pointer"]
    Choice -->|"No"| Provider["Open provider-hosted account and wallet setup"]
    Provider --> Address
    Setup -->|"Set up later"| Home["Home with payment setup still pending"]
    Address --> Discover["Backend validates the URL, blocks internal-network fetches<br/>and retrieves public wallet metadata"]
    Discover --> Verify["Provider-hosted ownership verification<br/>User authenticates and approves"]
    Verify --> Callback["Backend validates callback state and interaction hash<br/>Continues the grant and checks the verified subject"]
    Callback --> Save["Store a VERIFIED wallet link under the app user"]
    Save --> Connected["Show the connected wallet and currency<br/>Choose sending and receiving defaults"]
    Connected --> Home
```

- Atomic Commits signup creates an **app identity**. Provider account creation uses the provider's own onboarding flow. We have not established a public API to automatically create Test Wallet consumer accounts.
- Repeat linking for additional wallets. The production app will obtain wallet addresses from verified per-user records in Supabase.
- Public metadata lookup establishes that an address resolves. Provider ownership verification establishes the user-to-wallet link.
- A verified wallet link and permission to spend are separate. App authentication is also separate from Open Payments authorization.
- The JWT migration is tracked in [issue #4](https://github.com/MasieJr/Atomic-Commits/issues/4). Native app login credentials will use platform-protected storage.

## 2. Production target: online payment

```mermaid
flowchart TD
    Request["Flutter requests a payment<br/>Amount, merchant identity and idempotency key"] --> Authorize["Authenticate the app user<br/>Resolve verified payer and recipient wallets"]
    Authorize --> Claim["Validate amount and asset rules<br/>Atomically reserve the payment attempt and commit"]
    Claim --> Incoming["Backend SDK obtains the required grant<br/>and creates the recipient incoming payment"]
    Incoming --> Quote["Obtain the quote grant and create a fresh quote<br/>Read debit and receive amounts, fees and currencies"]
    Quote --> Grant{"Suitable payer-approved outgoing grant<br/>valid and within budget?"}
    Grant -->|"Yes"| Check["Load the protected payer-bound token<br/>Check quoted debit against the grant limits"]
    Grant -->|"No"| Consent["Provider displays bounded spending permission<br/>Payer authenticates and approves"]
    Consent --> Continue["Backend validates the callback and continues the grant<br/>Encrypt any persisted token and save its scope and limits"]
    Continue --> Check
    Check --> Execute["SDK creates the outgoing payment<br/>Correct payer wallet, fresh quote and approved grant token"]
    Execute --> Record["Save provider resource IDs and PROCESSING state"]
    Record --> Reconcile["Read and reconcile the authoritative provider outcome"]
    Reconcile --> Outcome{"Provider result"}
    Outcome -->|"Confirmed complete"| Paid["Persist SUCCEEDED and actual amounts<br/>Show paid to customer and merchant"]
    Outcome -->|"Confirmed failure"| Failed["Persist FAILED<br/>Show payment failure"]
    Outcome -->|"Pending, timeout or unknown"| Pending["Preserve the attempt claim<br/>Store PROCESSING or UNKNOWN and show pending"]
    Pending -->|"Reconcile the existing resource IDs"| Reconcile
```

### Who owns the client and permission?

The backend can reuse a configured SDK client across app users. Its **developer signing key identifies Atomic Commits** to the provider. Each outgoing payment supplies the intended payer wallet and that payer's approved provider grant token.

```text
Shared backend client + payer A's wallet and grant -> payer A's payment
Shared backend client + payer B's wallet and grant -> payer B's payment
```

The provider holds and moves funds. Supabase stores app records and provider references.

### Amounts and outcomes

- Amounts use integer minor-unit strings with an explicit asset and scale.
- Compare debit limits with the provider's **quoted debit amount**, including applicable fees and currency conversion. Do not compare amounts in different currencies or scales directly.
- Commit the database reservation before making external provider calls. Keep database transactions short.
- API acceptance and a local database record are intermediate states. A paid state requires provider-confirmed completion.
- For an uncertain result, reconcile the existing attempt before initiating another debit. Provider-side idempotency support still needs to be established independently of app-side duplicate control.

### Merchant receiving journey (design target)

The same online payment is viewed from the merchant side. The backend resolves the recipient from an authorized merchant record; client-supplied IDs never grant authority by themselves.

```mermaid
flowchart LR
    MerchantApp["Merchant app, authenticated"] --> Submit["Submit or read an authorized<br/>payment/redeem request"]
    Submit --> Resolve["Backend resolves the merchant's<br/>verified receiving wallet link"]
    Resolve --> Settlement["Backend quotes and executes the payment<br/>against the payer's approved provider grant"]
    Settlement --> Outcome{"Provider outcome"}
    Outcome -->|"Confirmed"| Receipt["Show provider-confirmed receipt<br/>and actual amounts"]
    Outcome -->|"Failed"| Failure["Show payment failure<br/>with any safe partial information"]
    Outcome -->|"Pending or uncertain"| Hold["Show pending and reconcile the existing attempt<br/>Never re-initiate a debit from the merchant side"]
    Hold -->|"Reconciled"| Outcome
```

Merchant apps receive sanitized status DTOs, never provider grant tokens or developer keys. During offline redemption the merchant app additionally submits a signed payer instruction; the backend performs verification, nonce claiming and settlement (next section).

## 3. Conditional production target: payer offline, merchant online

This flow depends on actual provider support for reusable, budget-limited outgoing-payment grants. The local proof has passed for the configured Test Wallet pair; token renewal, additional merchant wallets and device-signed redemption still require their own implementation and verification.

```mermaid
flowchart TD
    Gate{"Reusable-grant capability proven<br/>with the selected provider?"}
    Gate -->|"No"| Fallback["Use the online provider-approved payment flow"]
    Gate -->|"Yes"| Setup["Complete online setup<br/>Verified wallet, enrolled phone and approved spending grant"]
    Setup --> Create["Payer chooses Quick or Errand<br/>Confirms a spending ceiling and expiry"]
    Create --> Sign["Phone creates a fresh nonce and signs a versioned QR<br/>Payer/device, asset, ceiling, mode, expiry and merchant restriction"]
    Sign --> Present["Payer presents the QR or a printed slip<br/>The payer may now be offline"]
    Present --> Merchant["Online merchant submits the signed instruction<br/>Actual charge and verified recipient identity"]
    Merchant --> Verify["Backend checks the enrolled public key and signature<br/>Revocation, clock/expiry, amount/asset and merchant constraints"]
    Verify --> Claim["Atomically claim the unique device/nonce<br/>Reserve the payment attempt and commit"]
    Claim --> Quote["Create a fresh incoming payment and quote"]
    Quote --> Limits{"Provider grant usable and quoted debit<br/>within the signed ceiling and grant budget?"}
    Limits -->|"No"| Approval["Reject the attempt or require the payer<br/>to reconnect and authorize"]
    Limits -->|"Yes"| Execute["SDK executes using the existing payer-approved grant"]
    Execute --> Outcome["Use the same provider-confirmation<br/>and reconciliation path as the online flow"]
```

- **Quick:** at most 30 seconds. **Errand:** user-selected duration up to 25 minutes.
- The phone generates its own Ed25519 key pair. Its private key stays in secure device storage; the backend stores the public verification key and revocation metadata.
- This phone key is separate from the backend's Open Payments developer key and the provider's spending grant.
- One successful redemption consumes the credential, even when the actual charge is below its ceiling. The unused difference stays in the payer's provider wallet.
- Creating a QR does not reserve funds or guarantee a sufficient provider balance. If both devices are offline, a queued action remains pending.
- The [local provider proofs](payment-proofs.md) passed for the tested wallet pair. App-level wallet ownership, device enrollment, single-use redemption and lifecycle/recovery work still have to be implemented.

### Quick and Errand at a glance

| Mode | Maximum credential duration | Private key holder | Redemption rule | Open constraint |
| --- | --- | --- | --- | --- |
| Quick | 30 seconds | Phone (device secure storage) | Single use; the first confirmed redemption consumes the entire credential | Must fall inside currently usable provider permission |
| Errand | User-selected, up to 25 minutes | Phone (device secure storage) | Single use; same consumption rule | The 25-minute target is not yet guaranteed: the observed provider token lasted 600 seconds and renewal is unverified (see the [proofs](payment-proofs.md) and the [token lifecycle](backend-payments.md#9-token-lifecycle-and-renewal-not-implemented)) |

Both modes depend on the reusable bounded grant proven in Proof B; neither requires the payer's app JWT to reach the backend at redemption.

## 4. Current development implementation

```mermaid
flowchart TD
    subgraph Lookup["IMPLEMENTED - temporary public lookup"]
        Command["npm run wallet:lookup"] --> Inputs["One/two command arguments<br/>or temporary sender/receiver environment values"]
        Inputs --> Normalize["Normalize payment pointers to HTTPS<br/>Validate the address format"]
        Normalize --> PublicClient["Create an unauthenticated SDK client"]
        PublicClient --> Output["Fetch and print validated public wallet metadata"]
    end
    subgraph Signing["IMPLEMENTED - developer-client initialization"]
        Config["Server-only client wallet address,<br/>key ID and private-key file path"] --> Factory["createOpenPaymentsClient factory<br/>A new signing-capable client per call"]
    end
    subgraph Proofs["IMPLEMENTED - local Test Wallet payment proofs"]
        ProofCommand["payment:proof-a, payment:proof-b or payment:proofs"] --> Result["Grant consent, one confirmed transfer (A),<br/>two transfers under one budgeted grant (B)<br/>and the over-budget rejection check"]
    end
```

The public lookup command uses the unauthenticated client. It does not call the signing-client factory or use the private key. Both public wallet metadata lookup and initialization with the matched registered developer key have been verified. The step-by-step A/B grant, payment and budget flows live in the [proofs document](payment-proofs.md); the commands, consent behavior and evidence files are in the [reproduction guide](payment-reproduction.md).

| Area | Production target | What we have in development |
| --- | --- | --- |
| Provider | A participating provider with agreed capabilities and onboarding | Interledger Test Wallet, simulated funds and manual account funding |
| Wallet selection | Verified per-user wallet links selected through the API | Temporary `SENDING_WALLET_ADDRESS_URL` and `RECEIVING_WALLET_ADDRESS_URL` inputs for the manual command |
| SDK identity | Backend-controlled integration credentials, reusable across users | A demo payer Test Wallet supplies the developer identity/key; the factory returns a new client on each call |
| App authentication | Agreed Flutter/API token contract and protected client storage | BCrypt passwords and PostgreSQL cookie sessions; JWT migration is tracked in issue #4 |
| Sensitive storage | Backend secret storage, encrypted persisted provider tokens and protected phone keys | Local `.env` and PEM files are plaintext; proof grant tokens stay in memory, and redacted receipts are Git-ignored. Persistent provider-token storage and phone-key enrollment are pending |
| Database | Runtime/migration configuration suited to the deployment | One verified-TLS Supabase connection; the configuration split is deferred in [issue #3](https://github.com/MasieJr/Atomic-Commits/issues/3) |
| Wallet linking | Provider ownership verification and stored verified links | Public metadata discovery only; the wallet-link API and its URL/SSRF controls are pending |
| Payment execution | Incoming payment, quote, approved outgoing grant, confirmed outcome and reconciliation through the app API | Local Proofs A and B passed against Test Wallet; app API integration and production persistence/reconciliation are pending |
| Flutter onboarding | Signup followed by wallet-link/create/later setup | Existing payer/merchant UI; signup, wallet setup and payment API wiring are pending |
| Offline QR | Enrolled device, signed bounded credential, single-use redemption and provider settlement | Planned; no device enrollment or signed offline redemption is implemented |

### Relevant implementation files

- `backend/src/services/open-payments.ts` - URL normalization, SDK client configuration and public metadata lookup.
- `backend/src/commands/wallet-lookup.ts` - temporary command-line entry point.
- `backend/src/services/grant-interaction.ts` - one-use loopback callback, interaction-hash verification and grant continuation.
- `backend/src/services/payment-proof.ts` - provider grants, fresh payment resources, confirmation and budget enforcement checks.
- `backend/src/services/payment-proof-run.ts` - minor-unit configuration, run lock and redacted local evidence.
- `backend/src/commands/payment-proof.ts` - ordered Proof A/Proof B orchestration.
- `backend/.env.example` - server-only developer settings and explicitly temporary two-wallet inputs.
- `backend/package.json` - the lookup and payment-proof build/run commands.

The temporary sender/receiver settings belong to the manual integration workflow. Flutter users will link their own wallets through the app; they will not manage backend environment files or the backend developer key.

## 5. Backend implementation and proof documents

- [Backend architecture and API boundary](backend-payments.md) - existing routes, provider internals, the proposed API/data-model/token contracts and open decisions.
- [Proofs and theory](payment-proofs.md) - the A/B hypotheses, resource/grant model, measured results, encoding/error adaptations and implications for the vision.
- [Reproduction guide](payment-reproduction.md) - keys/tokens inventory, local `.env` placeholders, funding, exact commands, consent, evidence and interrupted-run recovery.

The proof details and reproduction instructions live in those dedicated documents so this page remains a product-flow overview.
