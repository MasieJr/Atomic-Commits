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
| 2 | PASS | EUR 1.00 | SHA-256 prefix `37237f2c74a879f1` | SUCCEEDED |
| 3 | PASS | EUR 1.00 | SHA-256 prefix `c03e1a2dbbb22c20` | SUCCEEDED |
| 4 | PASS | EUR 1.00 | SHA-256 prefix `49c03e5a2c722d36` | SUCCEEDED |
| 5 | NOT TESTED | | | |

Replay rejection: **PASS, user-reported**. The user reported that submitting the second code again was rejected. A subsequent read of the provider's grant counter matched exactly the two recorded debits at that point: ZAR 110.48 in total. After four successful transfers, the provider counter matched all recorded debits at ZAR 147.32. No additional debit was observed.

Transaction 1 was created at `2026-11-13T09:28:43.912Z` and completed at `2026-11-13T09:28:50.660Z`. The provider reported ZAR 92.06 sent. The reference is a hash prefix, not the raw provider URL. The user's device connectivity during code generation was not independently observed.

Transaction 2 was created at `2026-11-13T10:01:39.440Z` and completed at `2026-11-13T10:01:46.388Z`. A separate provider read confirmed EUR 1.00 received and ZAR 18.42 sent. The temporary read-only provider grant was cancelled.

The user reported that transactions 3 and 4 were made with the payer offline. Transaction 3 was created at `2026-11-13T10:09:23.433Z` and completed at `2026-11-13T10:09:28.672Z`. Transaction 4 was created at `2026-11-13T10:09:41.992Z` and completed at `2026-11-13T10:09:46.793Z`. Direct provider reads confirmed EUR 1.00 received and ZAR 18.42 sent for each. The temporary read-only provider grant was cancelled.

## Automated checks

The Flutter tests include simulated API responses and an offline code-screen test that makes no API request. A headless Edge smoke test also registers and logs in simulated users, enrolls a simulated device, switches the browser offline, decodes a valid QR without an API request, submits a simulated checkout and rejects a simulated replay. Backend provider tests use a simulated SDK. These checks do not demonstrate movement of test-network funds. Exact commands and current results are in [SPRINT_TRACKER.md](SPRINT_TRACKER.md).
