# API reference

The backend serves the OpenAPI document at `/api/openapi.json` and Swagger UI at `/api/docs`. Except for health, registration, login and provider callbacks, routes require `Authorization: Bearer <app JWT>`. Errors use `{ "error": "...", "code": "..." }` when a machine-readable code is available.

Amounts are decimal strings in integer minor units. For example, `{ "value": "1234", "assetCode": "USD", "assetScale": 2 }` means USD 12.34. Payment codes and credentials must not be logged.

## Accounts

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /api/auth/register` | `name`, `email`, `password` | Creates an app user and returns `{ user, token, message }`. No wallet is created. |
| `POST /api/auth/login` | `email`, `password` | Returns `{ user, token, message }`. |
| `GET /api/auth/me` | Bearer token | Returns `{ user }`. |
| `POST /api/auth/logout` | None | Returns a message. The client discards its token; the JWT remains valid until expiry. |

## Wallet and merchant

| Method and path | Request | Result |
| --- | --- | --- |
| `GET /api/wallet` | None | Returns `{ wallet: null }` or the caller's verified address, public name, asset and verification time. |
| `POST /api/wallet/approvals` | `{ "walletAddress": "..." }` | Returns an approval ID and provider authorization URL. The owner must approve with the provider. |
| `GET /api/wallet/approvals/:id` | None | Returns the caller's verification state. Another user's ID returns 404. |
| `GET /api/wallet/callback/:id` | Provider interaction parameters | Verifies the callback and continues the subject grant. This is a browser callback, not an app-authenticated request. |
| `POST /api/merchant` | `{ "displayName": "..." }` | Activates or updates the caller's merchant using their verified wallet. A request body cannot select the receiving wallet. |

Wallet verification states are `AWAITING_APPROVAL`, `FINISHING`, `VERIFIED`, `FAILED` and `EXPIRED`.

## Spending grants and devices

`POST /api/payment-grants` starts consent for the caller's verified wallet. The body accepts `cumulativeCap` and `perPaymentMaxDebit`, both positive integer minor-unit strings. The second limit must not exceed the first. The response includes an approval ID and provider authorization URL. `GET /api/payment-grants/approvals/:id` reports the outcome. `GET /api/payment-grants` lists the caller's grants, and `DELETE /api/payment-grants/:grantId` revokes one.

`POST /api/devices/totp/enroll` takes `{ "authorizationId": "...", "deviceName": "..." }`. It returns the TOTP secret once. The client stores the complete packet securely and generates decimal six-digit codes locally. `GET /api/devices/totp` lists the caller's devices without secrets. `GET /api/devices/totp/:prefix/status` checks one device online, and `POST /api/devices/totp/:prefix/revoke` revokes it. A device cannot learn about a later revocation while offline.

## Redemption and history

`POST /api/offline-redemptions` requires an authenticated merchant and a unique `Idempotency-Key` header. Its body is:

```json
{
  "credentialType": "totp-v1",
  "paymentCode": "ABC234-123456",
  "merchantReceive": { "value": "1234", "assetCode": "USD", "assetScale": 2 }
}
```

The merchant's receiving address comes from the verified association. The payment code is a credential, not proof of payment. The response includes a payment ID and one of `AWAITING_AUTHORIZATION`, `SUBMITTING`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `UNKNOWN` or `REJECTED`.

`GET /api/payments/:paymentId` returns a payment only to its payer or merchant. `GET /api/payments` returns `{ asPayer, asMerchant }` for the caller. A `SUCCEEDED` receipt includes provider-confirmed amounts and provider references. `UNKNOWN` and `PROCESSING` are not success. Check the existing payment record rather than creating another payment when the outcome is unclear.
