# Deploying the shop

## 0. Before taking orders

Set a price in lovelace that covers material, handling, shipping and payment fees. The form currently ships only to Germany, validates a 5-digit German postal code, and lists one fixed price. Replace the contact/refund wording with actual operator contact and terms, decide delivery expectations and retention, and verify your legal obligations for selling physical goods. Do not enable sales before the local and mainnet acceptance checks below. **Do not use the local simulation in a public deployment.**

The requested Vercel frontend may require a paid plan: Vercel Hobby terms restrict commercial use. If a free commercial frontend is a hard constraint, deploy the same static `apps/web/dist` to Cloudflare Pages after checking its current terms. Cloudflare Workers Free has CPU/request limits; this x402 operation may require a paid Workers plan in practice. Neon Free and the home gateway can start free, subject to current quotas. See provider terms before launch.

## 1. Neon

Create a Neon PostgreSQL project. Run `db/001_init.sql` against its main database with `psql "$DATABASE_URL" -f db/001_init.sql` or the Neon SQL editor. Keep the URL secret. The API uses Neon HTTP queries on Workers and `pg` only when `LOCAL_DATABASE_URL` is set for local Docker.

## 2. Hosted facilitator and Cardano

Confirm the facilitator explicitly supports the **x402 v2 exact Cardano `cardano:mainnet`** scheme, verification and settlement using the package versions in `package-lock.json`. Supply its HTTPS base URL as `FACILITATOR_URL`. Generate a mainnet `addr1…` receiving address as `SELLER_ADDRESS`; check it is yours and can receive ADA. The facilitator credentials, if your host requires them, must be added to its supported authentication transport before launch; the current HTTP client takes only a URL. Do a low-value real end-to-end payment to check response header format and transaction hash. Refunds require a separate operator wallet transfer.

A mainnet Blockfrost project ID is needed in the browser for live UTxO selection. `VITE_BLOCKFROST_PROJECT_ID` is public in built JavaScript; set quotas or domain restrictions accordingly. The wallet must expose CIP-30, have mainnet ADA, and be switched to network ID 1. The UI currently chooses the first injected compatible wallet; test the wallet(s) you intend to support.

## 3. Cloudflare Worker API

From repository root:

```sh
npm ci
cd apps/api
npx wrangler login
npx wrangler secret put DATABASE_URL
npx wrangler secret put FACILITATOR_URL
npx wrangler secret put SELLER_ADDRESS
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

Generate independent secrets with `openssl rand -hex 32`. Set `FRONTEND_ORIGIN`, `PRICE_LOVELACE`, and `BATCH_SIZE` in `apps/api/wrangler.jsonc` to your production values before deploy. `FRONTEND_ORIGIN` must exactly match the browser origin. Keep `GATEWAY_URL` absent for the outbound-only gateway. Do not set `LOCAL_DATABASE_URL` or `DEMO_PAYMENT_MODE` in production. Test `/api/health` and `/api/catalog`. Avoid exposing Worker logs that could contain headers or order data.

The public `/api/orders` endpoint has basic validation but **no abuse throttling** in this version. Put a rate limit/WAF rule on order creation, enforce a reasonable order cap, and monitor the DB. Admin uses a long bearer token; Cloudflare Access can additionally protect `/api/admin/*`. Avoid placing the token in a URL. The dashboard stores it in session storage for the current tab.

## 4. Vercel

Import this repository; set Root Directory to the repository root, Framework Preset `Other`, Install Command `npm ci`, Build Command `npm run build -w @print/web`, Output Directory `apps/web/dist`. The Vercel project environment needs:

```text
VITE_API_URL=https://YOUR-WORKER.workers.dev
VITE_BLOCKFROST_PROJECT_ID=YOUR_MAINNET_BLOCKFROST_PROJECT_ID
```

Set the Worker `FRONTEND_ORIGIN` to the exact Vercel production origin and redeploy the Worker. `/admin` rewrites to the SPA via root `vercel.json`. Preview deployments have different origins and need matching CORS configuration if you plan to test them. A public Vercel deployment is a commercial storefront once real goods are sold; check plan eligibility.

## 5. Home gateway and Snapmaker U1

Connect the printer to the operator's LAN. The U1 integration expects a **compatible Moonraker API**, which varies by firmware/setup. Verify from the home host that `/printer/objects/query?print_stats`, `/server/files/upload`, and `/printer/print/start` work for your actual device. The code does not alter firmware. An incompatible U1 requires a tested adapter in `apps/gateway`; do not arm the gateway until the adapter is verified.

Slice `model/proof-token.stl` on your actual U1 profile into plate layouts for exactly 1, 2, 3, and 4 copies. Place the resulting files in `prints/proof-token-1.gcode` through `prints/proof-token-4.gcode`. Check spacing, bed adhesion, filament and collision clearance in the slicer. **The app does not generate G-code or auto-arrange plates.** A batch of size N loads the pre-approved N-copy plate. One batch can print at a time.

Copy `.env.example` to `.env.gateway` on the home host, fill only the gateway fields and a unique `GATEWAY_TOKEN` matching the Worker secret. `API_URL` must be the public HTTPS Worker URL; `MOONRAKER_URL` remains an internal LAN URL. Remove unrelated frontend/Worker variables from this file. Run:

```sh
docker compose -f gateway-compose.yml up --build -d
```

No port is published. Its outbound poll runs every 15 seconds. `ARM_ONCE=true` permits at most one job launch per process and the persistent journal blocks an automatic restart of a possibly started job. After inspecting the print and journal, re-arm by restarting the gateway container. Keep the `/data` Docker volume. Use the admin dashboard to group paid orders; do not leave an unattended printer armed.

### Optional reverse proxy / push

If you prefer immediate API pushes, expose only the gateway endpoint through a Cloudflare Tunnel and put a Cloudflare Access service-token policy in front of it. Configure `GATEWAY_URL` plus `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` as Worker secrets. Keep gateway bearer auth and polling as recovery. Never forward the Moonraker port or reveal the LAN host. This option adds configuration and is unnecessary for the basic service.

## 6. Acceptance before public launch

- Run the local Docker flow and confirm 402, demo payment, admin batch, mock printed status and tracking.
- Validate the STL and all four U1 G-code plates physically, including a printer error and an interrupted connection.
- On a controlled mainnet order, inspect 402 `PAYMENT-REQUIRED`, the wallet amount and address, `PAYMENT-RESPONSE`, the explorer transaction and the stored order. Test an interrupted request and retry the **same** signed payment.
- Confirm admin and gateway tokens are different, origin restriction and rate limits are in place, DB backups and retention are configured, operator contact and shipping/refund terms are published, and hosting plans allow commerce.
- Start with one supervised real order. Pause orders via admin if printing or fulfillment cannot keep pace.
