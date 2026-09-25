import type { Hono, Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "./domain";
import { error } from "./domain";
import { query } from "./db";
import { constantEqual, digest, secretMatches, token } from "./security";

type App = Hono<{ Bindings: Env }>;
type Ctx = Context<{ Bindings: Env }>;
const environment = (c: Ctx): Env =>
  ({ ...(typeof process !== "undefined" ? process.env : {}), ...c.env }) as Env;
const local = (env: Env) =>
  env.ADMIN_ALLOW_INSECURE_LOCALHOST === "true" &&
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.FRONTEND_ORIGIN || "");
const cookieName = (env: Env) =>
  local(env) ? "print_admin_dev" : "__Host-print-admin";
function cookie(c: Ctx, env: Env, value: string, maxAge: number) {
  setCookie(c, cookieName(env), value, {
    httpOnly: true,
    secure: !local(env),
    sameSite: "Strict",
    path: "/",
    maxAge,
  });
}
const configured = (env: Env) =>
  !!env.FRONTEND_ORIGIN &&
  (/^https:\/\/[^/]+$/.test(env.FRONTEND_ORIGIN) || local(env)) &&
  /^[a-f0-9]{64}$/i.test(env.ADMIN_TOKEN || "") &&
  env.ADMIN_TOKEN !== env.GATEWAY_TOKEN;
const trustedOrigin = (c: Ctx, env: Env) =>
  c.req.header("origin") === (env.FRONTEND_ORIGIN || "http://localhost:5173");
async function session(c: Ctx, env: Env) {
  const value = getCookie(c, cookieName(env));
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  return (
    (
      await query<{ session_hash: string; csrf_token: string }>(
        env,
        "SELECT session_hash,csrf_token FROM admin_sessions WHERE session_hash=$1 AND credential_hash=$2 AND expires_at>now()",
        [await digest(value), await digest(env.ADMIN_TOKEN)],
      )
    )[0] || null
  );
}

export function installAdminAuth(app: App) {
  app.use("/api/admin/*", async (c, next) => {
    const env = environment(c);
    if (!configured(env))
      return error("Admin access is not configured securely", 503);
    if (c.req.path === "/api/admin/auth/login" && c.req.method === "POST")
      return next();
    const current = await session(c, env);
    // Explicit opt-in for non-browser automation; disabled by default.
    const bearer =
      env.ADMIN_ALLOW_BEARER === "true" &&
      (await secretMatches(
        c.req.header("authorization")?.replace(/^Bearer /i, ""),
        env.ADMIN_TOKEN,
      ));
    if (!current && !bearer)
      return error("Sign in to the admin dashboard", 401);
    if (
      c.req.method !== "GET" &&
      !bearer &&
      (!trustedOrigin(c, env) ||
        !constantEqual(c.req.header("x-csrf-token") || "", current!.csrf_token))
    )
      return error("Invalid request origin or CSRF token", 403);
    let audit: { id: string } | undefined;
    if (c.req.method !== "GET") {
      [audit] = await query<{ id: string }>(
        env,
        "INSERT INTO admin_audit(action,session_tag) VALUES($1,$2) RETURNING id::text",
        [
          c.req.path.slice(0, 200),
          current?.session_hash.slice(0, 12) || "automation",
        ],
      );
    }
    await next();
    if (audit)
      await query(
        env,
        "UPDATE admin_audit SET response_status=$2 WHERE id=$1",
        [audit.id, c.res.status],
      );
  });
  app.post("/api/admin/auth/login", async (c) => {
    const env = environment(c);
    if (
      !trustedOrigin(c, env) ||
      !c.req.header("content-type")?.startsWith("application/json")
    )
      return error("Invalid login origin", 403);
    const bucket = Math.floor(Date.now() / 60_000);
    const [limit] = await query<{ attempts: number }>(
      env,
      `INSERT INTO admin_login_limits(bucket,attempts) VALUES($1,1)
      ON CONFLICT(bucket) DO UPDATE SET attempts=admin_login_limits.attempts+1 RETURNING attempts`,
      [bucket],
    );
    if (limit.attempts > 20) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many login attempts; wait a minute" }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (
      !(await secretMatches(
        typeof body?.token === "string" ? body.token : undefined,
        env.ADMIN_TOKEN,
      ))
    )
      return error("Invalid credentials", 401);
    await query(env, "DELETE FROM admin_login_limits WHERE bucket<$1", [
      bucket - 10,
    ]);
    await query(
      env,
      "DELETE FROM admin_sessions WHERE expires_at<=now() OR credential_hash<>$1",
      [await digest(env.ADMIN_TOKEN)],
    );
    const value = token(),
      csrf = token();
    await query(
      env,
      "INSERT INTO admin_sessions(session_hash,credential_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
      [await digest(value), await digest(env.ADMIN_TOKEN), csrf],
    );
    cookie(c, env, value, 8 * 3600);
    return c.json({ csrf });
  });
  app.get("/api/admin/auth/session", async (c) => {
    const current = await session(c, environment(c));
    return current
      ? c.json({ csrf: current.csrf_token })
      : error("Session expired", 401);
  });
  app.post("/api/admin/auth/logout", async (c) => {
    const env = environment(c),
      current = await session(c, env);
    if (current)
      await query(env, "DELETE FROM admin_sessions WHERE session_hash=$1", [
        current.session_hash,
      ]);
    cookie(c, env, "", 0);
    return c.json({ ok: true });
  });
  app.post("/api/admin/auth/revoke-all", async (c) => {
    await query(environment(c), "DELETE FROM admin_sessions");
    cookie(c, environment(c), "", 0);
    return c.json({ ok: true });
  });
}
