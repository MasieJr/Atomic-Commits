-- 004: server-side grant approval (GNAP interaction handled by the API instead
-- of a localhost script). One row per approval attempt; the public callback URL
-- carries the random row id. Nonces and the grant continuation are secrets and
-- are stored only encrypted.
CREATE TABLE app_private.provider_interactions (
  id uuid PRIMARY KEY,
  owner_user_id integer NOT NULL REFERENCES app_private.users(id),
  purpose text NOT NULL DEFAULT 'OUTGOING_GRANT' CHECK (purpose IN ('OUTGOING_GRANT')),
  payer_wallet_address text NOT NULL,
  auth_server_url text NOT NULL,
  asset_code text NOT NULL,
  asset_scale smallint NOT NULL,
  cumulative_cap bigint NOT NULL CHECK (cumulative_cap > 0),
  per_payment_max_debit bigint NOT NULL CHECK (per_payment_max_debit > 0),
  valid_hours integer NOT NULL CHECK (valid_hours BETWEEN 1 AND 720),
  secrets_ciphertext bytea NOT NULL,
  key_version smallint NOT NULL,
  status text NOT NULL DEFAULT 'AWAITING_APPROVAL'
    CHECK (status IN ('AWAITING_APPROVAL', 'FINISHING', 'APPROVED', 'DENIED', 'FAILED', 'EXPIRED')),
  grant_id uuid REFERENCES app_private.payment_grants(id),
  error_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (per_payment_max_debit <= cumulative_cap)
);
CREATE INDEX provider_interactions_owner_idx ON app_private.provider_interactions (owner_user_id, created_at DESC);
