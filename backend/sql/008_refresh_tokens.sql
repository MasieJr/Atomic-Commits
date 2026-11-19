CREATE TABLE app_private.refresh_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES app_private.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by bigint REFERENCES app_private.refresh_tokens (id)
);

CREATE INDEX refresh_tokens_user_id_idx ON app_private.refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expires_at_idx ON app_private.refresh_tokens (expires_at);
