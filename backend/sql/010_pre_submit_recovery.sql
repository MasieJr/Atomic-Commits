ALTER TABLE app_private.payment_attempts
  ADD COLUMN preparation_phase text,
  ADD COLUMN preparation_owner uuid,
  ADD COLUMN preparation_lease_until timestamptz,
  ADD CONSTRAINT payment_preparation_state CHECK (
    (preparation_phase IS NULL AND preparation_owner IS NULL AND preparation_lease_until IS NULL)
    OR (preparation_phase IS NOT NULL AND preparation_owner IS NOT NULL AND preparation_lease_until IS NOT NULL
        AND preparation_phase IN ('RESERVED', 'CREATING_INCOMING', 'INCOMING_KNOWN', 'RECOVERING')
        AND (preparation_phase <> 'INCOMING_KNOWN' OR provider_incoming_ref IS NOT NULL))
  );

CREATE INDEX payment_attempts_abandoned_preparation_idx
  ON app_private.payment_attempts (preparation_lease_until, id)
  WHERE status = 'AWAITING_AUTHORIZATION'
    AND preparation_phase IN ('RESERVED', 'INCOMING_KNOWN', 'RECOVERING');
