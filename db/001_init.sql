CREATE TABLE IF NOT EXISTS shop_settings (id int PRIMARY KEY DEFAULT 1 CHECK(id=1), paused boolean NOT NULL DEFAULT false, gateway_last_seen timestamptz, gateway_armed boolean NOT NULL DEFAULT false, printer_ready boolean NOT NULL DEFAULT false);
INSERT INTO shop_settings(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS orders (
 id uuid PRIMARY KEY, access_hash text NOT NULL, customer_name text NOT NULL, email text NOT NULL,
 address_line1 text NOT NULL, address_line2 text NOT NULL DEFAULT '', postal_code text NOT NULL,
 city text NOT NULL, country text NOT NULL DEFAULT 'DE',
 product_id text NOT NULL DEFAULT 'proof-token', price_lovelace bigint NOT NULL,
 network text NOT NULL CHECK(network IN ('cardano:mainnet','cardano:preprod')),
 status text NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK(status IN ('AWAITING_PAYMENT','PAID','BATCHED','PRINTING','PRINTED','SHIPPED','NEEDS_REVIEW','REFUNDED')),
 tx_hash text UNIQUE, batch_id uuid, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_paid_idx ON orders(created_at) WHERE status='PAID';
CREATE TABLE IF NOT EXISTS payment_attempts (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), tx_hash text UNIQUE,
 signed_payload text, status text NOT NULL DEFAULT 'RECEIVED', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_payment_attempt_per_order ON payment_attempts(order_id);
CREATE TABLE IF NOT EXISTS print_batches (
 id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','DISPATCHING','PRINTING','PRINTED','NEEDS_REVIEW')),
 size int NOT NULL CHECK(size BETWEEN 1 AND 4), printer_filename text, gateway_job_id text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_batch ON print_batches((1)) WHERE status IN ('DISPATCHING','PRINTING');
CREATE TABLE IF NOT EXISTS order_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
 kind text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
