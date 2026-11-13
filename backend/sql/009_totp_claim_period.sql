-- Long (30-minute) payment codes share the claim table with 30-second codes.
-- A time_step only identifies a rotation inside one period, so the single-use
-- key must include period_seconds: step 0 of a long code is not step 0 of a
-- short code. Existing rows are 30-second claims (default).

ALTER TABLE app_private.totp_code_claims
  ADD COLUMN period_seconds integer NOT NULL DEFAULT 30
  CHECK (period_seconds IN (30, 1800));

ALTER TABLE app_private.totp_code_claims
  DROP CONSTRAINT totp_code_claims_device_id_time_step_key;

ALTER TABLE app_private.totp_code_claims
  ADD CONSTRAINT totp_code_claims_device_id_period_seconds_time_step_key
  UNIQUE (device_id, period_seconds, time_step);
