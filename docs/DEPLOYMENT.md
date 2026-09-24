# Deployment and real end-to-end verification

This service has **no simulation mode**. Use preprod for the first complete paid test, including the physical U1. Neither the facilitator nor the printer is included in the Compose stack. Before public sales, confirm hosted facilitator compatibility, your U1 endpoint and four sliced plates with an operator present. The app defaults to no network until `CARDANO_NETWORK` is set.

## Network and facilitator

Choose exactly `cardano:preprod` or `cardano:mainnet` as `CARDANO_NETWORK`. Match the seller address (`addr_test1…` for preprod; `addr1…` for mainnet), Blockfrost project ID, wallet network and facilitator capabilities. The facilitator must support x402 v2 `exact` Cardano for that network and implement `/verify`, `/settle`, `/supported`. Configure its base URL as `FACILITATOR_URL`; the current HTTP client does not implement a proprietary authorization scheme. If your hosted facilitator requires an API key, its exact header contract must be added to the resource server adapter before that host can be used.

Run `curl "$FACILITATOR_URL/supported"` and check the configured network. In a browser on preprod, verify HTTP 402, wallet signing, facilitator settlement, the `PAYMENT-RESPONSE` header and the transaction in an explorer. The browser's Blockfrost ID is embedded in public JavaScript; use provider quotas/domain restrictions. The gateway can start printing only after an operator creates a batch from paid orders.

Changing a running shop's network makes old unpaid orders ineligible for payment; existing paid orders retain their recorded network. Do not mix preprod and mainnet orders in one active launch without reviewing each order.

## Neon and migrations

Create a Neon Postgres project, apply `db/001_init.sql` to a fresh database, then `db/002_network.sql`, `003_gateway_readiness.sql`, and `004_payment_attempt_unique.sql` in order. Existing databases created by the previous version need only 002–004. Back up first. Each order snapshots its network and price. A pre-submit payment attempt records the tx hash and signed payload so the same transaction can be reconciled; only one attempt per order is accepted.

## Cloudflare API

From `apps/api`, set `CARDANO_NETWORK`, `FRONTEND_ORIGIN`, `PRICE_LOVELACE` and `BATCH_SIZE` in `wrangler.jsonc`. The checked-in network is preprod; deliberately change it to mainnet only when ready. Set secrets using `npx wrangler secret put` for `DATABASE_URL`, `FACILITATOR_URL`, `SELLER_ADDRESS`, `ADMIN_TOKEN`, and `GATEWAY_TOKEN`; generate the latter two independently with `openssl rand -hex 32`. Then run `npx wrangler deploy`. Do not set `LOCAL_DATABASE_URL` on a Worker. Leave `GATEWAY_URL` unset for outbound-only polling.

`GET /api/health` confirms configuration presence, while `/api/catalog` indicates printer readiness from a fresh heartbeat. Neither endpoint alone proves a successful on-chain transaction. Apply a WAF/rate limit to order creation and keep logs free of addresses/payment headers. A signed payment already attached to an order must be reconciled before another transaction is attempted.

Cloudflare Workers Free has a 10 ms CPU limit per request; actual x402 SDK work may require a paid plan. Verify with your own deployment and traffic. See the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Vercel frontend

Import the repository, set Root Directory to the repository root, Framework Preset `Other`, Install Command `npm ci`, Build Command `npm run build -w @print/web`, Output Directory `apps/web/dist`. Configure `VITE_API_URL` to the Worker URL and `VITE_BLOCKFROST_PREPROD_PROJECT_ID` and/or `VITE_BLOCKFROST_MAINNET_PROJECT_ID` for the network you will run. Redeploy the frontend after changing provider IDs. Set `FRONTEND_ORIGIN` on the Worker to the exact Vercel production origin. `vercel.json` handles `/admin` SPA routing.

**Vercel Hobby restricts commercial use.** For real paid physical goods, use an eligible commercial Vercel plan or an eligible alternative static host. The app is provider-independent static Vite output; the Worker API remains separate.

## Home U1 gateway

Verify LAN calls to `GET /printer/objects/query?print_stats`, `POST /server/files/upload` and `POST /printer/print/start?filename=…` on your U1 firmware. Use a printer operator and inspect actual G-code. Slice the STL into four U1-specific plates `proof-token-{1,2,3,4}.gcode` in `prints/`. The gateway will not report ready until all four exist and Moonraker says `standby` or `complete`.

Copy `.env.example` to `.env.gateway` on the home host. Set only `API_URL` (public Worker HTTPS URL), `GATEWAY_TOKEN` (same as Worker), `MOONRAKER_URL` (LAN address), optional `MOONRAKER_API_KEY`, `PRINTS_DIR=/prints`, `STATE_DIR=/data`, and `ARM_ONCE=true`. Run `docker compose -f gateway-compose.yml up --build -d`. There is **no inbound port**. It polls and heartbeats outbound every 15 seconds. The Worker never sees the U1 LAN address. The operator must create a batch and supervise the one allowed print start, then inspect/rearm manually.

## Acceptance sequence

1. On preprod, inspect `/supported`, API health and catalog readiness; confirm the U1 is idle and the four G-code files are loaded.
2. Use a funded **preprod** CIP-30 wallet, select it in the UI and confirm the target address and amount. The buyer first receives actual HTTP 402; the signed retry uses `PAYMENT-SIGNATURE`.
3. Verify facilitator settlement, transaction hash and recorded `PAID` order. Create a batch in `/admin`; observe gateway journal, Moonraker upload/start, `PRINTING`, `PRINTED` and the actual object on the plate.
4. Interrupt a payment request and recheck **the same** signed transaction. Disconnect the gateway and verify new order creation pauses; existing paid work stays queued. Inspect failed-print handling and restart/rearm only after physical review.
5. Only then switch the API to mainnet with a mainnet address/provider/facilitator and repeat a low-value controlled live purchase. Publish actual terms, privacy/contact, shipping and refund process, rate limits, backups and a commercial hosting plan before real customers.
