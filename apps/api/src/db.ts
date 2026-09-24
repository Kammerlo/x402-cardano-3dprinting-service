import type { Pool as PgPool } from "pg";
import { neon } from "@neondatabase/serverless";

let pool: PgPool | undefined;
export type Row = Record<string, unknown>;
export async function query<T extends Row = Row>(env: Record<string, string>, sql: string, params: unknown[] = []): Promise<T[]> {
  if (env.LOCAL_DATABASE_URL) {
    if (!pool) {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: env.LOCAL_DATABASE_URL, max: 5 });
    }
    return (await pool.query(sql, params)).rows as T[];
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
  const client = neon(env.DATABASE_URL);
  return (await client.query(sql, params)) as T[];
}
