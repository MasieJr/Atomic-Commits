# Multiple-wallet cutover and legacy destination locks

**Deployment blocker:** `AWAITING_AUTHORIZATION` attempts are not recovered by the current reconciliation worker. A crash can leave their reservations and, after cutover, their legacy destination locks indefinitely in place. Do not deploy this cutover until a reviewed recovery design has been verified against concurrent database writers and in-flight provider calls. Do not release a reservation or lock just because the attempt is old or appears pre-submit: a live request may still be progressing, and a quote may have created an incoming payment without saving its reference. The release procedure below applies only after the attempt has independently reached an eligible terminal state; it is not a recovery procedure for a stuck attempt.

Migration `006_multiple_wallets.sql` assumes it runs once, in one transaction, after all old API, worker, and seed writers have stopped and in-flight requests have drained. Back up the database and record the deployment, migration version, operator, time, and recovery plan before proceeding. Verify every old writer is stopped; do not run old and new writers together. Apply the migration atomically, verify it committed and the destination-guard triggers are enabled, then start only the new version. This is an operator procedure, not an instruction to run it automatically.

At cutover, each unresolved attempt is marked `legacy_destination_locked`. Its snapshot is NULL: the merchant's current address is used only because the lock prevents that address from changing. A terminal status does **not** clear the lock: asynchronous incoming-payment cleanup may still be in flight or have failed. Terminal-at-cutover history has no lock and no known snapshot. Never infer or backfill a historical destination from the current merchant address. Keep unresolved payments and their holds intact; a missing provider listing is not proof of non-payment. Never resubmit a payment to investigate it.

## Inventory and investigation

Use an authorized read-only connection and retain the results in the incident record, with access restricted because wallet addresses and provider references are sensitive:

```sql
SELECT a.id, a.merchant_id, m.receiving_wallet_address, a.status,
       a.receiving_wallet_snapshot, a.legacy_destination_locked,
       a.provider_incoming_ref, a.provider_quote_ref, a.provider_attempt_ref,
       a.error_code, a.created_at, a.updated_at,
       c.id AS claim_id, c.state AS claim_state,
       r.id AS reservation_id, r.state AS reservation_state
  FROM app_private.payment_attempts a
  JOIN app_private.merchants m ON m.id = a.merchant_id
  LEFT JOIN app_private.totp_code_claims c ON c.payment_attempt_id = a.id
  LEFT JOIN app_private.spending_reservations r ON r.claim_id = c.id
 WHERE a.legacy_destination_locked
 ORDER BY a.merchant_id, a.id;
```

For each attempt, record its ID, merchant, locked address, timestamps, provider references, status, claim and reservation states, and evidence sources. Use read-only reconciliation and provider records to establish the definitive payment outcome; involve the provider if necessary. For a successful payment, verify settlement and that the claim and reservation are completed/committed. For a failed or rejected payment, establish definitively that there was no debit, that the claim and reservation were released, and that any incoming payment is closed or otherwise definitively no longer needs cleanup against the locked address. Check application logs, including `payment.incoming_close_failed`, and provider-side evidence: absence of a failure log alone is not proof of cleanup. If no incoming reference exists, document evidence that no incoming payment was created or remains to be cleaned up. Determine whether any process is still carrying out cleanup; terminal status alone does not establish this.

If outcome, destination, cleanup, accounting, or in-flight activity is uncertain, **stop** and retain the lock. Escalate rather than guessing or changing statuses, claims, reservations, snapshots, or provider references. The normal reconciliation path may resolve some attempts; it does not automatically release these locks.

## Audited release of one investigated lock

Obtain independent approval of the per-attempt evidence and an approved maintenance window. Stop and drain **all** API, reconciliation, worker, seed, and other database writers, including in-flight provider calls and cleanup; ensure they cannot restart during maintenance. This is essential because cleanup can read the old address before a status becomes terminal and finish afterward. Take a fresh backup and record the change ticket, evidence, approver, operator, exact attempt ID, pre-change inventory, and time in an independently retained audit record. Use a privileged database owner only for this procedure. A merchant remains locked until every one of its locked attempts is separately resolved and released.

In `psql`, set `attempt_id` to the approved UUID, enable `ON_ERROR_STOP`, and execute the following as one transaction. The explicit table lock prevents concurrent attempts while the immutability trigger is temporarily disabled; stopping writers is still required for work already outside the database. The checks are necessary but do not replace the external evidence and cleanup investigation above. If any statement fails, `ROLLBACK`; do not bypass a failed check. The temporary trigger disable and update roll back together if the transaction aborts.

```sql
\set ON_ERROR_STOP on
-- Set attempt_id separately, from the approved ticket: \set attempt_id 'UUID'
BEGIN;
LOCK TABLE app_private.payment_attempts IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE release_target (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO release_target VALUES (:'attempt_id'::uuid);
DO $$
BEGIN
  IF (SELECT count(*) FROM app_private.payment_attempts a JOIN release_target t ON t.id = a.id
       WHERE a.legacy_destination_locked AND a.receiving_wallet_snapshot IS NULL
         AND ((a.status = 'SUCCEEDED' AND EXISTS (
               SELECT 1 FROM app_private.totp_code_claims c
               JOIN app_private.spending_reservations r ON r.claim_id = c.id
                WHERE c.payment_attempt_id = a.id AND c.state = 'COMPLETED' AND r.state = 'COMMITTED'))
           OR (a.status IN ('FAILED', 'REJECTED') AND EXISTS (
               SELECT 1 FROM app_private.totp_code_claims c
               JOIN app_private.spending_reservations r ON r.claim_id = c.id
                WHERE c.payment_attempt_id = a.id AND c.state = 'RELEASED' AND r.state = 'RELEASED')))) <> 1
     OR EXISTS (SELECT 1 FROM app_private.totp_code_claims c
                JOIN release_target t ON t.id = c.payment_attempt_id
                LEFT JOIN app_private.spending_reservations r ON r.claim_id = c.id
                JOIN app_private.payment_attempts a ON a.id = t.id
               WHERE (a.status = 'SUCCEEDED' AND (c.state <> 'COMPLETED' OR r.state IS DISTINCT FROM 'COMMITTED'))
                  OR (a.status IN ('FAILED', 'REJECTED') AND (c.state <> 'RELEASED' OR r.state IS DISTINCT FROM 'RELEASED'))) THEN
    RAISE EXCEPTION 'Attempt is not eligible for lock release';
  END IF;
END $$;
ALTER TABLE app_private.payment_attempts DISABLE TRIGGER payment_attempts_guard_destination;
UPDATE app_private.payment_attempts SET legacy_destination_locked = false
 WHERE id = (SELECT id FROM release_target) AND legacy_destination_locked;
ALTER TABLE app_private.payment_attempts ENABLE TRIGGER payment_attempts_guard_destination;
COMMIT;
```

Capture the transaction output and post-change inventory in the audit record. Compare with the saved pre-change inventory: verify the intended row alone changed, its snapshot remains NULL, and all other locked attempts remain locked. Verify the trigger states with the following query: both rows must be present with `tgenabled = 'O'` (enabled for normal origin sessions).

```sql
SELECT c.relname, t.tgname, t.tgenabled
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'app_private'
   AND ((c.relname = 'payment_attempts' AND t.tgname = 'payment_attempts_guard_destination')
     OR (c.relname = 'merchants' AND t.tgname = 'merchants_guard_legacy_destination'));
```

Only then restart the new writers and confirm normal operation. If verification fails, keep writers stopped and investigate; do not restore a backup over intervening writes or alter payment data without a separate reviewed recovery plan.
