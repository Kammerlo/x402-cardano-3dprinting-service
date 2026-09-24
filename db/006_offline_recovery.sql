-- Operator-issued rearm commands are observed by the outbound-only gateway.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS gateway_rearm_generation bigint NOT NULL DEFAULT 0;
