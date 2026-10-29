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

The payer can import a previously coordinated device profile while online and
then generate a short-lived code with no network connection. The CLI does not
connect to the provider, check the wallet balance, or verify the current grant.
A displayed code is a credential, not a payment or receipt. Synchronize the
device clock before disconnecting; the merchant and backend remain online.

From `backend/` with Node.js 20 or newer:

```powershell
npm ci
npm run build
# Install the atomic.cmd launcher in your npm global bin directory on Windows:
npm link
atomic enroll --file "C:\path\outside\repo\atomic-enrollment.json"
atomic status
atomic pay
```

If the launcher is not on `PATH`, add the npm global prefix directory (printed
by `npm config get prefix`) to `PATH`, or use `npm run atomic -- pay` from
`backend/`. Re-run `npm run build` after changing the TypeScript source.

### Trusted enrollment packet

The backend and payer must agree on a **unique** public prefix and share the
same independently generated device secret over a trusted channel before going
offline. The backend enrollment API is not implemented here; agree this packet
with Josh before importing it. The packet is JSON with exactly these fields:

```json
{
  "version": 1,
  "prefix": "4RTW",
  "secret": "<DEVICE_BASE32_SECRET>",
  "algorithm": "SHA1",
  "digits": 6,
  "periodSeconds": 30,
  "expiresAtEpochMs": 2000000000000,
  "revoked": false
}
```

Replace the placeholder with a cryptographically random per-device secret; the
packet **must** contain at least 20 decoded bytes, encoded in canonical RFC 4648
Base32. Set the local
expiry to the agreed future Unix timestamp in milliseconds (the example value
is illustrative). Prefixes are 4–12 uppercase ASCII letters or digits. The
profile rejects unsupported versions/parameters, unknown fields, malformed
secrets, locally known revocation and expired enrollment. Keep the packet
outside the repository and dispose of the source copy securely after import;
the CLI cannot remove copies or secure the transfer channel for you.

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
formatPaymentCode(prefix, code) // PREFIX-123456
parsePaymentCode(presentation) // {prefix,code} | undefined
```

The secret is canonical Base32; the moving counter uses a 30-second step and
HMAC-SHA1 with six decimal digits. `allowedDriftSteps` is `0` or `1`; a value
of `1` accepts the current step and at most one adjacent step on either side.
Verification returns the matched step for the backend's atomic device/step
claim. Invalid verifier configuration throws; invalid codes, secrets or times
return `{valid:false}`. The parser rejects extra characters, including whitespace.

The six-digit code does not bind the merchant or the amount, and the TOTP
module does not enforce one-use. Josh's backend must authenticate the merchant,
enforce the approved payer-debit and aggregate caps, and durably claim the
matched device/time-step before submitting a debit. **Code collisions are
possible:** the same six digits can correspond to different steps, so a unique
device/time-step claim alone cannot guarantee that a replayed presentation
never triggers a second debit. The redemption design also needs an atomic,
bounded recent-code replay guard (without storing codes in logs) and must
return the original attempt for an idempotent retry. The real disconnected
laptop, remote merchant, provider transfer and restart/replay rehearsal remain
integration gates.
