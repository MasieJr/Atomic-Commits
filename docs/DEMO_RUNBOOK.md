# Record the offline payment demo

The complete live flow has not yet been demonstrated. Check [SPRINT_TRACKER.md](SPRINT_TRACKER.md) before recording. Use Interledger Test Wallet play money only.

The current Azure web app is at [varsity-connect-vc-2026.spaincentral.cloudapp.azure.com](https://varsity-connect-vc-2026.spaincentral.cloudapp.azure.com/). Its existing version-1 data key is unavailable. User A must verify their wallet again and approve a new spending grant under the version-2 key.

## Configure the backend

1. In `backend/.env`, set the Supabase `DATABASE_URL` and a `JWT_SECRET` of at least 32 characters. Set the current 32-byte base64 `DATA_ENCRYPTION_KEY` and its `DATA_ENCRYPTION_KEY_VERSION`. If version-1 records exist, keep their original key in `DATA_ENCRYPTION_KEY_V1`. Do not replace or discard an existing key.
2. Set `CLIENT_WALLET_ADDRESS_URL`, `KEY_ID`, and `PRIVATE_KEY_PATH` to the backend's registered Test Wallet developer identity. Keep the private key on the backend.
3. Set `PUBLIC_BASE_URL` to the backend's reachable HTTPS origin. The wallet owner must be able to reach this origin from the browser that opens provider consent. `http://localhost:3000` works only when that browser runs on the backend machine.
4. For a Flutter web session, set `WEB_ALLOWED_ORIGINS` to the exact app origin, such as `http://localhost:53211`. Separate multiple origins with commas. Native apps do not need this setting.
5. From `backend/`, install dependencies, apply the additive migrations to the configured Supabase database, and start the API:

```powershell
npm ci
npm run db:migrate
npm run dev
```

6. Open `/health` on the backend. It must return `{ "status": "ok" }`. Health does not check payment configuration. After login, `GET /api/wallet` must return HTTP 200; HTTP 503 indicates missing authentication or encryption configuration. The API reference is at `/api/docs`.

The current Supabase database contains version-1 encrypted records. A new version-2 key cannot read them without the original key in `DATA_ENCRYPTION_KEY_V1`. Stop or upgrade the old version-1-only server before accepting payments with the new backend. Never put keys, tokens, passwords or TOTP secrets in the recording or evidence.

## Prepare the two wallets

1. The owner of User A's existing Test Wallet signs in to the [provider dashboard](https://wallet.interledger-test.dev/). Confirm the sender account has test funds and a wallet address.
2. Keep the credentials for User A and User B separate. Register User B in Atomic Commit during the recording.
3. User B creates a provider account through [Test Wallet signup](https://wallet.interledger-test.dev/auth/signup), verifies the email, creates an account and adds a wallet address. Follow the [provider setup guide](https://openpayments.dev/sdk/before-you-begin/).
4. Choose small amounts in the receiver wallet's asset. Leave enough sender funds and grant allowance for fees, conversion and five payments.

## Start Flutter

From `mobile/`, use the backend HTTPS origin reachable from each device:

```powershell
flutter pub get
flutter run -d edge --web-port 53211 --dart-define=ATOMIC_API_BASE_URL=https://YOUR_API_ORIGIN/api
```

For Android, select the device with `-d` and use the same `--dart-define`. On the Windows machine in this workspace, Flutter is also available at `%USERPROFILE%\Development\SDKs\flutter\bin\flutter.bat`. A browser build requires HTTPS or localhost for secure storage.

## Record the scenes

1. Sign in as User A. Open **Wallet**, connect the sender address if it is not already verified, and approve the provider's ownership interaction. Set and review the spending allowance and per-payment maximum. Approve the separate provider spending request. Return to the app and refresh until the grant is approved.
2. Open **Send** while online. Select the approved grant and enroll the device. Keep the device clock synchronized.
3. On another device or browser profile, register User B. Open **Wallet**, choose **Create a new wallet**, complete provider signup, return, and choose **Connect an existing wallet**. Enter the new address and approve the provider ownership interaction. Refresh until the wallet is verified.
4. Disconnect User A's device. Open **Send** and show the locally generated code and QR. The displayed code changes every 30 seconds.
5. Keep User B online. Open **Receive**, then **Open merchant checkout**. Activate checkout, enter the purchase amount and the complete `PREFIX-123456` code, and submit.
6. Wait for **Payment confirmed**. Show the amount and incoming-payment reference. Open **Activity** for each account and show its own record. Use the provider dashboard or incoming-payment resource to corroborate receipt.
7. While the same code is still valid, start another checkout and submit it again. Show rejection and confirm that no second debit occurred.
8. Repeat with new codes until five small test-network payments have succeeded. Record each confirmed incoming-payment reference and amount in a secure evidence location, with sensitive values redacted.

If a payment is `UNKNOWN`, `PROCESSING`, or the request times out, do not submit it again. Check its existing history record and provider resources. An unresolved outcome is not a successful demo transaction.

If device enrollment times out or its one-time secret cannot be saved, choose **Check registered devices** on the payment-code screen. Revoke the affected device before enrolling again.

## Evidence to collect

| Item | Status | Evidence |
| --- | --- | --- |
| Two independent app accounts and wallet links | NOT TESTED | Record redacted account identifiers and wallet public identities. |
| Offline payer code and online merchant redemption | NOT TESTED | Record the app steps without exposing the TOTP secret. |
| Five provider-confirmed test payments | NOT TESTED | Record redacted incoming-payment references and amounts for each payment. |
| Replay rejected with no second debit | NOT TESTED | Record the rejection and provider-side payment count. |

The app does not expose an actual wallet balance. Show the balance in the provider dashboard. Camera scanning is not connected; enter the displayed code manually.
