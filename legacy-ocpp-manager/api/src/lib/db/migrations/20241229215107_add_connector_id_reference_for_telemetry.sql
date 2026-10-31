-- Migration: Adjust telemetry table
ALTER TABLE telemetry
ADD COLUMN connector_id INTEGER NOT NULL REFERENCES connector(id) ON DELETE CASCADE;
-- Make transaction_id optional
ALTER TABLE telemetry
ALTER COLUMN transaction_id DROP NOT NULL;
-- Add a NOT NULL constraint to connector_id
ALTER TABLE telemetry
ALTER COLUMN connector_id
SET NOT NULL;