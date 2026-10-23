# Backend payments: architecture and API boundary

**Scope:** the project owner is responsible for the backend. Flutter/UI implementation belongs to the client team. These documents describe the backend services and the contract that clients will consume.

## Reading map

| Document | Purpose |
| --- | --- |
| This document | Architecture, responsibilities and current versus proposed API exposure |
| [Standalone architecture Mermaid](backend-payments.mmd) | The component flowchart as a native `.mmd` file |
| [Proofs and theory](payment-proofs.md) | Why A/B exist, exact observations and implications for the vision |
| Local agent handoff: `backend-agent-handoff.md` | Source-level notes and API drafts, kept locally rather than versioned |
| [Reproduction guide](payment-reproduction.md) | Backend-only setup, keys/tokens, consent, commands and recovery |
| [Product flowcharts](payment-flows.md) | Customer/merchant journey as a design reference |
| [Detailed sequence](payment-flows.mmd) | Intended end-to-end interactions and current development notes |

## 1. Do we expose an API?

**Yes. Atomic Commits is a backend API consumed by client applications.** There are two distinct API boundaries:

```mermaid
flowchart LR
    Client["Client application<br/>Flutter owned by another team"] -->|"App-authenticated HTTP requests"| API["Atomic Commits API<br/>Backend owner delivers this contract"]
    API -->|"Internal service calls"| SDK["Open Payments SDK client"]
    SDK -->|"Provider HTTP signatures and scoped GNAP tokens"| Provider["Provider APIs"]
    Provider -->|"Authoritative payment outcome"| API
    API -->|"App DTOs and status"| Client
```

The SDK is an internal provider connector. Client applications should call our authenticated endpoints, not receive our developer private key or provider grant tokens.

### Current HTTP API: implemented

These routes are mounted by `backend/src/app.ts` and `src/routes/auth.ts`:

| Method | Route | Current behavior |
| --- | --- | --- |
| GET | `/health` | Health response, including when auth configuration is absent |
| POST | `/api/auth/register` | Validate name/email/password, BCrypt hash, create app user and cookie session |
| POST | `/api/auth/login` | Verify credentials and regenerate a PostgreSQL-backed cookie session |
| GET | `/api/auth/me` | Current app user, protected by the session middleware |
| POST | `/api/auth/logout` | Destroy the app session and clear its cookie |

Auth uses the `atomic.sid` cookie today. JWT is planned in [issue #4](https://github.com/MasieJr/Atomic-Commits/issues/4). Missing DB/session configuration produces auth HTTP 503; supplying a Bearer token does not currently turn these routes into JWT routes.

### Current payment integration: local commands

`wallet:lookup`, `payment:proof-a`, `payment:proof-b` and `payment:proofs` are CLI entry points. They do not create app-facing payment routes.

The proof's `http://localhost:3999/callback/<random-value>` listener exists only while a proof is awaiting consent. It is not part of the main API on port 3000 and is not a production callback endpoint.

**Wallet-link, payment-grant, payment-status, device-enrollment and redemption endpoints remain proposed.** The current route inventory is above; detailed endpoint/DTO drafts are kept in the local agent handoff.

## 2. Backend architecture target

Green components identify existing foundations. Blue components contain proposed application integration; the Supabase node includes existing auth tables but its payment-related records are still planned.

```mermaid
flowchart LR
    subgraph Consumers["API consumers - client team ownership"]
        Customer["Customer client"]
        Merchant["Merchant client"]
        Browser["Provider consent browser"]
    end
    subgraph Backend["Atomic Commits backend - backend owner scope"]
        Auth["App authentication<br/>Cookie API exists, JWT planned"]
        WalletAPI["PROPOSED wallet-link API<br/>Resolve ownership and verified links"]
        GrantAPI["PROPOSED grant API<br/>Budget, consent and token lifecycle"]
        PaymentAPI["PROPOSED payment API<br/>Idempotent intents and status"]
        Callback["PROPOSED HTTPS callback handler<br/>Stored state and GNAP hash validation"]
        Workflow["PROPOSED persistent workflow/reconciler<br/>No human-consent wait inside a request"]
        SDK["Provider SDK library exists<br/>Server identity plus per-operation grant tokens"]
        DB["Supabase<br/>Users/sessions exist<br/>Wallet/grant/payment records planned"]
        Secrets["Backend secret storage<br/>Developer key and token-encryption key"]
    end
    subgraph ProviderSide["Open Payments provider - Test Wallet in development"]
        Metadata["Public wallet metadata and JWKS"]
        Authorization["Authorization server<br/>Owner verification and spending consent"]
        Resources["Incoming payments, quotes<br/>and outgoing payments"]
        Funds["Provider accounts and balances<br/>Provider holds and moves funds"]
    end

    Customer -->|"Sign up / log in"| Auth
    Customer -->|"Authenticated link request"| WalletAPI
    Customer -->|"Request bounded permission"| GrantAPI
    Customer -->|"Request payment / read status"| PaymentAPI
    Merchant -->|"Authorized receive/redeem request"| PaymentAPI
    WalletAPI -->|"Resolve app user"| Auth
    GrantAPI -->|"Resolve app user"| Auth
    PaymentAPI -->|"Resolve actor and wallet ownership"| Auth
    WalletAPI --> Workflow
    GrantAPI --> Workflow
    PaymentAPI --> Workflow
    Workflow <-->|"Attempts, links, encrypted tokens and payment states"| DB
    Secrets -->|"Developer signing key"| SDK
    Secrets -->|"Protect persisted provider credentials"| Workflow
    Workflow -->|"Selected wallet, scope and token per operation"| SDK
    SDK <-->|"Discovery"| Metadata
    SDK <-->|"Signed grant / continuation / management requests"| Authorization
    SDK <-->|"Signed requests with provider GNAP tokens"| Resources
    Authorization -->|"Provider-hosted interaction"| Browser
    Browser -->|"Correlated redirect callback"| Callback
    Callback -->|"Resume the stored owner-bound attempt"| Workflow
    Workflow -->|"Sanitized status and authorization URL"| Customer
    Workflow -->|"Provider-confirmed status"| Merchant
    Resources --> Funds

    classDef foundation fill:#e8f5e9,stroke:#2e7d32,color:#17221a;
    classDef proposed fill:#e8efff,stroke:#315896,color:#17213a;
    class Auth,SDK foundation;
    class WalletAPI,GrantAPI,PaymentAPI,Callback,Workflow,DB,Secrets proposed;
```

The provider holds funds. The backend authorizes operations, obtains provider permission, initiates instructions and records/reconciles outcomes. Supabase is the app's record store, not an invented customer funds ledger.

Public wallet metadata does not establish an account balance. Remaining grant allowance is spending permission, not available funds. A live-balance endpoint would need a separately supported and authorized provider capability.

## 3. Ownership of the work

| Backend owner | Client team | Provider |
| --- | --- | --- |
| Authenticated API and authorization | Screens, forms and navigation | Provider account opening and funding |
| Verified wallet links and callback state | Enter/select wallet addresses and open consent URLs | Wallet metadata and ownership/spending consent |
| Protected grant tokens and lifecycle handling | Store the app login credential appropriately | Issue scoped access tokens and enforce grant limits |
| Amount/asset checks, idempotency and reconciliation | Submit requests and display returned states | Execute payment instructions and expose outcomes |
| Later: enroll public device keys and verify signed instructions | Later: generate/retain the phone's offline private key and sign QR payloads | Remain authoritative for permission and available funds |

The backend owner defines the client contract and the public-key/payload formats. Implementing Flutter secure storage or UI is not part of that backend scope.

## 4. Four different identities/credentials

```mermaid
flowchart TD
    AppUser["App user"] --> AppCredential["Current cookie / planned app JWT"]
    AppCredential --> AppAuth["Authenticate to Atomic Commits"]
    DeveloperKey["Backend developer private key"] --> SignedRequest["Identify/sign our client to the provider"]
    ProviderGrant["Payer-approved provider grant token"] --> Spend["Authorize the selected wallet, actions and debit budget"]
    DeviceKey["Future phone-generated private key"] --> QR["Authenticate a bounded offline payment instruction"]
    AppAuth --> Backend["Backend combines the required evidence"]
    SignedRequest --> Backend
    Spend --> Backend
    QR --> Backend
    Backend --> Outcome["Provider permission and confirmed outcome still control payment"]
```

The backend SDK client can be reused across users, with wallet IDs and grant tokens supplied per operation. `createOpenPaymentsClient()` currently returns a new instance per call; it does not automatically cache one or create app users.

In development, the configured client identity/key is borrowed from the demo payer's Test Wallet. A dedicated backend integration identity acting for unrelated users remains a separate validation question.

## 5. Moving from CLI to API

```mermaid
flowchart TD
    Proofs["Local A/B capability verified"] --> Links["Persist verified user wallet links"]
    Links --> Grants["Persist owner-bound grant workflows<br/>Encrypt the secrets needed after restart"]
    Grants --> Payments["Expose payment intents and status<br/>DB uniqueness, authorization and short transactions"]
    Payments --> Recovery["Resume callbacks and reconcile ambiguous provider outcomes"]
    Recovery --> Contract["Client team integrates the documented HTTP contract"]
    Contract --> Offline["Later offline milestone<br/>Public-key enrollment, signed instructions and atomic redemption"]
    Grants --> Lifecycle["Verify renewal/expiry behavior<br/>before promising the 25-minute Errand journey"]
    Lifecycle --> Offline
```

Reuse the provider operations and confirmed observations. Replace the CLI's global wallet env inputs, file lock, process-local callback and JSON receipts with user-scoped persisted workflows. A small DB-backed worker can be sufficient for the demo; a large distributed queue stack is not a prerequisite.

The local agent handoff specifies the proposed resources, states and decisions. Those drafts still need to be agreed before they become an implemented API contract.
