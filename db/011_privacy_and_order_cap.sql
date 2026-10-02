-- Personal data erasure after the retention period, and the checkout acknowledgement.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS personal_data_erased_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_acknowledged_at timestamptz;
