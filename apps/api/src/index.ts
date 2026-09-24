import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { decodeCardanoTransaction } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { query } from "./db";
import { clean, constantEqual, digest, secretMatches, token } from "./security";

type Env = Record<string, string>;
type Network = "cardano:mainnet" | "cardano:preprod";
type Order = { id: string; access_hash: string; status: string; network: Network; price_lovelace: string; tx_hash: string | null; batch_id: string | null; created_at: string };
const networkFor = (env: Env): Network | null => env.CARDANO_NETWORK === "cardano:mainnet" || env.CARDANO_NETWORK === "cardano:preprod" ? env.CARDANO_NETWORK : null;
const sellerIsValid = (env: Env, network: Network) => network === "cardano:mainnet" ? /^addr1[0-9a-z]{40,}$/.test(env.SELLER_ADDRESS || "") : /^addr_test1[0-9a-z]{40,}$/.test(env.SELLER_ADDRESS || "");
const app = new Hono<{ Bindings: Env }>();
const config = (c: { env: Env }) => ({ ...(typeof process !== "undefined" ? process.env : {}), ...c.env } as Env);
const error = (message: string, status = 400) => new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const safeOrder = (o: Order) => ({ id: o.id, status: o.status, priceLovelace: o.price_lovelace, network: o.network, transaction: o.tx_hash, batchId: o.batch_id, createdAt: o.created_at });
async function orderFor(env: Env, id: string, secret: string | undefined) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !secret) return null;
  const rows = await query<Order>(env, "SELECT id, access_hash, status, network, price_lovelace, tx_hash, batch_id, created_at FROM orders WHERE id=$1", [id]);
  return rows[0] && constantEqual(await digest(secret), rows[0].access_hash) ? rows[0] : null;
}
const apiAuth = async (auth: string | undefined, secret: string | undefined) => secretMatches(auth?.replace(/^Bearer /i, ""), secret);

app.use("/api/*", async (c, next) => {
  const env = config(c);
  const origin = env.FRONTEND_ORIGIN || "http://localhost:5173";
  return cors({ origin, allowHeaders: ["content-type", "authorization", "x-order-secret", "payment-signature"], exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"], allowMethods: ["GET", "POST", "OPTIONS"] })(c, next);
});
app.use("/api/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

app.get("/api/health", c => { const env = config(c), network = networkFor(env); return c.json({ ok: !!network && !!env.FACILITATOR_URL && sellerIsValid(env, network || "cardano:mainnet"), network }, network && env.FACILITATOR_URL && sellerIsValid(env, network) ? 200 : 503); });
app.get("/api/catalog", async c => {
  const env = config(c), network = networkFor(env);
  if (!network || !env.FACILITATOR_URL || !sellerIsValid(env, network)) return error("Payment configuration incomplete", 503);
  const settings = await query<{ paused: boolean; gateway_last_seen: string | null; gateway_armed: boolean; gateway_active: boolean; gateway_operational: boolean; printer_ready: boolean; printer_state: string | null; current_status: string | null }>(env,
    "SELECT s.paused,s.gateway_last_seen,s.gateway_armed,s.gateway_active,s.gateway_operational,s.printer_ready,s.printer_state,b.status AS current_status FROM shop_settings s LEFT JOIN print_batches b ON b.id=s.current_batch_id WHERE s.id=1");
  const paid = await query<{ count: string }>(env, "SELECT count(*)::text AS count FROM orders WHERE status IN ('PAID','BATCHED','PRINTING')");
  const s = settings[0];
  const fresh = !!s?.gateway_last_seen && Date.now() - new Date(s.gateway_last_seen).getTime() < 45_000;
  const orphaned = !s?.gateway_active && ["DISPATCHING","PRINTING"].includes(s?.current_status || "");
  const availability = s?.paused ? "operator_paused" : !fresh ? "gateway_offline" : orphaned ? "batch_needs_review" : !s.gateway_operational ? "printer_not_ready" : !s.gateway_armed && !s.gateway_active ? "gateway_not_armed" : "available";
  return c.json({ product: { id: "proof-token", name: "Proof of Print", priceLovelace: env.PRICE_LOVELACE || "5000000", maxBatch: 4 }, paused: !!s?.paused, availability, printerReady: !!s?.printer_ready, printerState: s?.printer_state, network, payTo: env.SELLER_ADDRESS, pending: Number(paid[0]?.count || 0) });
});
app.post("/api/orders", async c => {
  const env = config(c), network = networkFor(env), b = await c.req.json().catch(() => null);
  if (!network || !env.FACILITATOR_URL || !sellerIsValid(env, network)) return error("Payment configuration incomplete", 503);
  const name = clean(b?.name, 100), email = clean(b?.email, 160), line1 = clean(b?.addressLine1, 180),
    line2 = clean(b?.addressLine2, 180), postal = clean(b?.postalCode, 16), city = clean(b?.city, 100);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !line1 || !/^[0-9]{5}$/.test(postal) || !city || b?.country !== "DE" || b?.productId !== "proof-token") return error("Enter a German delivery address and valid email");
  const id = crypto.randomUUID(), access = token(), price = env.PRICE_LOVELACE || "5000000";
  if (!/^\d+$/.test(price) || BigInt(price) < 1_000_000n) return error("Price configuration is invalid", 503);
  const rows = await query<{ id: string }>(env, `INSERT INTO orders (id,access_hash,customer_name,email,address_line1,address_line2,postal_code,city,country,price_lovelace,network)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,'DE',$9,$10 WHERE (SELECT NOT paused FROM shop_settings WHERE id=1)
    RETURNING id`, [id, await digest(access), name, email, line1, line2, postal, city, price, network]);
  if (!rows.length) return error("The printer gateway is unavailable or the shop is paused", 503);
  return c.json({ id, access, status: "AWAITING_PAYMENT", priceLovelace: price, network }, 201);
});
app.get("/api/orders/:id", async c => {
  const o = await orderFor(config(c), c.req.param("id"), c.req.header("x-order-secret"));
  return o ? c.json(safeOrder(o)) : error("Order not found", 404);
});

app.post("/api/orders/:id/pay", async c => {
  const env = config(c), id = c.req.param("id"), o = await orderFor(env, id, c.req.header("x-order-secret"));
  if (!o) return error("Order not found", 404);
  if (o.status !== "AWAITING_PAYMENT") return c.json(safeOrder(o));
  const network = networkFor(env);
  if (!network || network !== o.network || !env.FACILITATOR_URL || !sellerIsValid(env, network)) return error("Payment configuration changed; contact the operator", 503);
  const signature = c.req.header("payment-signature");
  let signedHash: string | undefined;
  if (signature) {
    if (signature.length > 64_000) return error("Payment payload too large", 413);
    try {
      const payload = decodePaymentSignatureHeader(signature);
      if (payload.accepted.network !== network || payload.accepted.payTo !== env.SELLER_ADDRESS || payload.accepted.amount !== o.price_lovelace || payload.accepted.asset !== "lovelace") return error("Signed payment does not match the order", 400);
      signedHash = decodeCardanoTransaction(String(payload.payload.transaction)).txHash;
      if (!/^[0-9a-f]{64}$/i.test(signedHash)) return error("Invalid signed transaction", 400);
    } catch { return error("Invalid payment signature", 400); }
    // Reserve exactly one signed transaction for this order before the facilitator can broadcast.
    await query(env, `INSERT INTO payment_attempts(id,order_id,tx_hash,signed_payload) VALUES($1,$2,$3,$4)
      ON CONFLICT DO NOTHING`, [crypto.randomUUID(), id, signedHash, signature]);
    const attempts = await query<{ tx_hash: string }>(env, "SELECT tx_hash FROM payment_attempts WHERE order_id=$1", [id]);
    if (attempts.length !== 1 || attempts[0].tx_hash !== signedHash) return error("Another signed payment is already attached to this order; reconcile it first", 409);
  }
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL })).register(network, new ExactCardanoScheme());
  const middleware = paymentMiddleware({ [`POST ${c.req.path}`]: {
    accepts: { scheme: "exact", network, price: { asset: "lovelace", amount: o.price_lovelace }, payTo: env.SELLER_ADDRESS },
    description: `One Proof of Print, order ${id}`,
  } }, server);
  // The handler prepares a response; x402 buffers it and settles before exposing it.
  const immediate = await middleware(c, async () => { c.res = c.json({ id, status: "PAID" }); });
  if (immediate instanceof Response) c.res = immediate;
  const receiptHeader = c.res.headers.get("PAYMENT-RESPONSE");
  if (!c.res.ok || !receiptHeader) return c.res;
  const receipt = decodePaymentResponseHeader(receiptHeader);
  if (!receipt.success || receipt.network !== network || !/^[0-9a-f]{64}$/i.test(receipt.transaction)
      || !signedHash || receipt.transaction.toLowerCase() !== signedHash.toLowerCase()) return error("Invalid settlement receipt", 502);
  try {
    const rows = await query<{ id: string }>(env, `WITH paid AS (
      UPDATE orders SET status='PAID', tx_hash=$2, paid_at=now(), updated_at=now()
      WHERE id=$1 AND status='AWAITING_PAYMENT' RETURNING id
    ), attempt AS (UPDATE payment_attempts SET status='SETTLED' WHERE order_id=$1 AND tx_hash=$2 RETURNING id), event AS (INSERT INTO order_events(order_id,kind,details) SELECT id,'PAID',jsonb_build_object('transaction',$2::text) FROM paid RETURNING id)
    SELECT id FROM paid`, [id, receipt.transaction]);
    if (!rows.length) {
      const current = await orderFor(env, id, c.req.header("x-order-secret"));
      if (current?.tx_hash !== receipt.transaction) return error("Order already settled with another payment", 409);
    }
    c.header("PAYMENT-RESPONSE", receiptHeader);
    return c.json({ id, status: "PAID", transaction: receipt.transaction });
  } catch (e) {
    console.error("settled order persistence failed", id, e);
    c.header("PAYMENT-RESPONSE", receiptHeader);
    return error("Payment settled; retry the same signed transaction to reconcile", 503);
  }
});

app.get("/api/admin/orders", async c => {
  const env = config(c);
  if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const [rows, batches, attempts, settings] = await Promise.all([
    query(env, `SELECT o.id,o.customer_name,o.email,o.address_line1,o.address_line2,o.postal_code,o.city,o.country,o.status,o.network,o.price_lovelace,o.tx_hash,o.batch_id,o.created_at,
    b.status AS batch_status FROM orders o LEFT JOIN print_batches b ON b.id=o.batch_id
    WHERE o.batch_id=(SELECT current_batch_id FROM shop_settings WHERE id=1)
       OR o.id IN (SELECT id FROM orders ORDER BY created_at DESC LIMIT 200)
    ORDER BY o.created_at DESC`),
    query(env, "SELECT id,status,size,printer_filename,created_at,confirmed_at FROM print_batches ORDER BY created_at DESC LIMIT 100"),
    query(env, "SELECT order_id,tx_hash,status,created_at FROM payment_attempts ORDER BY created_at DESC LIMIT 200"),
    query<{ paused: boolean; current_batch_id: string | null; gateway_armed: boolean; gateway_active: boolean; gateway_last_seen: string | null }>(env, "SELECT paused,current_batch_id,gateway_armed,gateway_active,gateway_last_seen FROM shop_settings WHERE id=1"),
  ]);
  const current = settings[0]?.current_batch_id
    ? await query(env, "SELECT id,status,size,printer_filename,created_at,confirmed_at FROM print_batches WHERE id=$1", [settings[0].current_batch_id])
    : [];
  return c.json({ orders: rows, batches, attempts, paused: settings[0]?.paused, currentBatchId: settings[0]?.current_batch_id, currentBatch: current[0] || null,
    gateway: { armed: !!settings[0]?.gateway_armed, active: !!settings[0]?.gateway_active, lastSeen: settings[0]?.gateway_last_seen || null } });
});
app.get("/api/admin/shipping", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const cursor = c.req.query("after");
  const match = cursor?.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (cursor && (!match || !Number.isFinite(Date.parse(match[1])))) return error("Invalid cursor");
  const [afterDate, afterId] = match ? [match[1],match[2]] : [null,null];
  const rows = await query<{ id: string; customer_name: string; email: string; address_line1: string; address_line2: string; postal_code: string; city: string; country: string; batch_id: string; created_at: string; cursor_at: string }>(env,
    `SELECT id,customer_name,email,address_line1,address_line2,postal_code,city,country,batch_id,created_at,
       to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
     FROM orders WHERE status='PRINTED' AND ($1::timestamptz IS NULL OR (created_at,id)>($1::timestamptz,$2::uuid))
     ORDER BY created_at,id LIMIT 101`, [afterDate, afterId]);
  const page = rows.slice(0,100), last = page.at(-1);
  return c.json({ orders: page.map(({ cursor_at, ...order }) => order), nextCursor: rows.length > 100 && last ? `${last.cursor_at}_${last.id}` : null });
});
app.post("/api/admin/pause", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const b = await c.req.json().catch(() => null); if (typeof b?.paused !== "boolean") return error("Invalid setting");
  await query(env, "UPDATE shop_settings SET paused=$1 WHERE id=1", [b.paused]); return c.json({ paused: b.paused });
});
app.post("/api/admin/batches", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const max = Math.min(4, Math.max(1, Number(env.BATCH_SIZE) || 4));
  const rows = await query<{ batch_id: string | null; batch_size: number }>(env, "SELECT batch_id,batch_size FROM advance_print_queue(NULL::uuid,$1)", [max]);
  if (!rows.length) return error("Another batch is awaiting print or operator confirmation", 409);
  if (!rows[0].batch_id) return error("No paid orders to batch", 409);
  return c.json({ batch: { id: rows[0].batch_id, size: rows[0].batch_size }, dispatched: false }, 201);
});
app.post("/api/admin/batches/:id/confirm", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const body = await c.req.json().catch(() => null);
  if (body?.inspected !== true || !/^[0-9a-f-]{36}$/i.test(c.req.param("id"))) return error("Confirm that the physical plate and order outcomes were inspected");
  const max = Math.min(4, Math.max(1, Number(env.BATCH_SIZE) || 4));
  try {
    const rows = await query<{ batch_id: string | null; batch_size: number }>(env, "SELECT batch_id,batch_size FROM advance_print_queue($1,$2)", [c.req.param("id"),max]);
    return c.json({ confirmed: c.req.param("id"), nextBatch: rows[0]?.batch_id ? { id: rows[0].batch_id, size: rows[0].batch_size } : null });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "P0001") return error(cause.message, 409);
    throw cause;
  }
});
app.post("/api/admin/batches/:id/review", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const body = await c.req.json().catch(() => null), id = c.req.param("id");
  if (body?.confirmedStopped !== true || !/^[0-9a-f-]{36}$/i.test(id)) return error("Confirm that the old printer job is stopped and the physical plate was inspected");
  const rows = await query<{ id: string }>(env, `WITH reviewed AS (
    UPDATE print_batches b SET status='NEEDS_REVIEW',updated_at=now()
    FROM shop_settings s
    WHERE b.id=$1 AND s.id=1 AND s.current_batch_id=b.id
      AND b.status IN ('DISPATCHING','PRINTING')
      AND (s.gateway_active=false OR s.gateway_last_seen < now()-interval '45 seconds')
    RETURNING b.id
  ), affected AS (
    UPDATE orders SET status='NEEDS_REVIEW',updated_at=now()
    WHERE batch_id IN (SELECT id FROM reviewed) AND status IN ('BATCHED','PRINTING') RETURNING id
  ), events AS (
    INSERT INTO order_events(order_id,kind,details)
    SELECT id,'NEEDS_REVIEW',jsonb_build_object('batch',$1::uuid) FROM affected RETURNING id
  ) SELECT id FROM reviewed`, [id]);
  return rows.length ? c.json({ ok: true }) : error("Stop the gateway and inspect the job before reviewing an unfinished batch", 409);
});
app.post("/api/admin/gateway/rearm", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const body = await c.req.json().catch(() => null);
  if (body?.confirmedIdle !== true) return error("Confirm the U1 is idle and previous jobs have been reviewed");
  const rows = await query<{ gateway_rearm_generation: string }>(env, `UPDATE shop_settings s SET gateway_rearm_generation=gateway_rearm_generation+1
    WHERE s.id=1 AND NOT EXISTS (SELECT 1 FROM print_batches b
      WHERE b.id=s.current_batch_id AND b.status IN ('DISPATCHING','PRINTING'))
    RETURNING gateway_rearm_generation::text`, []);
  return rows.length ? c.json({ queued: true }) : error("Resolve the active print batch before rearming", 409);
});
app.post("/api/admin/orders/:id/status", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const b = await c.req.json().catch(() => null);
  if (!(["SHIPPED", "REFUNDED", "NEEDS_REVIEW"] as unknown[]).includes(b?.status)) return error("Invalid status");
  const rows = await query(env, `WITH moved AS (
    UPDATE orders SET status=$2,updated_at=now() WHERE id=$1 AND
      (status='PRINTED' OR (status='NEEDS_REVIEW' AND $2 IN ('SHIPPED','REFUNDED')))
    RETURNING id
  ), recorded AS (
    INSERT INTO order_events(order_id,kind) SELECT id,$2 FROM moved RETURNING order_id
  ) SELECT order_id AS id FROM recorded`, [c.req.param("id"), b.status]);
  return rows.length ? c.json({ ok: true }) : error("Invalid transition", 409);
});

app.post("/api/admin/orders/:id/requeue", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const b = await c.req.json().catch(() => null);
  if (b?.confirmedPhysicalReview !== true) return error("Confirm the printer and previous batch were inspected before requeueing");
  // Never restart an old batch ID. The gateway may have already started it and
  // journals that ID permanently. A reviewed paid order returns to the pool
  // for a *new* supervised batch while the old batch remains for audit.
  const rows = await query<{ id: string }>(env, `WITH moved AS (
    UPDATE orders AS o SET status='PAID',batch_id=NULL,updated_at=now()
    FROM print_batches AS b
    WHERE o.id=$1 AND o.status='NEEDS_REVIEW' AND o.batch_id=b.id
      AND b.status IN ('NEEDS_REVIEW','PRINTED') AND o.tx_hash IS NOT NULL
    RETURNING o.id,b.id AS previous_batch
  ), recorded AS (
    INSERT INTO order_events(order_id,kind,details)
    SELECT id,'REPRINT_QUEUED',jsonb_build_object('previousBatch',previous_batch) FROM moved
    RETURNING order_id
  ) SELECT order_id AS id FROM recorded`, [c.req.param("id")]);
  return rows.length ? c.json({ ok: true }) : error("Order is not eligible for reprint; review its batch and payment first", 409);
});

app.post("/api/gateway/heartbeat", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.GATEWAY_TOKEN)) return error("Unauthorized", 401);
  const b = await c.req.json().catch(() => null);
  if (typeof b?.armed !== "boolean" || typeof b?.active !== "boolean" || typeof b?.operational !== "boolean" || typeof b?.printerReady !== "boolean" || !["standby","complete","printing","paused","error","cancelled","unknown"].includes(b?.printerState)) return error("Invalid heartbeat");
  await query(env, "UPDATE shop_settings SET gateway_last_seen=now(),gateway_armed=$1,gateway_active=$2,gateway_operational=$3,printer_ready=$4,printer_state=$5 WHERE id=1", [b.armed,b.active,b.operational,b.printerReady,b.printerState]);
  return c.json({ ok: true });
});
app.get("/api/gateway/next", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.GATEWAY_TOKEN)) return error("Unauthorized", 401);
  const rows = await query<{ gateway_rearm_generation: string; id: string | null; size: number | null }>(env,
    "SELECT s.gateway_rearm_generation::text,b.id,b.size FROM shop_settings s LEFT JOIN print_batches b ON s.current_batch_id=b.id AND b.status='QUEUED' AND b.confirmed_at IS NULL WHERE s.id=1");
  return c.json({ batch: rows[0]?.id ? { id: rows[0].id, size: rows[0].size } : null, rearmGeneration: rows[0]?.gateway_rearm_generation || "0" });
});
app.get("/api/gateway/batches/:id", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.GATEWAY_TOKEN)) return error("Unauthorized", 401);
  const rows = await query<{ id: string; status: string; size: number; orders: string }>(env,
    `SELECT b.id,b.status,b.size,count(o.id)::text AS orders FROM print_batches b JOIN orders o ON o.batch_id=b.id
     WHERE b.id=$1 AND o.status IN ('BATCHED','PRINTING','PRINTED') GROUP BY b.id`, [c.req.param("id")]);
  const b = rows[0]; return b && Number(b.orders) === b.size ? c.json({ id: b.id, status: b.status, size: b.size }) : error("Batch not ready", 404);
});
app.post("/api/gateway/batches/:id/status", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.GATEWAY_TOKEN)) return error("Unauthorized", 401);
  const b = await c.req.json().catch(() => null), id = c.req.param("id");
  const to = b?.status as string;
  const from = to === "DISPATCHING" ? "QUEUED" : to === "PRINTING" ? "DISPATCHING" : to === "PRINTED" ? "PRINTING" : to === "NEEDS_REVIEW" ? "DISPATCHING" : "INVALID";
  if (from === "INVALID") return error("Invalid state");
  const rows = await query<{ id: string }>(env, `WITH changed AS (
    UPDATE print_batches SET status=$2, printer_filename=COALESCE($4,printer_filename), updated_at=now()
    WHERE id=$1 AND (status=$3 OR ($2='NEEDS_REVIEW' AND status='PRINTING')) RETURNING id
  ), updated AS (
    UPDATE orders SET status=CASE WHEN $2='DISPATCHING' THEN 'BATCHED' ELSE $2 END,updated_at=now()
    WHERE batch_id IN (SELECT id FROM changed) AND status IN ('BATCHED','PRINTING') RETURNING id
  ) SELECT id FROM changed`, [id, to, from, clean(b?.filename, 200) || null]);
  if (!rows.length) return error("Batch state conflict", 409);
  return c.json({ ok: true });
});

app.onError((e,c) => { console.error(e); return c.json({ error: "Service unavailable" }, 503); });
export default app;
