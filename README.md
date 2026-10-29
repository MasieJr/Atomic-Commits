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

The payer can create a protected local device profile automatically, or import
a previously coordinated profile, and then generate a short-lived code with no
network connection. The CLI does not connect to the provider, check the wallet
balance, or verify the current grant.
A displayed code is a credential, not a payment or receipt. Synchronize the
device clock before disconnecting; the merchant and backend remain online.

From `backend/` with Node.js 20 or newer:

```powershell
npm ci
npm run build
# Install the atomic.cmd launcher in your npm global bin directory on Windows:
npm link
atomic setup
atomic status
atomic pay
```

If the launcher is not on `PATH`, add the npm global prefix directory (printed
by `npm config get prefix`) to `PATH`, or use `npm run atomic -- pay` from
`backend/`. Re-run `npm run build` after changing the TypeScript source.

### Windows batch launcher

After the one-time `npm ci` and `npm run build` above, double-click
`atomic.bat` in the repository root. On first run it creates a random device
secret, a public prefix, and a protected local JSON profile automatically.
Its menu shows the profile location and displays a payment code. On the payment
screen, press **R** to refresh or **M** to return to the menu. Codes use fixed
30-second clock steps, so the time remaining when a code first appears can be
less than 30 seconds; the displayed expiry is when it stops being current on
the device.
The launcher and `pay` work offline once the CLI is built; they do not install
packages or contact a server. **Local setup does not register the device with
the merchant backend or activate a provider grant.** Those online steps must
still happen before a merchant can redeem its codes.

From a terminal, `atomic.bat` also accepts the CLI commands directly, for
example `atomic.bat pay` or `atomic.bat enroll --file "C:\path\packet.json"`.

### Local JSON profile and backend registration

`atomic setup` creates the JSON below if no profile exists. Its secret has
160 random bits, its four-character prefix is randomly generated, and its local expiry is
seven days after setup; that expiry does not establish provider grant validity.
The command reuses an existing profile and fails closed on a corrupt, revoked,
expired or unprotected one instead of replacing it. A protected version 1
profile is upgraded to version 2 with the same secret and expiry; its old
prefix is shortened to its first four characters. The backend must register
the new prefix and format before redemption.

For a real redemption, the backend must register **this same prefix and secret**
over a trusted channel before the payer disconnects. The backend must enforce
prefix uniqueness and reject a collision; random generation alone cannot
guarantee it. The backend enrollment API is not implemented here, so coordinate
the secure transfer and registration with Josh. The JSON has exactly these fields:

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

### Backend integration contract

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
