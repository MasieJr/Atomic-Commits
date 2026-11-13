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

The deployed backend recorded two payment attempts during this sprint. One ended `FAILED / PROVIDER_FAILED`; the other ended `REJECTED / QUOTE_EXCEEDS_LIMIT`. Neither is counted as a successful payment. Fill this table only after the provider's incoming-payment resource confirms the amount. Use redacted references.

| Transaction | Result | Received amount and asset | Redacted provider incoming reference | App payment status |
| --- | --- | --- | --- | --- |
| 1 | NOT TESTED | | | |
| 2 | NOT TESTED | | | |
| 3 | NOT TESTED | | | |
| 4 | NOT TESTED | | | |
| 5 | NOT TESTED | | | |

Replay rejection and absence of a second debit: **NOT TESTED**.

## Automated checks

The Flutter tests include simulated API responses and an offline code-screen test that makes no API request. A headless Edge smoke test also registers and logs in simulated users, enrolls a simulated device, switches the browser offline, decodes a valid QR without an API request, submits a simulated checkout and rejects a simulated replay. Backend provider tests use a simulated SDK. These checks do not demonstrate movement of test-network funds. Exact commands and current results are in [SPRINT_TRACKER.md](SPRINT_TRACKER.md).
