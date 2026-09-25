import type { Pool as PgPool } from "pg";
import { neon } from "@neondatabase/serverless";

let pool: PgPool | undefined;
export type Row = Record<string, unknown>;
export async function query<T extends Row = Row>(
  env: Record<string, string>,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (env.LOCAL_DATABASE_URL) {
    if (!pool) {
      const { Pool } = await import("pg");
      pool = new Pool({
        connectionString: env.LOCAL_DATABASE_URL,
        max: 10,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 15_000,
      });
      pool.on("error", (e) =>
        console.error("Idle database connection failed", e.message),
      );
    }
    // Bound queued work during spikes instead of retaining unlimited requests.
    if (pool.waitingCount >= 100)
      throw new Error("Database queue is full; retry shortly");
    return (await pool.query(sql, params)).rows as T[];
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
  const client = neon(env.DATABASE_URL);
  return (await client.query(sql, params)) as T[];
}

export async function closeLocalPool() {
  await pool?.end();
  pool = undefined;
}
