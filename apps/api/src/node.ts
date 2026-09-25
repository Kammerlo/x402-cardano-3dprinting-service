import { serve } from "@hono/node-server";
import app from "./index";
serve({ fetch: (request) => app.fetch(request, process.env as Record<string,string>), port: Number(process.env.PORT || 8787), hostname: "0.0.0.0" });
console.log(`API listening on ${process.env.PORT || 8787}`);
