-- Google is an additional credential for a local integer user ID, not an email link.
CREATE TABLE app_private.google_oauth_identities (
  subject text PRIMARY KEY CHECK (char_length(subject) BETWEEN 1 AND 255),
  user_id integer NOT NULL UNIQUE REFERENCES app_private.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app_private.google_oauth_attempts (
  id uuid PRIMARY KEY,
  state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  poll_secret_hash bytea NOT NULL CHECK (octet_length(poll_secret_hash) = 32),
  nonce_hash bytea NOT NULL CHECK (octet_length(nonce_hash) = 32),
  verifier_ciphertext bytea,
  key_version smallint,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'link_required', 'linking', 'ready', 'consumed', 'cancelled', 'expired', 'failed')),
  user_id integer REFERENCES app_private.users(id) ON DELETE CASCADE,
  -- Only a verified callback can select the subject/account for password proof.
  link_subject text CHECK (char_length(link_subject) BETWEEN 1 AND 255),
  link_user_id integer REFERENCES app_private.users(id) ON DELETE CASCADE,
  link_checks smallint NOT NULL DEFAULT 0 CHECK (link_checks BETWEEN 0 AND 5),
  link_next_check_at timestamptz,
  consume_requests smallint NOT NULL DEFAULT 0 CHECK (consume_requests BETWEEN 0 AND 60),
  consume_window_expires_at timestamptz,
  failure_code text CHECK (failure_code IN ('google_verification_failed', 'processing_timeout', 'link_attempts_exhausted', 'link_conflict')),
  processing_deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (
    (status IN ('pending', 'processing') AND verifier_ciphertext IS NOT NULL
      AND octet_length(verifier_ciphertext) >= 28 AND key_version IS NOT NULL AND key_version > 0)
    OR (status NOT IN ('pending', 'processing') AND verifier_ciphertext IS NULL AND key_version IS NULL)
  ),
  CHECK ((status IN ('processing', 'linking')) = (processing_deadline IS NOT NULL)),
  CHECK (processing_deadline IS NULL OR processing_deadline <= expires_at),
  CHECK ((status IN ('link_required', 'linking')) = (link_subject IS NOT NULL)),
  CHECK ((status IN ('link_required', 'linking')) = (link_user_id IS NOT NULL)),
  CHECK (status <> 'link_required' OR link_checks < 5),
  CHECK (status <> 'linking' OR link_checks > 0),
  CHECK ((consume_requests = 0) = (consume_window_expires_at IS NULL)),
  CHECK ((status = 'ready') = (user_id IS NOT NULL)),
  CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);

CREATE INDEX google_oauth_attempts_expiry_idx ON app_private.google_oauth_attempts (expires_at);
CREATE INDEX google_oauth_attempts_processing_idx ON app_private.google_oauth_attempts (processing_deadline)
  WHERE status IN ('processing', 'linking');

-- Shared across processes. Requests are charged before checking the attempt proof.
CREATE TABLE app_private.google_oauth_link_limits (
  ip_hash bytea PRIMARY KEY CHECK (octet_length(ip_hash) = 32),
  requests smallint NOT NULL CHECK (requests BETWEEN 1 AND 10),
  expires_at timestamptz NOT NULL
);
CREATE INDEX google_oauth_link_limits_expiry_idx ON app_private.google_oauth_link_limits (expires_at);

-- Separate from password login. New attempts/IPs cannot reset this account's budget.
CREATE TABLE app_private.google_oauth_link_account_limits (
  user_id integer PRIMARY KEY REFERENCES app_private.users(id) ON DELETE CASCADE,
  checks smallint NOT NULL CHECK (checks BETWEEN 1 AND 10),
  expires_at timestamptz NOT NULL
);
CREATE INDEX google_oauth_link_account_limits_expiry_idx ON app_private.google_oauth_link_account_limits (expires_at);

-- Direct backend Postgres access only. No browser/Supabase Data API policies.
ALTER TABLE app_private.google_oauth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.google_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.google_oauth_link_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.google_oauth_link_account_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.google_oauth_identities, app_private.google_oauth_attempts,
  app_private.google_oauth_link_limits, app_private.google_oauth_link_account_limits FROM PUBLIC;
