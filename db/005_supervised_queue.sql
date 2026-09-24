-- A durable single-print gate. Existing orders and batches are retained.
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS current_batch_id uuid;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS gateway_operational boolean NOT NULL DEFAULT false;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS gateway_active boolean NOT NULL DEFAULT false;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS printer_state text;
ALTER TABLE print_batches ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- On upgrade, resume the oldest outstanding batch before creating another.
UPDATE shop_settings SET current_batch_id = (
  SELECT b.id FROM print_batches b
  WHERE b.confirmed_at IS NULL AND (
    b.status IN ('QUEUED','DISPATCHING','PRINTING','NEEDS_REVIEW')
    OR (b.status='PRINTED' AND EXISTS (
      SELECT 1 FROM orders o WHERE o.batch_id=b.id AND o.status='PRINTED'
    ))
  ) ORDER BY b.created_at,b.id LIMIT 1
) WHERE id=1 AND current_batch_id IS NULL;

CREATE INDEX IF NOT EXISTS orders_paid_queue_idx ON orders(paid_at,id) WHERE status='PAID';
CREATE INDEX IF NOT EXISTS orders_shipping_idx ON orders(created_at,id) WHERE status='PRINTED';
CREATE INDEX IF NOT EXISTS orders_pending_idx ON orders(id) WHERE status IN ('PAID','BATCHED','PRINTING');
CREATE INDEX IF NOT EXISTS orders_recent_idx ON orders(created_at DESC,id);
CREATE INDEX IF NOT EXISTS batches_recent_idx ON print_batches(created_at DESC,id);
CREATE INDEX IF NOT EXISTS attempts_recent_idx ON payment_attempts(created_at DESC,id);

-- Row locking on shop_settings serializes every batch creation and confirmation,
-- including concurrent Workers with separate Neon connections. The gateway only
-- sees current_batch_id, so queued batches from an older deployment are drained
-- in order before creating new work from paid orders.
CREATE OR REPLACE FUNCTION advance_print_queue(p_confirm uuid, p_limit integer)
RETURNS TABLE(batch_id uuid, batch_size integer, confirmed_batch_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_current uuid;
  v_status text;
  v_next uuid;
  v_size integer;
  v_ids uuid[];
BEGIN
  SELECT current_batch_id INTO v_current FROM shop_settings WHERE id=1 FOR UPDATE;
  IF p_confirm IS NOT NULL THEN
    IF v_current IS DISTINCT FROM p_confirm THEN
      RAISE EXCEPTION 'batch is not current' USING ERRCODE='P0001';
    END IF;
    SELECT status INTO v_status FROM print_batches WHERE id=v_current AND confirmed_at IS NULL;
    IF v_status IS NULL OR v_status NOT IN ('PRINTED','NEEDS_REVIEW') THEN
      RAISE EXCEPTION 'batch is not complete or reviewed' USING ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM orders WHERE batch_id=v_current
               AND status IN ('BATCHED','PRINTING','NEEDS_REVIEW')) THEN
      RAISE EXCEPTION 'resolve all orders in the batch before confirming' USING ERRCODE='P0001';
    END IF;
    UPDATE print_batches SET confirmed_at=now(),updated_at=now() WHERE id=v_current;
    UPDATE shop_settings SET current_batch_id=NULL WHERE id=1;
  ELSIF v_current IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT id,size INTO v_next,v_size FROM print_batches
  WHERE status='QUEUED' AND confirmed_at IS NULL
  ORDER BY created_at,id LIMIT 1;
  IF v_next IS NULL THEN
    SELECT array_agg(id) INTO v_ids FROM (
      SELECT id FROM orders WHERE status='PAID'
      ORDER BY paid_at,id LIMIT LEAST(4,GREATEST(1,p_limit))
      FOR UPDATE SKIP LOCKED
    ) picked;
    v_size := COALESCE(array_length(v_ids,1),0);
    IF v_size > 0 THEN
      v_next := gen_random_uuid();
      INSERT INTO print_batches(id,size) VALUES(v_next,v_size);
      UPDATE orders SET status='BATCHED',batch_id=v_next,updated_at=now()
      WHERE id=ANY(v_ids) AND status='PAID';
    END IF;
  END IF;
  UPDATE shop_settings SET current_batch_id=v_next WHERE id=1;
  RETURN QUERY SELECT v_next,COALESCE(v_size,0),p_confirm;
END;
$$;
