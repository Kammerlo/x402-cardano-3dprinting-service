import { serve } from "@hono/node-server";
import app from "./index";
import { closeLocalPool } from "./db";

// A bounded admission queue protects the process during traffic bursts.
let active = 0;
let stopping = false;
const server = serve({
  fetch: async (request) => {
    if (stopping || active >= 100)
      return new Response(JSON.stringify({ error: "Busy; retry shortly" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      });
    active++;
    try {
      return await app.fetch(request, process.env as Record<string, string>);
    } finally {
      active--;
    }
  },
  port: Number(process.env.PORT || 8787),
  hostname: "0.0.0.0",
});
if ("requestTimeout" in server) server.requestTimeout = 300_000;
if ("headersTimeout" in server) server.headersTimeout = 30_000;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    server.close(() => {
      void closeLocalPool().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 290_000).unref();
  });
console.log(`API listening on ${process.env.PORT || 8787}`);
