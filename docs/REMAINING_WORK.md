# Remaining implementation work

This plan records work after the Wallet and spending-permission changes on PR #7.
Keep existing payment attempts, provider authority, and unrelated working-tree
changes intact. A submitted or unknown payment must never be retried as a new
debit merely to complete a release.

## Current release and future deployments

- The web app and matching backend changes from commit `70878d0` are deployed.
  The app and backend must remain coordinated: the permission screen describes
  the 30-day app limit enforced by this backend.
- Before restarting the backend, stop new payment submissions and allow
  in-flight requests to finish. Preserve unknown attempts and their reservations.
  Back up the installed files and retain a rollback path for both components.
- Check the public app, service health, authorization failures, and deployed
  asset versions. Obtain permission before making another live payment.
- Static JavaScript compression is configured separately in
  `deploy/azure-vm/nginx.conf.example`. The public server has that configuration.

## Google sign-in and verified email

- Google sign-in is implemented behind a disabled-by-default flag. It uses the
  existing login and signup screens, server-side token verification, PKCE,
  state, nonce, and explicit password proof before linking an existing account.
  Configure the provider and verify the browser redirect before enabling it.
- Apply the Google identity schema independently of the unfinished multi-wallet
  migration. The current migrator applies all pending SQL files, so do not use
  it against the live database until the pending migration order is safe.
- The email-code signup flow is implemented behind a disabled-by-default flag.
  Configure the Supabase email template and delivery service, then verify the
  provider response and delivery before enabling it. Missing configuration must
  not unexpectedly disable the currently deployed signup flow.
- Check sign-in, linking, verification, cancellation, and account isolation using
  the configured providers. Do not put provider credentials in the app bundle.

## Offline read-only data

- The activity snapshot is implemented in the PR and scoped to the existing
  session. A simulated browser preview confirmed offline restart. Verify
  logout, account switching, and real-device behavior. Finish the separate
  wallet snapshot work with the same isolation guarantees.
- Purge or block snapshots on logout and definitive authorization rejection.
  Serialize account changes with cache writes, and prevent late responses from
  restoring another account's data. Handle storage failures across restarts.
- Cached permissions are never spending authority or a wallet balance. Disable
  actions that need current server state when displaying a cached wallet.
- The session-scoped activity design is in
  [Offline activity snapshots](OFFLINE_ACTIVITY_DESIGN.md).

## Device continuity

- Replace one-time, unrecoverable enrollment responses with a durable enrollment
  operation that can return the same encrypted result after a lost response.
- Design an explicit grant transition for an existing device. Do not silently
  switch grants, reuse old displayed codes under new authority, revive revoked
  devices, or move unresolved payments. The protocol and session constraints are
  described in [Device continuity](DEVICE_CONTINUITY.md).
- Keep device management in Wallet and show the selected permission and device
  state accurately. Existing devices and existing grants keep their stored expiry.

## Multiple wallets and payment credentials

- Complete the multi-wallet cutover before applying `006_multiple_wallets.sql`.
  Drain old writers, preserve each payment's destination snapshot, account for
  unresolved attempts, and define rollback before changing the live schema.
- A 30-minute amount-bound code needs a separate, high-entropy, single-use
  credential. Bind the exact merchant receive amount and maximum payer debit;
  share durable grant reservations with existing payment methods. Do not extend
  the acceptance window of the existing 30-second offline TOTP.
- Continue to distinguish pending, unknown, failed, and provider-confirmed
  payments. A receipt requires confirmed payer debit and merchant receipt.

## App lock and provider identity

- Add an opt-in native app lock only after the host, local authentication,
  lifecycle, recovery, and secure-storage behavior are defined. Browser and
  embedded WebView support require their own verified capabilities; a local UI
  flag is not account authentication.
- The provider consent screen displays the developer wallet's public name.
  The wallet owner can change `leeroy-pay` in Test Wallet's wallet-address
  settings, then confirm the new name on an actual consent screen. This does not
  require changing the wallet address or signing keys.
