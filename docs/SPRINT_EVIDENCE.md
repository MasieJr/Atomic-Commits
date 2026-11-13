# Sprint verification evidence

This file separates live Test Wallet observations from automated tests. Do not add credentials, authorization URLs, TOTP secrets or unredacted account details.

## Live provider checks

| Check | Result | Evidence |
| --- | --- | --- |
| Start subject-only wallet verification | PASS | The configured Test Wallet accepted an interactive subject grant for the configured sender wallet. |
| Cancel the pending subject grant | PASS | The provider confirmed cancellation. No payment was requested. |
| Complete wallet ownership consent | NOT TESTED | Requires the wallet owner's interaction and the configured public callback. |
| Approve spending grants | PASS | The deployed backend logged two provider-approved grant interactions. The client used for each interaction was not independently verified. Provider credentials are not included here. |

Earlier backend-only Test Wallet experiments are recorded in [payment-proofs.md](payment-proofs.md) and [payment-proof-c.md](payment-proof-c.md). They used separate CLI workflows and do not prove the current two-user Flutter journey.

## Application payment receipts

Earlier attempts ended `FAILED / PROVIDER_FAILED` or `REJECTED / QUOTE_EXCEEDS_LIMIT`. The first successful transfer below was independently checked against the provider's outgoing and incoming resources. The incoming resource was complete and its received amount matched the app record. The outgoing resource was not failed, matched the intended wallets and quote, and reported the recorded sent amount. The temporary read-only provider grant was cancelled afterward.

| Transaction | Result | Received amount and asset | Redacted provider incoming reference | App payment status |
| --- | --- | --- | --- | --- |
| 1 | PASS | EUR 5.00 | SHA-256 prefix `226ca29c4454a74e` | SUCCEEDED |
| 2 | NOT TESTED | | | |
| 3 | NOT TESTED | | | |
| 4 | NOT TESTED | | | |
| 5 | NOT TESTED | | | |

Replay rejection and absence of a second debit: **NOT TESTED**.

Transaction 1 was created at `2026-11-13T09:28:43.912Z` and completed at `2026-11-13T09:28:50.660Z`. The provider reported ZAR 92.06 sent. The reference is a hash prefix, not the raw provider URL. The user's device connectivity during code generation was not independently observed.

## Automated checks

The Flutter tests include simulated API responses and an offline code-screen test that makes no API request. A headless Edge smoke test also registers and logs in simulated users, enrolls a simulated device, switches the browser offline, decodes a valid QR without an API request, submits a simulated checkout and rejects a simulated replay. Backend provider tests use a simulated SDK. These checks do not demonstrate movement of test-network funds. Exact commands and current results are in [SPRINT_TRACKER.md](SPRINT_TRACKER.md).
