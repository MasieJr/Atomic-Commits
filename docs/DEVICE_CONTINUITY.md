# Device continuity design

This is a proposal, not an implemented transition or automatic enrollment flow.
Existing enrollment remains manual and returns the secret once. A lost response
can leave an active server device without a usable local profile.

## Release gate: do not wire a rebind endpoint yet

The requested guarantee cannot be implemented safely by adding only a rebind
service, route, migration, and sheet. Redemption currently has no grant-epoch
cutoff check (`offline-redemption.ts`, the locked-device check before claim),
and bearer logout is stateless (`controllers/auth.ts` and `services/tokens.ts`).
An in-flight request remains authenticated after logout. Shipping a transition
before both paths are changed would claim guarantees the system does not have.
No transition endpoint or migration is provided by this proposal.

There is a further protocol limit: six-digit TOTP values do not identify when
they were displayed. A code displayed before a switch can equal a later code,
and a client holding the secret can calculate future codes. A step cutoff alone
cannot prove that an arbitrary presented value was not previously displayed.
The product must either accept a precisely bounded, clock-skew-based guarantee
with a collision policy, or change the payment credential/protocol to bind a
grant epoch. Preserving the existing secret and prefix does not by itself bind
the displayed digits to an epoch. Do not represent a step cutoff as an absolute
proof of code provenance.

## Integration contract for a bounded TOTP transition

This contract is contingent on an explicit decision accepting the bounded
guarantee above, and on deployment of redemption enforcement before any rebind
is enabled. No provider or payment call belongs in the rebind transaction.

* The authenticated request carries an unpredictable durable operation ID,
  device prefix, expected old grant ID and explicitly selected target grant ID.
  The payer must see the target wallet, asset, per-payment and cumulative
  limits, remaining amount and expiry and confirm the exact selection. Reject
  identical old and target grants. Never choose a target on the payer's behalf.
* Persist the operation ID and canonical request under the payer, with a unique
  constraint, and the committed result in the same transaction as the device
  update. Serialize concurrent uses of the same ID, including the no-row-yet
  case. An exact duplicate returns the original result; changed parameters fail.
  Results are historical, not evidence of the device's current state. Provide
  an authenticated operation lookup and current device status separately.
* Lock the two owned grant rows in ascending UUID order, then the owned device;
  recheck its active status and expected grant, expiry and ownership under lock.
  The old grant must still be active and valid; a revoked or expired device is
  never revived. Check target `PROVIDER` authority, active status, validity,
  verified wallet binding and decryptable usable stored authority. Reject an
  active device already bound to the target. Let the existing partial unique
  index arbitrate concurrent target enrollment. Lock or otherwise serialize any
  wallet/authority writer that can invalidate these checks, and audit lock order
  against all existing writers before release.
* While holding the device lock, reject any device attempt in
  `AWAITING_AUTHORIZATION`, `SUBMITTING`, `PROCESSING` or `UNKNOWN`. Every
  attempt-creation path must acquire the same device lock and recheck its grant;
  audit finalization's attempt/reservation/grant order for deadlocks. Preserve
  all attempts, reservations, claims, digests, ID, prefix and ciphertext.
  Change only the device's grant, a monotonic cutoff and an expiry no later than
  the existing expiry and target grant expiry. Do not restart enrollment life.
* Under the lock, obtain a trusted server time after lock acquisition, not
  PostgreSQL transaction-start `now()`. If accepted client clock lead is at
  most `D` 30-second steps, set the first eligible step strictly greater than
  the server step plus `D`, monotonically across rebinds. Redemption must read
  and enforce this cutoff under the device lock at claim and revalidate before
  submission, with its grant-identity check. Define and enforce a clock-rollback
  policy; a client outside the skew bound is not protected by this cutoff.
  Reject ambiguous values matching both sides of the cutoff within the accepted
  verification window, rather than trusting `verifyTotp`'s first match. Existing
  replay claims do not cover unredeemed displayed codes. A collision with an
  older step outside that window, or a precomputed future code, remains
  indistinguishable: this is the bounded guarantee, not absolute prevention.
* Couple logout to a server-side session/version row checked and locked in the
  same transaction, with logout taking a compatible lock and invalidating that
  session. This requires changes outside the authorized files. Define the
  linearization rule: a rebind committed before logout is valid; one serialized
  after logout must fail. Authenticate operation lookup too, and do not let an
  account change reconcile another payer's operation.
* Persist the operation request locally before sending. On timeout, crash, or
  local write failure, mark the result unknown, retain the secret and block a
  new switch or use that assumes either grant. Reauthenticate as the same payer
  and look up the operation; retry only the identical operation ID and request,
  never a fresh ID on ambiguity. After a confirmed result, reconcile current
  device status because a later rebind or revocation may have occurred. Update
  local expiry and displayed grant only after that reconciliation and durable
  read-back; show the server cutoff/wait and do not display a usable code until
  eligible. A revoked or expired result must not reactivate the profile.

The implementation must define the schema and exact route and status codes only
after resolving the provenance and session requirements; no migration number is
reserved by this document. Rollout must fail closed if any redemption instance
lacks cutoff enforcement, including during rolling deployment or rollback.

## Current constraints

`totp_devices.authorization_id` links a device to one grant, and a partial
unique index allows one active device per grant. Grant revocation also revokes
its active devices in `payment-grants.ts`. A revoked device must not be revived
by a transition. Move an active device before revoking its old grant, or design
a separate, explicitly approved recovery flow. Neither exists yet.

Redemption reads the device before locking the grant and then the device. It
now checks that the locked device still names the grant read earlier, both when
claiming a code and before submission. This is a prerequisite for a transition,
not proof that the transition is safe. Claims and replay digests belong to the
device, while attempts and reservations retain their original grant.

## Proposed explicit transition

The payer selects a specific new grant and sees its wallet, limits, and expiry
before confirming. The request names the device prefix, expected old grant, new
grant, and a durable operation ID. The server authenticates the payer and checks
ownership of the device and both grants. It never selects a replacement grant.

In one transaction, lock both grant rows in a deterministic ID order, then lock
the device row. Recheck the device's owner, active status, and expected grant
after locking. Reject a target already used by another active device. Require a
currently valid, active provider grant, the payer's verified wallet, and usable
provider authority. Do not change grant limits or create provider authority.
The existing approval flow must establish provider consent independently.

Reject the transition while any attempt for the device is
`AWAITING_AUTHORIZATION`, `SUBMITTING`, `PROCESSING`, or `UNKNOWN`. Check under
the device lock, and prove that every path that creates such an attempt holds
that lock. Do not release reservations, delete claims, or move historical
attempts to the new grant. An unresolved outcome stays on the original grant
until reconciliation proves it final. The claim and recent-code replay checks
must continue across the transition, including codes displayed before it.

Update the existing device row, retaining its ID, prefix, encrypted secret, and
replay history. Bound the new device expiry by the new grant's expiry and the
device enrollment lifetime policy. Decide explicitly whether expired devices
can transition and whether the 30-day enrollment lifetime can restart; do not silently
extend it. The mobile client must update its local expiry only after a confirmed
server result and must show the new grant's limits, not the enrollment-time
limit. If local persistence fails, retain the secret and retry reconciliation.

Persist the operation ID and its exact request and result in the same
transaction. A retry with the same operation ID and request returns the
original result, even if a later operation changed the device again. A reused
ID with different parameters fails. A stale expected grant fails without
switching. A bare check that the device already names the target is insufficient
because it cannot distinguish an earlier transition from a later one.

The grant-first order must be reviewed against every grant, device, attempt,
and reservation writer, including finalization and revocation. In particular,
`markSucceeded` updates an attempt and reservation before updating the grant.
The implementation must avoid introducing a lock cycle with that path. Test
concurrent transitions in both directions, revocation, redemption, and payment
finalization against PostgreSQL before release.

## Proposed recoverable first enrollment

Separate attempt creation from device creation. The server issues an opaque,
unguessable attempt ID bound to the authenticated payer and selected grant.
Creating an attempt alone must not enroll a device. The client persists the ID
in secure storage before requesting device creation. If the first response is
lost before persistence, creating another empty attempt is safe.

The server serializes creation on that attempt and the grant, records one
device and recoverable encrypted packet atomically, and returns the same packet
for a retry of that attempt. Bind recovery to the authenticated owner and the
attempt capability, rate-limit it, send `Cache-Control: no-store`, and exclude
secrets and capability IDs from logs. A different attempt cannot recover that
packet or silently replace the device. Define attempt expiry and cleanup so an
expired attempt with an already-created device does not make the secret
unrecoverable without an explicit recovery path.

The client saves and reads back the profile before acknowledging completion.
Acknowledgment must be idempotent. Its cleanup policy must account for lost
acknowledgment responses, crashes, secure-storage failures, concurrent app
instances, logout and account changes. Automatic setup must not call the current
one-time enrollment endpoint in a retry loop. These requirements need a schema,
protocol, mobile state machine, and security review before implementation.

## Verification required

Use isolated PostgreSQL integration tests for transaction races and rollback,
including stale device reads, replay across grants, duplicate operation IDs,
provider-grant expiry, revocation, and every unresolved payment state. Exercise
crashes and lost responses at every enrollment and transition boundary, with
secure-storage failures and account changes. Verify provider-approved limits
and wallet binding using controlled provider fixtures. No live payment or
provider interaction is needed for those tests.
