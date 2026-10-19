-- Personal data erasure after the retention period, and the checkout acknowledgement.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS personal_data_erased_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS terms_acknowledged_at timestamptz;

-- Order limit set in the admin dashboard. 0 means unlimited.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS max_orders int NOT NULL DEFAULT 0;
ALTER TABLE shop_settings DROP CONSTRAINT IF EXISTS shop_settings_max_orders_check;
ALTER TABLE shop_settings ADD CONSTRAINT shop_settings_max_orders_check CHECK (max_orders BETWEEN 0 AND 1000000);
