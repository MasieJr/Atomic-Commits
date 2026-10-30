# Atomic Commits

Open Payments hackathon prototype for offline-capable delegated payments.

The current demo is a static proof of concept showing a buyer-generated, short-lived payment authorization that a merchant can verify and settle over Open Payments.

## Demo

This repository is intended to be published with GitHub Pages from the `main` branch, repository root.

## Current direction

- one payer ↔ Atomic Commits setup relationship, rather than pairing with every shop
- portable payer alias + offline-generated verification code
- short-lived authorization, up to 30 minutes
- single-use redemption / replay rejection
- merchant supplies the eventual Open Payments recipient at redemption
- paper is only one possible transport; QR, SMS and human-readable codes are also possible

Hackathon work in progress.

## Offline payer CLI (Test Wallet demo)

While online, the payer logs in and enrolls the device through the backend API.
The CLI saves the one-time server-issued profile locally, and then generates a
short-lived code without a network connection. It does not check the wallet
balance or verify the current grant while offline.
A displayed code is a credential, not a payment or receipt. Synchronize the
device clock before disconnecting; the merchant and backend remain online.

From `backend/` with Node.js 20 or newer:

```powershell
npm ci
npm run build
# Install the atomic.cmd launcher in your npm global bin directory on Windows:
npm link
atomic connect
atomic status
atomic pay
```

`atomic connect` prompts for the API URL if `--api-url` and `ATOMIC_API_URL`
are absent, then asks for the payer's email and password. The password is not
echoed and the login token is not persisted. The API URL must use HTTPS, except
that HTTP is allowed for localhost development. If there is more than one active
provider grant, choose the payer wallet from the displayed list.

The CLI enrolls against an **existing** active provider grant. The newer backend
grant-approval API is not yet integrated into `atomic connect`. If no approved
grant is available, enrollment stops and reports that prerequisite. No packet
file needs to be copied. If a one-time enrollment response is lost, check and
revoke the server device before attempting enrollment again.

If the launcher is not on `PATH`, add the npm global prefix directory (printed
by `npm config get prefix`) to `PATH`, or use `npm run atomic -- pay` from
`backend/`. Re-run `npm run build` after changing the TypeScript source.

### Windows batch launcher

After the one-time `npm ci` and `npm run build` above, double-click
`atomic.bat` in the repository root. Choose **Connect to the API** while
online, then use the menu to show a payment code or the local profile location. On the payment
screen, press **R** to refresh or **M** to return to the menu. Codes use fixed
30-second clock steps, so the time remaining when a code first appears can be
less than 30 seconds; the displayed expiry is when it stops being current on
the device.
The launcher and `pay` work offline once enrollment is complete. The merchant
and backend remain online for redemption.

From a terminal, `atomic.bat` also accepts the CLI commands directly, for
example `atomic.bat pay` or `atomic.bat connect`.

### API enrollment contract

The CLI calls `POST /api/auth/login`, `GET /api/payment-grants` and
`POST /api/devices/totp/enroll`. The current backend returns a version-1 packet
with a four-to-twelve-character prefix, a Base32 secret, `algorithm: "SHA1"`,
`digits: 6`, `periodSeconds: 30`, an expiry and a revocation flag. It generates
standard six-decimal-digit RFC 6238 codes; the CLI uses the same format for this
profile. The merchant submits the code to `POST /api/offline-redemptions` and
can check the result with `GET /api/payments/:id`.

API profiles live separately under `%APPDATA%\atomic-commits\api-device` on
Windows, or `${XDG_DATA_HOME:-~/.local/share}/atomic-commits/api-device` on
POSIX. `ATOMIC_API_DEVICE_HOME` can override that directory with an absolute
path. The same owner-only protection and no-overwrite rules apply. A saved
profile's local status cannot report a later remote revocation while offline.

### Legacy local-only demo profile

`atomic setup` creates the JSON below if no profile exists. Its secret has
160 random bits, its four-character prefix is randomly generated, and its local expiry is
seven days after setup; that expiry does not establish provider grant validity.
The command reuses an existing profile and fails closed on a corrupt, revoked,
expired or unprotected one instead of replacing it. A protected version 1
profile is upgraded to version 2 with the same secret and expiry; its old
prefix is shortened to its first four characters. The backend must register
the new prefix and format before redemption.

This older local-only profile is not registered by `atomic setup` and is not
compatible with the current API's decimal TOTP. `atomic pay` requires API
enrollment by default; the old demo can be explicitly enabled with
`ATOMIC_ALLOW_LOCAL_DEMO=1`. Use `atomic connect` for API enrollment. The legacy
JSON has exactly these fields:

```json
{
  "version": 2,
  "prefix": "4RTW",
  "secret": "<DEVICE_BASE32_SECRET>",
  "algorithm": "SHA1",
  "codeEncoding": "BASE36-HOTP31",
  "codeLength": 6,
  "periodSeconds": 30,
  "expiresAtEpochMs": 2000000000000,
  "revoked": false
}
```

The values above are illustrative; the automatically generated profile has its
own prefix, secret and expiry. A separately prepared packet can still be
imported with `atomic enroll --file <path>` before local setup. Its secret
must contain at least 20 decoded bytes in canonical RFC 4648 Base32, and its
prefix must be exactly four uppercase ASCII letters or digits. Unsupported fields,
invalid secrets, locally known revocation and expired enrollment are rejected.
Keep any extra packet copy outside the repository and dispose of it securely;
the CLI cannot secure the transfer channel for you.

The default profile is stored at
`%APPDATA%\atomic-commits\device\device-profile.json` on Windows or
`${XDG_DATA_HOME:-~/.local/share}/atomic-commits/device/device-profile.json`
on POSIX. The CLI restricts the dedicated directory and file to the current
Windows user via ACLs, or to modes `0700` and `0600` on POSIX, and refuses to
use them if protection is missing. `ATOMIC_DEVICE_HOME` can override the
dedicated directory with an absolute path. This is demo-level file protection,
not a keychain or hardware enclave; the same user account can read the secret.
Re-enrollment refuses to overwrite an existing profile: remove the old profile
explicitly only when it is safe to replace it.

### Legacy alphanumeric code contract

`backend/src/domain/payment-engine/totp.ts` exports:

```ts
generateTotp(secret, atEpochMs) // { code, timeStep, expiresAtEpochMs }
verifyTotp(secret, code, atEpochMs, allowedDriftSteps) // {valid:true,timeStep} | {valid:false}
formatPaymentCode(prefix, code) // XXXX-XXXXXX
parsePaymentCode(presentation) // {prefix,code} | undefined
```

The secret is canonical Base32. The code is **six uppercase alphanumeric
characters**, generated with `BASE36-HOTP31`:

1. Compute `floor(atEpochMs / 30000)` and encode the counter as eight
   big-endian bytes.
2. Compute HMAC-SHA1 with the device secret. Use RFC 4226 dynamic truncation
   to obtain the unsigned 31-bit integer.
3. Convert that integer to uppercase base36 (`0-9`, `A-Z`) and left-pad with
   `0` to exactly six characters. Do **not** reduce it modulo one million.

This is a custom presentation of the time-based HOTP value, **not** the usual
six-decimal-digit TOTP. Both client and backend must implement the same
encoding. For an interoperability check, the public test secret
`GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ` at `59000` epoch milliseconds produces
step `1` and code `I3IDBE`, presented with prefix `4RTW` as `4RTW-I3IDBE`.
This public vector is not an enrolled secret.

`allowedDriftSteps` is `0` or `1`; a value
of `1` accepts the current step and at most one adjacent step on either side.
Verification returns the matched step for the backend's atomic device/step
claim. Invalid verifier configuration throws; invalid codes, secrets or times
return `{valid:false}`. The parser rejects extra characters, including whitespace.

The six-character code does not bind the merchant or the amount, and the TOTP
module does not enforce one-use. Josh's backend must authenticate the merchant,
enforce the approved payer-debit and aggregate caps, and durably claim the
matched device/time-step before submitting a debit. **Code collisions are
possible:** the same six characters can correspond to different steps, so a unique
device/time-step claim alone cannot guarantee that a replayed presentation
never triggers a second debit. The redemption design also needs an atomic,
bounded recent-code replay guard (without storing codes in logs) and must
return the original attempt for an idempotent retry. The real disconnected
laptop, remote merchant, provider transfer and restart/replay rehearsal remain
integration gates.
