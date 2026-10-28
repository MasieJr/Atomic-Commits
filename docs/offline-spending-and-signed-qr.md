# Offline spending envelopes and signed instructions (L4/L5 draft)

This branch provides a backend policy, versioned instruction parser, Ed25519 verification and a reservation orchestration seam. A payer device can eventually present an instruction offline under a previously issued envelope; settlement still requires an online merchant, backend and provider. The code is **not wired to an API, database, provider, or Flutter application** and does not submit payments.

The 2026-10-28 live Proof C run **PASSED** for the configured Test Wallet pair, with two rotations and a confirmed transfer after 25 minutes. This does not demonstrate offline-device redemption, durable recovery, other providers or real-money settlement. Offline spending must not be enabled solely because these checks pass.

## Enrollment and policy

`OfflineSpendingEnvelope` is an authoritative server-issued record independent of each device-created instruction. It binds the payer and verified wallet, provider authorization, device/key and revocation versions, payer asset, per-payment ceiling, cumulative cap, validity window, and optional merchant scope. It cannot widen the current grant. The earlier L3 `OfflineEnvelope` describes a credential containing an instruction; adapters must map these distinct types explicitly and must not treat one as an issued spending authorization.

`evaluateOfflineSpendingPolicy` consumes trusted, server-loaded snapshots of the enrollment, device, wallet, merchant, provider grant and quote. The provider authority snapshot has a server-controlled identity, observation time and bounded validity window; an absent, future-dated or expired snapshot is refused. It rejects unverified or revoked authority and devices, mismatched ownership or merchant bindings, expired/future-dated instructions and stale quotes. Server time is authoritative; this draft allows **zero clock skew**. The instruction and envelope must fit the grant's validity window.

All payer amounts use exact minor-unit strings, asset code and scale. The quote's **payer debit**, not merchant-receive units, must fit the signed ceiling and both envelope and grant per-payment limits. The signed maximum is reserved against cumulative limits after accounting for provider spending and outstanding reservations. An adapter must account for all potentially unsettled debits; overcounting is conservative, undercounting is unsafe.

## Version 1 signed wire format

The QR carries an object with exactly `payload` and `signature`. The payload contains `version`, `envelopeId`, `authorizationId`, `instructionId`, `deviceId`, `keyVersion`, `nonce`, `issuedAtEpochMs`, `expiresAtEpochMs`, `assetCode`, `assetScale`, `maxDebitMinor`, and optional `merchantScopeId`. Unknown fields are rejected. Identifiers use printable ASCII without spaces, bounded to 256 characters. Monetary values are positive canonical integer strings of at most 18 digits. The nonce is canonical unpadded base64url encoding of 16–32 cryptographically random bytes and must never be reused.

`offlineInstructionSigningBytes` wraps the payload in L3's versioned canonical JSON and adds `purpose: "atomic-commits/offline-payment"`. Object keys sort recursively by UTF-8 bytes, with no insignificant whitespace; the version is bound in both the outer wrapper and payload. The signature is unpadded base64url of the 64-byte Ed25519 signature. The 32-byte public key is loaded from the trusted enrolled-device registry, **never from the QR**. Provider access tokens, continuations and device private keys must never be in the QR, logs or events.

### Public interoperability vector

The following is a public test fixture, not an enrolled device credential. UTF-8 encode the exact `canonicalUtf8` string to verify the signature with the public key:

```json
{
  "canonicalUtf8": "{\"body\":{\"assetCode\":\"USD\",\"assetScale\":2,\"authorizationId\":\"grant-1\",\"deviceId\":\"device-1\",\"envelopeId\":\"env-1\",\"expiresAtEpochMs\":1700000060000,\"instructionId\":\"instruction-1\",\"issuedAtEpochMs\":1700000000000,\"keyVersion\":\"key-1\",\"maxDebitMinor\":\"60\",\"merchantScopeId\":\"merchant-1\",\"nonce\":\"MDEyMzQ1Njc4OWFiY2RlZg\",\"purpose\":\"atomic-commits/offline-payment\",\"version\":\"1\"},\"version\":\"1\"}",
  "publicKey": "dZ3FNPiVCIIz92ye9xThyC7aHFheRaXpBVp3bmK-gFY",
  "signature": "qjetMd3QjV6TXJTo-G4Yesg1yX27xaqoH8NC01mCeWvDQBl1DxhpdTBfnME5KdHSeatVDuXPLeEVPKzVjPBZAw"
}
```

Ed25519 is a **draft interoperability choice**, not evidence of device security. [Dart cryptography](https://pub.dev/packages/cryptography) documents Ed25519 and a Dart fallback on Android; [cryptography_flutter](https://pub.dev/packages/cryptography_flutter) lists its native Ed25519 implementation for Apple platforms. [flutter_secure_storage](https://pub.dev/packages/flutter_secure_storage) documents encrypted storage, which does not establish that an Ed25519 private key is hardware-backed or non-exportable. The project has not installed or tested these libraries on a supported Android device. The Flutter owner must verify key custody, offline signing and byte-for-byte interoperability before choosing a production device implementation.

## Reservation boundary

`reserveSignedOfflineInstruction` receives the merchant identity from an authenticated server-side principal, loads the enrolled public key, and validates the device signature **before** requesting fresh snapshots or a provider quote. It then applies policy and invokes `claimAndReserve` once. Its request fingerprint covers the signed instruction, authenticated merchant and requested merchant-receive amount, but not a provider quote ID. It returns `RESERVED`, a definitive `REJECTED`, or `RESERVATION_UNKNOWN`; **reserved does not mean paid**.

The storage adapter must implement `claimAndReserve` transactionally across replicas: enforce global nonce uniqueness, reread owner/device/grant revocation and expiry, verify the same current, unexpired provider-authority snapshot and merchant constraints, account for existing reservations, and reserve the maximum debit without exceeding either cap. Provider state is external: a snapshot is not proof that it cannot change after reservation, and authority must be revalidated before any later debit. The adapter must refuse if it cannot honor these obligations; an in-process lock is not a production substitute. It must retain consumed nonce records after a failed payment. A reservation is held for an unknown debit and released only following confirmed failure; confirmed success consumes the nonce and records the claim. A timeout or malformed claim response is `RESERVATION_UNKNOWN` and must be reconciled rather than blindly retried.

L4/L5 acceptance additionally requires a real transactional adapter, verified provider behavior, Flutter offline instruction creation and platform key-custody tests. Those are not demonstrated by the in-memory test fakes in this branch.
