-- Bound public chain lookups across Worker instances. Existing orders are preserved.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS chain_check_after timestamptz;
