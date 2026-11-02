-- 003: grant revocation tracking and payment receipts.

-- Local revocation blocks spending immediately; this column tracks the
-- provider-side cancellation separately, because it can fail or be deferred.
ALTER TABLE app_private.payment_grants
  ADD COLUMN provider_revocation text NOT NULL DEFAULT 'NONE'
    CHECK (provider_revocation IN ('NONE', 'NOT_REQUIRED', 'PENDING', 'CONFIRMED', 'DEFERRED_UNRESOLVED_PAYMENTS', 'FAILED')),
  ADD COLUMN revoked_at timestamptz;

-- Provider-confirmed amounts (receipt data), separate from the quoted debit.
ALTER TABLE app_private.payment_attempts
  ADD COLUMN payer_debit_paid_value bigint CHECK (payer_debit_paid_value >= 0),
  ADD COLUMN merchant_receive_paid_value bigint CHECK (merchant_receive_paid_value >= 0),
  ADD COLUMN completed_at timestamptz;

CREATE INDEX payment_attempts_payer_idx ON app_private.payment_attempts (payer_user_id, created_at DESC);
CREATE INDEX payment_attempts_merchant_idx ON app_private.payment_attempts (merchant_id, created_at DESC);
