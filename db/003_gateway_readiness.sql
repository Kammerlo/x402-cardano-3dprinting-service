-- Add operator gateway liveness to existing databases.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS gateway_last_seen timestamptz;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS gateway_armed boolean NOT NULL DEFAULT false;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS printer_ready boolean NOT NULL DEFAULT false;
