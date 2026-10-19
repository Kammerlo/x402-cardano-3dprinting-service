import { query } from "./db";
import type { Env } from "./domain";

// The order limit is set in the admin dashboard; 0 means unlimited. Guards
// read it inside their own SQL statement, so a change applies immediately.
export const ORDER_LIMIT_CEILING = 1_000_000;
export const CAP_SQL = "(SELECT max_orders FROM shop_settings WHERE id=1)";

// Only settled, non-refunded orders count, so abandoned checkouts cannot
// exhaust the cap. Every path that marks an order PAID sets tx_hash.
export const SOLD_ORDERS_SQL =
  "(SELECT count(*) FROM orders WHERE tx_hash IS NOT NULL AND status<>'REFUNDED')";

// True while new orders and payments may still be accepted.
export const CAP_OPEN_SQL = `(${CAP_SQL} = 0 OR ${SOLD_ORDERS_SQL} < ${CAP_SQL})`;

export async function capStatus(env: Env) {
  const [row] = await query<{ max_orders: number; sold: number }>(
    env,
    `SELECT ${CAP_SQL} AS max_orders, ${SOLD_ORDERS_SQL}::int AS sold`,
  );
  const maxOrders = row?.max_orders ?? 0,
    sold = row?.sold ?? 0;
  return { maxOrders, sold, soldOut: maxOrders > 0 && sold >= maxOrders };
}
