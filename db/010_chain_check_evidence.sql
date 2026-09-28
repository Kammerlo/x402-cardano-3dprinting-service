-- Retain the last independent chain-check result during the shared 15-second throttle.
-- Never store provider credentials or transaction payloads in these diagnostics.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS chain_status text
  CHECK (chain_status IN ('CONFIRMED','CONFIRMING','NOT_FOUND','MISMATCH','UNAVAILABLE','NOT_CONFIGURED'));
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS chain_confirmations integer;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS chain_required_confirmations integer;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS chain_checked_at timestamptz;
