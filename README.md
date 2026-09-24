# Cardano x402 3D Print Shop

A planned open-source storefront where a Cardano mainnet x402 payment buys a real print from a Snapmaker U1.

The [architecture plan](docs/ARCHITECTURE.md) covers hosting choices, the buyer's HTTP 402 flow, settlement and replay recovery, private printer communication, fulfillment, and implementation gates. The repository contains the plan only at this stage.

The intended zero-subscription deployment is Cloudflare Pages + a Cloudflare Worker + Neon Free + a home worker that makes outbound requests. Vercel requires a commercial plan for a storefront that sells products. The Cloudflare Worker/SDK compatibility and CPU budget are the first technical gate.
