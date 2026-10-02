import { query } from "./db";
import type { Env } from "./domain";

export type OrderCap =
  | { kind: "unlimited" }
  | { kind: "cap"; n: number }
  | { kind: "invalid" };

// MAX_ORDERS unset, empty or 0 means unlimited. Any other non-integer fails closed.
export function orderCapFor(env: Env): OrderCap {
  const raw = (env.MAX_ORDERS ?? "").trim();
  if (!raw || /^0+$/.test(raw)) return { kind: "unlimited" };
  if (!/^\d{1,7}$/.test(raw)) return { kind: "invalid" };
  return { kind: "cap", n: Number(raw) };
}

// Only settled, non-refunded orders count, so abandoned checkouts cannot
// exhaust the cap. Every path that marks an order PAID sets tx_hash.
export const SOLD_ORDERS_SQL =
  "(SELECT count(*) FROM orders WHERE tx_hash IS NOT NULL AND status<>'REFUNDED')";

// SQL parameters for a guard of the form
// `NOT $closed::boolean AND ($limit::int = 0 OR ${SOLD_ORDERS_SQL} < $limit::int)`.
export const capGuardParams = (cap: OrderCap) => ({
  limit: cap.kind === "cap" ? cap.n : 0,
  closed: cap.kind === "invalid",
});

export async function soldOrders(env: Env) {
  const [row] = await query<{ sold: number }>(
    env,
    `SELECT ${SOLD_ORDERS_SQL}::int AS sold`,
  );
  return row?.sold ?? 0;
}
