-- Additive upgrade: retain all signed attempts and orders.
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS receipt text;
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);
