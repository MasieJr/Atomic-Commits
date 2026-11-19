-- Cutover requires all old API, worker, and seed processes stopped and drained.
-- Apply this entire migration atomically before starting any new writers.
-- Preserve the existing wallet and its verification timestamp for every user.
ALTER TABLE app_private.verified_wallets DROP CONSTRAINT verified_wallets_pkey;
ALTER TABLE app_private.verified_wallets
  ADD COLUMN is_default_spending boolean NOT NULL DEFAULT false,
  ADD COLUMN is_default_receiving boolean NOT NULL DEFAULT false,
  ADD PRIMARY KEY (user_id, wallet_address);

UPDATE app_private.verified_wallets
   SET is_default_spending = true, is_default_receiving = true;

CREATE UNIQUE INDEX verified_wallets_one_spending_default
  ON app_private.verified_wallets (user_id) WHERE is_default_spending;
CREATE UNIQUE INDEX verified_wallets_one_receiving_default
  ON app_private.verified_wallets (user_id) WHERE is_default_receiving;

-- Pending legacy approvals retain their single-wallet behavior.
ALTER TABLE app_private.wallet_verifications
  ADD COLUMN allow_additional boolean NOT NULL DEFAULT false;

-- NULL means the historical destination is unknown, not the current merchant address.
ALTER TABLE app_private.payment_attempts ADD COLUMN receiving_wallet_snapshot text;
-- NULL is reserved for attempts created before this migration.
ALTER TABLE app_private.payment_attempts ADD COLUMN receiving_wallet_explicit boolean;
-- Pending at cutover remains locked even after terminal status: cleanup can lag it.
-- Release only through an audited operator procedure after all cleanup is resolved.
-- The immutability trigger deliberately prevents normal updates from releasing it:
-- operators must investigate each attempt and its provider/cleanup state, then
-- use a separately reviewed privileged maintenance procedure. Never backfill a
-- guessed historical destination or clear the lock merely because status is terminal.
ALTER TABLE app_private.payment_attempts ADD COLUMN legacy_destination_locked boolean NOT NULL DEFAULT false;
UPDATE app_private.payment_attempts SET legacy_destination_locked = true
 WHERE status IN ('AWAITING_AUTHORIZATION', 'SUBMITTING', 'PROCESSING', 'UNKNOWN');

CREATE FUNCTION app_private.guard_receiving_wallet_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.receiving_wallet_snapshot IS NULL OR NEW.receiving_wallet_explicit IS NULL OR NEW.legacy_destination_locked THEN
      RAISE EXCEPTION 'New payment attempts require a receiving wallet snapshot';
    END IF;
   ELSIF NEW.receiving_wallet_snapshot IS DISTINCT FROM OLD.receiving_wallet_snapshot
     OR NEW.receiving_wallet_explicit IS DISTINCT FROM OLD.receiving_wallet_explicit
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.legacy_destination_locked IS DISTINCT FROM OLD.legacy_destination_locked THEN
    RAISE EXCEPTION 'Payment attempt destination is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_attempts_guard_destination
  BEFORE INSERT OR UPDATE ON app_private.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_receiving_wallet_snapshot();

-- Keep the legacy lookup stable even during asynchronous terminal cleanup.
-- Terminal-at-cutover history is exempt; pending-at-cutover remains locked.
CREATE FUNCTION app_private.guard_legacy_merchant_destination() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.receiving_wallet_address IS DISTINCT FROM OLD.receiving_wallet_address
     AND EXISTS (SELECT 1 FROM app_private.payment_attempts
                  WHERE merchant_id = OLD.id AND legacy_destination_locked) THEN
    RAISE EXCEPTION 'Merchant destination is locked by a legacy pending payment'
      USING ERRCODE = '23514', CONSTRAINT = 'merchant_legacy_destination_guard';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER merchants_guard_legacy_destination
  BEFORE UPDATE OF receiving_wallet_address ON app_private.merchants
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_merchant_destination();
