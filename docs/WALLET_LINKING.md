# Wallet links and database records

`app_private.users.id` identifies an Atomic Commit account. Migration `005_verified_wallets.sql` adds one `verified_wallets` row per user and a `wallet_verifications` table for short-lived provider interactions. A wallet address is public metadata. Only a successful provider interaction creates a verified link.

## Link a wallet

1. The signed-in user provides an Interledger Test Wallet address to `POST /api/wallet/approvals`.
2. The backend checks the Test Wallet host and discovers the address, asset and authorization server.
3. The backend requests a subject-only interactive grant, encrypts the continuation and nonces, and returns the provider's approval URL.
4. The wallet owner authenticates with the provider. The browser returns to the backend callback.
5. The backend checks the callback hash and expiry, claims the interaction once, continues the grant, and stores the verified wallet against the original app user.
6. The app reads `GET /api/wallet` to display the result.

The provider hosts account creation at [Test Wallet signup](https://wallet.interledger-test.dev/auth/signup). The [provider setup guide](https://openpayments.dev/sdk/before-you-begin/) documents its account-creation interface. No supported consumer wallet-provisioning API was identified in the reviewed Open Payments documentation, so the app opens the provider's signup page.

The same provider guide describes viewing and funding accounts through the Test Wallet dashboard. The reviewed [Open Payments SDK and endpoint index](https://openpayments.dev/overview/getting-started/) lists wallet-address, grant, incoming-payment, quote and outgoing-payment operations, but no account-balance operation. No documented Test Wallet balance API suitable for this app was identified. The app links to the provider dashboard instead of treating grant allowance as balance.

## Payment relationships

`payment_grants.payer_user_id` and `payer_wallet_address` identify the payer. New grants require a matching `verified_wallets` row. Device enrollment and redemption also require that match. An existing CLI-created grant can only be used after its owner verifies the same wallet in the app.

`merchants.user_id` identifies the receiver. `POST /api/merchant` takes a display name and derives the receiving address from the caller's verified wallet. Redemption checks that the merchant record still matches that association. The request body cannot select a different recipient.

The Supabase migrator records applied SQL filenames in `app_private.schema_migrations`. Existing encrypted records use key version 1. A separately configured current version 2 does not overwrite them. To read the older records, provide their original key as `DATA_ENCRYPTION_KEY_V1`. Without that key, the older grants and devices remain unreadable and must not be treated as usable.

Do not run the older version-1-only backend alongside a version-2 backend against the same database. Stop or upgrade every old instance before allowing version-2 payments. The updated backend checks recent code digests against each configured key version, but an older instance cannot check digests produced by the new key.

## Limits

One wallet is supported per app account. Wallet replacement, multi-wallet selection and unlinking are not implemented. Verification and live payments require the provider to be reachable and the owner to approve the interaction. See [SPRINT_TRACKER.md](SPRINT_TRACKER.md) for tested and blocked milestones.
