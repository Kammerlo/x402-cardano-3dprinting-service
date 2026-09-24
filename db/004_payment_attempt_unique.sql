-- Only one signed transaction may be submitted per order.
CREATE UNIQUE INDEX IF NOT EXISTS one_payment_attempt_per_order ON payment_attempts(order_id);
