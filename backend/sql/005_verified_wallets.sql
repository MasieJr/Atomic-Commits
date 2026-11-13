-- One verified external wallet per account; verification secrets never leave the server.
CREATE TABLE app_private.verified_wallets (
  user_id integer PRIMARY KEY REFERENCES app_private.users(id),
  wallet_address text NOT NULL,
  auth_server_url text NOT NULL,
  asset_code text NOT NULL CHECK (asset_code ~ '^[A-Z]{3,12}$'),
  asset_scale smallint NOT NULL CHECK (asset_scale BETWEEN 0 AND 18),
  public_name text,
  verified_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_private.wallet_verifications (
  id uuid PRIMARY KEY,
  owner_user_id integer NOT NULL REFERENCES app_private.users(id),
  wallet_address text NOT NULL,
  auth_server_url text NOT NULL,
  asset_code text NOT NULL,
  asset_scale smallint NOT NULL,
  public_name text,
  secrets_ciphertext bytea NOT NULL,
  key_version smallint NOT NULL,
  status text NOT NULL DEFAULT 'AWAITING_APPROVAL'
    CHECK (status IN ('AWAITING_APPROVAL', 'FINISHING', 'VERIFIED', 'FAILED', 'EXPIRED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_verifications_owner_idx
  ON app_private.wallet_verifications (owner_user_id, created_at DESC);
