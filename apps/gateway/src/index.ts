import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const API = (env.API_URL || "http://api:8787").replace(/\/$/, "");
const ROOT = env.STATE_DIR || "/data";
const PRINTS = env.PRINTS_DIR || "/prints";
let armed = env.ARM_ONCE === "true";
let active = false;
let lastReadiness = "";
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
  void heartbeat().catch(e => console.error("Heartbeat failed", e));
  let completed = false;
  let claimed = false;
  try {
    const batch = await api(`/api/gateway/batches/${id}`) as { id: string; size: number; status: string };
    if (batch.status !== "QUEUED" || batch.size < 1 || batch.size > 4) throw new Error("Invalid paid batch");
    // This atomic QUEUED -> DISPATCHING transition is the cloud-side claim.
    // A second gateway observing the same poll cannot start the same plate.
    await report(id, "DISPATCHING");
    claimed = true;
    await journal(id, "reserved");
    const filename = `proof-token-${batch.size}.gcode`;
    const file = join(PRINTS, filename);
    if (!existsSync(file)) throw new Error(`Pre-sliced U1 file missing: ${file}`);
    {
      const status = await moon("/printer/objects/query?print_stats");
      if (status?.result?.status?.print_stats?.state !== "standby" && status?.result?.status?.print_stats?.state !== "complete") throw new Error("Printer is not idle");
    }
    {
      const form = new FormData();
      form.set("file", new Blob([await readFile(file)], { type: "application/octet-stream" }), `${id}.gcode`);
      await moon("/server/files/upload", { method: "POST", body: form });
      await journal(id, "uploaded");
      // An interrupted response here is ambiguous. The journal prevents an automatic second start.
      await moon(`/printer/print/start?filename=${encodeURIComponent(`${id}.gcode`)}`, { method: "POST" });
    }
    await journal(id, "started");
    await report(id, "PRINTING", filename);
    {
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
    completed = true;
    console.log(`Batch ${id}: print completed`);
  } catch (cause) {
    console.error(`Batch ${id} needs review`, cause);
    if (claimed) {
      await journal(id, "needs-review").catch(() => {});
      await report(id, "NEEDS_REVIEW").catch(() => {});
    } else {
      // Another gateway may own this batch. Never mutate its status.
      armed = true;
    }
  } finally {
    // The cloud queue will still wait for operator confirmation. Rearming here
    // only permits the next distinct batch after a verified completion.
    active = false;
    if (completed) armed = true;
    void heartbeat().catch(e => console.error("Heartbeat failed", e));
  }
}

console.log(`Gateway outbound worker started, armed=${armed}`);

// The gateway only connects outbound; the cloud cannot call into the home LAN.
async function heartbeat() {
  let printerReady = false;
  let operational = false;
  let printerState = "unknown";
  const missing = [1,2,3,4].filter(n => !existsSync(join(PRINTS, `proof-token-${n}.gcode`)));
  try {
    const result = await moon("/printer/objects/query?print_stats");
    const state = result?.result?.status?.print_stats?.state;
    printerState = ["standby","complete","printing","paused","error","cancelled"].includes(state) ? state : "unknown";
    operational = missing.length === 0 && ["standby","complete","printing","paused"].includes(printerState);
    printerReady = operational && ["standby", "complete"].includes(printerState);
  } catch (e) { console.error("Printer readiness check failed", e); }
  const readiness = `state=${printerState}, missing plates=${missing.join(",") || "none"}, armed=${armed}, active=${active}`;
  if (readiness !== lastReadiness) { console.log(`Printer readiness: ${readiness}`); lastReadiness = readiness; }
  await api("/api/gateway/heartbeat", { method: "POST", body: JSON.stringify({ armed: armed && !active, active, operational, printerReady, printerState }) });
}
if (!env.MOONRAKER_URL || !env.GATEWAY_TOKEN || !env.API_URL) throw new Error("API_URL, GATEWAY_TOKEN and MOONRAKER_URL are required");
void heartbeat().catch(e => console.error("Heartbeat failed", e));
setInterval(() => void heartbeat().catch(e => console.error("Heartbeat failed", e)), 15_000);
setInterval(async () => {
  if (!armed || active) return;
  try {
    const response = await api("/api/gateway/next") as { batch?: { id: string } };
    if (response.batch) await run(response.batch.id);
  } catch (e) { console.error("Queue poll failed", e); }
}, 15_000);
