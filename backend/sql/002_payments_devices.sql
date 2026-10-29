-- 002: payer grants, TOTP devices, merchants, claims, payment attempts, reservations.
-- Money is stored as exact integer minor units (bigint); never floating point.
-- Secrets (TOTP seeds, provider tokens) are stored ONLY as AES-GCM ciphertext.

-- Provider-approved (or, for demo testing only, placeholder) spending authority.
CREATE TABLE app_private.payment_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_user_id integer NOT NULL REFERENCES app_private.users(id),
  payer_wallet_address text NOT NULL,
  -- PROVIDER = real provider-issued grant. DEMO_PLACEHOLDER = test row with NO
  -- provider authority; redemption must refuse it.
  authority_source text NOT NULL DEFAULT 'PROVIDER'
    CHECK (authority_source IN ('PROVIDER', 'DEMO_PLACEHOLDER')),
  provider_grant_ref text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ROTATING', 'BLOCKED', 'REAUTHORIZATION_REQUIRED', 'REVOKED', 'EXPIRED')),
  asset_code text NOT NULL CHECK (asset_code ~ '^[A-Z]{3,12}$'),
  asset_scale smallint NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  cumulative_cap bigint NOT NULL CHECK (cumulative_cap > 0),
  per_payment_max_debit bigint NOT NULL CHECK (per_payment_max_debit > 0),
  cumulative_spent bigint NOT NULL DEFAULT 0 CHECK (cumulative_spent >= 0),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  revocation_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until > valid_from),
  CHECK (per_payment_max_debit <= cumulative_cap),
  CHECK (cumulative_spent <= cumulative_cap)
);
CREATE INDEX payment_grants_payer_idx ON app_private.payment_grants (payer_user_id);

-- Encrypted provider credentials (access / management / continuation tokens).
CREATE TABLE app_private.provider_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES app_private.payment_grants(id),
  kind text NOT NULL CHECK (kind IN ('ACCESS_TOKEN', 'MANAGEMENT_URL', 'CONTINUATION')),
  ciphertext bytea NOT NULL,
  key_version smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grant_id, kind)
);

-- A merchant is a normal login account that ALSO has a row here. A customer
-- token alone never authorizes redemption. The receiving wallet comes from this
-- row, never from request JSON.
CREATE TABLE app_private.merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL UNIQUE REFERENCES app_private.users(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 80),
  receiving_wallet_address text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_private.totp_devices (
  id uuid PRIMARY KEY,
  payer_user_id integer NOT NULL REFERENCES app_private.users(id),
  authorization_id uuid NOT NULL REFERENCES app_private.payment_grants(id),
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 60),
  prefix text NOT NULL CONSTRAINT totp_devices_prefix_key UNIQUE
    CHECK (prefix ~ '^[A-Z0-9]{4,12}$'),
  secret_ciphertext bytea NOT NULL,
  key_version smallint NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  revocation_version integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
-- One active enrollment per grant: an ordinary retry cannot silently mint a second one.
CREATE UNIQUE INDEX totp_devices_one_active_per_grant
  ON app_private.totp_devices (authorization_id) WHERE status = 'ACTIVE';
CREATE INDEX totp_devices_payer_idx ON app_private.totp_devices (payer_user_id);

CREATE TABLE app_private.payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_user_id integer NOT NULL REFERENCES app_private.users(id),
  merchant_id uuid NOT NULL REFERENCES app_private.merchants(id),
  grant_id uuid NOT NULL REFERENCES app_private.payment_grants(id),
  device_id uuid NOT NULL REFERENCES app_private.totp_devices(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('AWAITING_AUTHORIZATION', 'SUBMITTING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REJECTED')),
  merchant_receive_value bigint NOT NULL CHECK (merchant_receive_value > 0),
  merchant_receive_asset_code text NOT NULL,
  merchant_receive_asset_scale smallint NOT NULL,
  payer_debit_value bigint CHECK (payer_debit_value > 0),
  payer_debit_asset_code text,
  payer_debit_asset_scale smallint,
  provider_incoming_ref text,
  provider_quote_ref text,
  provider_attempt_ref text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);
CREATE INDEX payment_attempts_status_idx ON app_private.payment_attempts (status);

-- Single-use code claims. UNIQUE(device, time_step) is necessary but not
-- sufficient; code_digest (keyed HMAC, never the plaintext code) backs the
-- bounded recent-code replay guard enforced inside the claim transaction.
CREATE TABLE app_private.totp_code_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES app_private.totp_devices(id),
  time_step bigint NOT NULL CHECK (time_step >= 0),
  code_digest bytea NOT NULL,
  merchant_id uuid NOT NULL REFERENCES app_private.merchants(id),
  request_fingerprint text NOT NULL,
  payment_attempt_id uuid REFERENCES app_private.payment_attempts(id),
  state text NOT NULL DEFAULT 'CLAIMED'
    CHECK (state IN ('CLAIMED', 'COMPLETED', 'HELD_UNKNOWN', 'RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, time_step)
);
CREATE INDEX totp_code_claims_recent_idx
  ON app_private.totp_code_claims (device_id, code_digest, created_at);

CREATE TABLE app_private.spending_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES app_private.payment_grants(id),
  claim_id uuid NOT NULL UNIQUE REFERENCES app_private.totp_code_claims(id),
  amount bigint NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'RESERVED'
    CHECK (state IN ('RESERVED', 'COMMITTED', 'RELEASED', 'HELD_UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spending_reservations_grant_idx ON app_private.spending_reservations (grant_id, state);
