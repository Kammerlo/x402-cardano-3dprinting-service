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
  const settings = await query<{ paused: boolean; gateway_last_seen: string | null; gateway_armed: boolean; printer_ready: boolean }>(env, "SELECT paused, gateway_last_seen, gateway_armed, printer_ready FROM shop_settings WHERE id=1");
  const paid = await query<{ count: string }>(env, "SELECT count(*)::text AS count FROM orders WHERE status IN ('PAID','BATCHED','PRINTING')");
  const s = settings[0];
  const fresh = !!s?.gateway_last_seen && Date.now() - new Date(s.gateway_last_seen).getTime() < 45_000;
  const availability = s?.paused ? "operator_paused" : !fresh ? "gateway_offline" : !s.gateway_armed ? "gateway_not_armed" : !s.printer_ready ? "printer_not_ready" : "available";
  return c.json({ product: { id: "proof-token", name: "Proof of Print", priceLovelace: env.PRICE_LOVELACE || "5000000", maxBatch: 4 }, paused: availability !== "available", availability, printerReady: !!s?.printer_ready, network, payTo: env.SELLER_ADDRESS, pending: Number(paid[0]?.count || 0) });
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
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,'DE',$9,$10 WHERE (SELECT NOT paused AND gateway_armed AND printer_ready AND gateway_last_seen > now() - interval '45 seconds' FROM shop_settings WHERE id=1)
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
  if (signature) {
    if (signature.length > 64_000) return error("Payment payload too large", 413);
    let signedHash: string;
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
  if (!receipt.success || receipt.network !== network || !/^[0-9a-f]{64}$/i.test(receipt.transaction)) return error("Invalid settlement receipt", 502);
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
  const rows = await query(env, `SELECT o.id,o.customer_name,o.email,o.address_line1,o.address_line2,o.postal_code,o.city,o.country,o.status,o.network,o.price_lovelace,o.tx_hash,o.batch_id,o.created_at,
    b.status AS batch_status FROM orders o LEFT JOIN print_batches b ON b.id=o.batch_id ORDER BY o.created_at DESC LIMIT 200`);
  const batches = await query(env, "SELECT id,status,size,printer_filename,created_at FROM print_batches ORDER BY created_at DESC LIMIT 30");
  const attempts = await query(env, "SELECT order_id,tx_hash,status,created_at FROM payment_attempts ORDER BY created_at DESC LIMIT 200");
  const settings = await query(env, "SELECT paused FROM shop_settings WHERE id=1");
  return c.json({ orders: rows, batches, attempts, paused: settings[0]?.paused });
});
app.post("/api/admin/pause", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const b = await c.req.json().catch(() => null); if (typeof b?.paused !== "boolean") return error("Invalid setting");
  await query(env, "UPDATE shop_settings SET paused=$1 WHERE id=1", [b.paused]); return c.json({ paused: b.paused });
});
app.post("/api/admin/batches", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const id = crypto.randomUUID(), max = Math.min(4, Math.max(1, Number(env.BATCH_SIZE) || 4));
  const rows = await query<{ id: string; size: number }>(env, `WITH picked AS (
    SELECT id FROM orders WHERE status='PAID' ORDER BY paid_at LIMIT $1 FOR UPDATE SKIP LOCKED
  ), batch AS (
    INSERT INTO print_batches(id,size) SELECT $2,count(*)::int FROM picked HAVING count(*)>0 RETURNING id,size
  ), moved AS (
    UPDATE orders SET status='BATCHED',batch_id=$2,updated_at=now() WHERE id IN (SELECT id FROM picked)
      AND EXISTS (SELECT 1 FROM batch) RETURNING id
  ) SELECT id,size FROM batch`, [max, id]);
  if (!rows.length) return error("No paid orders to batch", 409);
  // Dispatch is best effort. The gateway also polls /api/gateway/next to recover.
  let dispatched = false;
  if (env.GATEWAY_URL && env.GATEWAY_TOKEN) {
    try {
      const response = await fetch(`${env.GATEWAY_URL.replace(/\/$/, "")}/jobs/${id}/accept`, { method: "POST", headers: {
        "authorization": `Bearer ${env.GATEWAY_TOKEN}`,
        "CF-Access-Client-Id": env.ACCESS_CLIENT_ID || "", "CF-Access-Client-Secret": env.ACCESS_CLIENT_SECRET || ""
      }, signal: AbortSignal.timeout(8_000) });
      dispatched = response.ok;
    } catch { /* durable queue remains */ }
  }
  return c.json({ batch: rows[0], dispatched }, 201);
});
app.post("/api/admin/orders/:id/status", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.ADMIN_TOKEN)) return error("Unauthorized", 401);
  const b = await c.req.json().catch(() => null);
  if (!(["SHIPPED", "REFUNDED", "NEEDS_REVIEW"] as unknown[]).includes(b?.status)) return error("Invalid status");
  const rows = await query(env, "UPDATE orders SET status=$2,updated_at=now() WHERE id=$1 AND status IN ('PRINTED','NEEDS_REVIEW') RETURNING id", [c.req.param("id"), b.status]);
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
  if (typeof b?.armed !== "boolean" || typeof b?.printerReady !== "boolean") return error("Invalid heartbeat");
  await query(env, "UPDATE shop_settings SET gateway_last_seen=now(),gateway_armed=$1,printer_ready=$2 WHERE id=1", [b.armed, b.printerReady]);
  return c.json({ ok: true });
});
app.get("/api/gateway/next", async c => {
  const env = config(c); if (!await apiAuth(c.req.header("authorization"), env.GATEWAY_TOKEN)) return error("Unauthorized", 401);
  const rows = await query(env, "SELECT id,size FROM print_batches WHERE status='QUEUED' ORDER BY created_at LIMIT 1");
  return c.json({ batch: rows[0] || null });
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
