import type { Context } from "hono";
import { query } from "./db";
import type { Env } from "./domain";

export const DEFAULT_RETENTION_DAYS = 90;

export function retentionDaysFor(env: Env) {
  const raw = (env.PII_RETENTION_DAYS ?? "").trim();
  const days = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  return days >= 1 && days <= 3650 ? days : DEFAULT_RETENTION_DAYS;
}

// Unpaid orders accept new payments for 12 hours less than the retention
// period, so a reservation can never race their erasure.
export const paymentWindowHours = (env: Env) => retentionDaysFor(env) * 24 - 12;

// Blank delivery data once it is no longer needed. Payment evidence (tx_hash,
// payment_attempts, order_events, amounts) is never touched. Unpaid orders are
// erased only when no signed transaction was ever reserved for them.
export async function erasePersonalData(env: Env) {
  const rows = await query<{ id: string }>(
    env,
    `UPDATE orders SET customer_name='',email='',address_line1='',address_line2='',postal_code='',city='',
       personal_data_erased_at=now()
     WHERE personal_data_erased_at IS NULL AND (
       (status IN ('SHIPPED','REFUNDED') AND updated_at < now()-make_interval(days => $1::int))
       OR (status='AWAITING_PAYMENT' AND created_at < now()-make_interval(days => $1::int)
           AND NOT EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id=orders.id)))
     RETURNING id`,
    [retentionDaysFor(env)],
  );
  return rows.length;
}

let lastErasure = 0;

// Neither runtime has a scheduler here, so erasure piggybacks on regular
// gateway heartbeats and admin views, at most every 10 minutes per isolate.
export function scheduleErasure(c: Context, env: Env) {
  if (Date.now() - lastErasure < 10 * 60_000) return;
  lastErasure = Date.now();
  const run = erasePersonalData(env).then(
    (n) => { if (n) console.log(`Erased personal data of ${n} expired orders`); },
    (e) => console.error("Personal data erasure failed", e),
  );
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    // Node has no execution context; the promise keeps running on its own.
  }
}
