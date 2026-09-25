-- Upgrade databases created before network-specific orders. Existing orders were mainnet-only.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'cardano:mainnet';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_network_check;
ALTER TABLE orders ADD CONSTRAINT orders_network_check CHECK(network IN ('cardano:mainnet','cardano:preprod'));
