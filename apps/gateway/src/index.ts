import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const env = process.env;
const API = (env.API_URL || "http://api:8787").replace(/\/$/, "");
const ROOT = env.STATE_DIR || "/data";
const PORT = Number(env.PORT || 8790);
const MOCK = env.MOCK_PRINTER === "true";
const PRINTS = env.PRINTS_DIR || "/prints";
let armed = env.ARM_ONCE === "true";
let active = false;
const app = new Hono();

function authorized(header: string | undefined) {
  const provided = Buffer.from((header || "").replace(/^Bearer /i, ""));
  const expected = Buffer.from(env.GATEWAY_TOKEN || "");
  return expected.length >= 32 && provided.length === expected.length && timingSafeEqual(provided, expected);
}
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${env.GATEWAY_TOKEN}`, "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`API ${path}: ${response.status}`);
  return response.json();
}
async function report(id: string, status: string, filename?: string) {
  await api(`/api/gateway/batches/${id}/status`, { method: "POST", body: JSON.stringify({ status, filename }) });
}
function moonHeaders(init?: HeadersInit) { const headers = new Headers(init); if (env.MOONRAKER_API_KEY) headers.set("X-Api-Key", env.MOONRAKER_API_KEY); return headers; }
async function moon(path: string, init: RequestInit = {}) {
  if (!env.MOONRAKER_URL) throw new Error("MOONRAKER_URL missing");
  const response = await fetch(env.MOONRAKER_URL.replace(/\/$/, "") + path, { ...init, headers: moonHeaders(init.headers), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Moonraker ${path}: ${response.status}`);
  return response.json() as Promise<any>;
}
async function journal(id: string, stage: string) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, `${id}.json`), JSON.stringify({ id, stage, at: new Date().toISOString() }));
}
async function run(id: string) {
  if (active || !armed || existsSync(join(ROOT, `${id}.json`))) return;
  active = true; armed = false;
  try {
    const batch = await api(`/api/gateway/batches/${id}`) as { id: string; size: number; status: string };
    if (batch.status !== "QUEUED" || batch.size < 1 || batch.size > 4) throw new Error("Invalid paid batch");
    const filename = `proof-token-${batch.size}.gcode`;
    const file = join(PRINTS, filename);
    if (!MOCK && !existsSync(file)) throw new Error(`Pre-sliced U1 file missing: ${file}`);
    if (!MOCK) {
      const status = await moon("/printer/objects/query?print_stats");
      if (status?.result?.status?.print_stats?.state !== "standby" && status?.result?.status?.print_stats?.state !== "complete") throw new Error("Printer is not idle");
    }
    await journal(id, "reserved");
    await report(id, "DISPATCHING");
    if (!MOCK) {
      const form = new FormData();
      form.set("file", new Blob([await readFile(file)], { type: "application/octet-stream" }), `${id}.gcode`);
      await moon("/server/files/upload", { method: "POST", body: form });
      await journal(id, "uploaded");
      // An interrupted response here is ambiguous. The journal prevents an automatic second start.
      await moon(`/printer/print/start?filename=${encodeURIComponent(`${id}.gcode`)}`, { method: "POST" });
    }
    await journal(id, "started");
    await report(id, "PRINTING", filename);
    if (MOCK) await new Promise(resolve => setTimeout(resolve, 12_000));
    else {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 15_000));
        const status = await moon("/printer/objects/query?print_stats");
        const stats = status?.result?.status?.print_stats;
        if (stats?.filename && stats.filename !== `${id}.gcode`) throw new Error("Printer is reporting another file");
        if (stats?.state === "complete") break;
        if (["error", "cancelled"].includes(stats?.state)) throw new Error(`Print ${stats.state}`);
      }
    }
    await journal(id, "printed");
    await report(id, "PRINTED", filename);
    console.log(`Batch ${id}: print completed`);
  } catch (cause) {
    console.error(`Batch ${id} needs review`, cause);
    await journal(id, "needs-review").catch(() => {});
    await report(id, "NEEDS_REVIEW").catch(() => {});
  } finally { active = false; }
}

app.post("/jobs/:id/accept", c => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "Invalid job ID" }, 400);
  if (!armed) return c.json({ accepted: false, reason: "Operator has not armed the printer" }, 409);
  if (active || existsSync(join(ROOT, `${id}.json`))) return c.json({ accepted: true, alreadySeen: true }, 202);
  void run(id);
  return c.json({ accepted: true }, 202);
});
app.get("/health", c => c.json({ ok: true, armed, active, mock: MOCK }));
serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" });
console.log(`Gateway on ${PORT}, mock=${MOCK}, armed=${armed}`);

// The cloud API can push immediately. Polling recovers jobs after an offline gateway.
setInterval(async () => {
  if (!armed || active) return;
  try {
    const response = await api("/api/gateway/next") as { batch?: { id: string } };
    if (response.batch) await run(response.batch.id);
  } catch (e) { console.error("Queue poll failed", e); }
}, 15_000);
