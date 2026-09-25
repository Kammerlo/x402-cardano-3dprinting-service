-- Additive operational state; preserve all existing orders and plate history.
CREATE TABLE IF NOT EXISTS admin_sessions (
  session_hash text PRIMARY KEY, credential_hash text NOT NULL, csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS admin_login_limits (bucket bigint PRIMARY KEY, attempts integer NOT NULL);
CREATE TABLE IF NOT EXISTS admin_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL, session_tag text NOT NULL, response_status integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS available_batch_sizes integer[] NOT NULL DEFAULT '{}';
ALTER TABLE print_batches ADD COLUMN IF NOT EXISTS start_authorized_until timestamptz;
ALTER TABLE print_batches DROP CONSTRAINT IF EXISTS print_batches_size_check;
ALTER TABLE print_batches ADD CONSTRAINT print_batches_size_check CHECK(size BETWEEN 1 AND 1000);

CREATE OR REPLACE FUNCTION start_print_batch(p_expected uuid)
RETURNS TABLE(batch_id uuid, batch_size integer)
LANGUAGE plpgsql AS $$
DECLARE
  s shop_settings%ROWTYPE;
  b print_batches%ROWTYPE;
  v_size integer;
  v_ids uuid[];
  v_next uuid;
BEGIN
  SELECT * INTO s FROM shop_settings WHERE id=1 FOR UPDATE;
  IF s.current_batch_id IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'The current plate changed. Refresh before starting.';
  END IF;
  IF s.gateway_last_seen IS NULL OR s.gateway_last_seen < now()-interval '30 seconds'
     OR s.gateway_active OR NOT s.printer_ready OR COALESCE(s.printer_state,'unknown') NOT IN ('standby','complete') THEN
    RAISE EXCEPTION 'Printer is not ready. Check the printer and gateway, then try again.';
  END IF;
  IF cardinality(s.available_batch_sizes)=0 THEN
    RAISE EXCEPTION 'No usable G-code batch files are available.';
  END IF;
  IF s.current_batch_id IS NOT NULL THEN
    SELECT * INTO b FROM print_batches WHERE id=s.current_batch_id FOR UPDATE;
    IF b.status='QUEUED' THEN
      IF NOT (b.size=ANY(s.available_batch_sizes)) THEN RAISE EXCEPTION 'The queued plate needs its original G-code batch file.'; END IF;
      UPDATE print_batches SET start_authorized_until=now()+interval '60 seconds',updated_at=now() WHERE id=b.id;
      RETURN QUERY SELECT b.id,b.size;
      RETURN;
    END IF;
    IF b.status NOT IN ('PRINTED','NEEDS_REVIEW') OR EXISTS (
      SELECT 1 FROM orders WHERE orders.batch_id=b.id AND status IN ('BATCHED','PRINTING','NEEDS_REVIEW')
    ) THEN RAISE EXCEPTION 'Review the current print and resolve its orders before starting another plate.'; END IF;
    UPDATE print_batches SET confirmed_at=now(),updated_at=now() WHERE id=b.id;
    UPDATE shop_settings SET current_batch_id=NULL WHERE id=1;
  END IF;
  -- Old queued plates are drained before assigning new paid orders.
  SELECT id,size INTO v_next,v_size FROM print_batches WHERE status='QUEUED' AND confirmed_at IS NULL ORDER BY created_at,id LIMIT 1 FOR UPDATE;
  IF v_next IS NOT NULL THEN
    IF NOT (v_size=ANY(s.available_batch_sizes)) THEN RAISE EXCEPTION 'A queued plate needs its original G-code file.'; END IF;
  ELSE
    -- Lock selected orders as well as the global gate: refunds cannot race assignment.
    SELECT array_agg(id ORDER BY paid_at,id) INTO v_ids FROM (
      SELECT id,paid_at FROM orders WHERE status='PAID' ORDER BY paid_at,id
      LIMIT (SELECT max(n) FROM unnest(s.available_batch_sizes) n) FOR UPDATE
    ) picked;
    SELECT max(n) INTO v_size FROM unnest(s.available_batch_sizes) n WHERE n<=COALESCE(cardinality(v_ids),0);
    IF v_size IS NOT NULL THEN
      v_next:=gen_random_uuid();
      INSERT INTO print_batches(id,size) VALUES(v_next,v_size);
      UPDATE orders SET status='BATCHED',batch_id=v_next,updated_at=now() WHERE id=ANY(v_ids[1:v_size]);
      INSERT INTO order_events(order_id,kind,details) SELECT unnest(v_ids[1:v_size]),'BATCHED',jsonb_build_object('batch',v_next);
    END IF;
  END IF;
  UPDATE print_batches SET start_authorized_until=now()+interval '60 seconds',updated_at=now() WHERE id=v_next;
  UPDATE shop_settings SET current_batch_id=v_next WHERE id=1;
  RETURN QUERY SELECT v_next,COALESCE(v_size,0);
END;
$$;
