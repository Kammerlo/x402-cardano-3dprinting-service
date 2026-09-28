# Hosted deployment: Cloudflare Worker, Neon and home gateway

The Worker serves the built Vite storefront and the API on one HTTPS origin. Neon stores orders and payment recovery state. A separate Docker gateway polls the Worker and reaches the printer on its private LAN; it has no inbound port. See [local Compose setup](../README.md#run-locally-with-real-services) if you are developing on one machine. There is no simulated payment or printer path.

## Prerequisites

- Node 22+, npm, a Cloudflare account with Workers enabled, a Neon Postgres database and a hosted x402 v2 facilitator supporting Cardano `exact` on your selected network.
- A seller address, funded CIP-30 buyer wallet, and Blockfrost project ID on the **same** network (`cardano:preprod` first; `cardano:mainnet` only after verification).
- A server with Docker Engine and Compose that can reach both the Worker over HTTPS and Moonraker over a private LAN/VPN, plus U1-tested `proof-token-N.gcode` files. See [gateway setup](GATEWAY_DEPLOYMENT.md).

The facilitator must implement `/supported`, `/verify` and `/settle`. Check `/supported` before taking orders. The current API client has no custom facilitator authentication header; a service requiring one needs an adapter change. A Blockfrost project ID supplied to the web build is visible to every browser; use a dedicated project and applicable quotas/restrictions.

## 1. Apply Neon migrations

Back up an existing production database first. From the repository root, use a Neon connection string with SSL. Apply every SQL file in numeric order, **001 through 010**. For example:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST/neondb?sslmode=require'
for migration in db/[0-9][0-9][0-9]_*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" || exit 1
done
unset DATABASE_URL
```

Install `psql` locally, or run each file in Neon's SQL editor in the same order. Existing installations should apply only unapplied migrations and verify their backups before upgrading. Migrations 009 and 010 add chain payment checks and the last-check diagnostic cache. Apply migrations before deploying a newer API. Do not share the connection string or paste it in a shell command that will be committed.

## 2. Build and deploy the Worker

The repository root is the build directory. Run `npm ci`, then supply the network's browser provider ID at **build time**:

```bash
npm ci
VITE_BLOCKFROST_PREPROD_PROJECT_ID=YOUR_PREPROD_ID npm run build -w @print/web
npx wrangler login
npx wrangler deploy --config apps/api/wrangler.jsonc
```

For mainnet also provide `VITE_BLOCKFROST_MAINNET_PROJECT_ID` at build time. Build again whenever an ID changes. Wrangler's `apps/api/wrangler.jsonc` includes `../web/dist` as the static asset directory and routes `/api/*` to the Worker. Use one origin for the storefront, `/admin` and API. If Cloudflare's Git build UI is used, set the root directory to the **repository root**, install with `npm ci`, build with `npm run build -w @print/web`, and deploy with `npx wrangler deploy --config apps/api/wrangler.jsonc`. Add the `VITE_BLOCKFROST_*` build variable there as appropriate. Do not put admin/gateway/database secrets in build variables or `VITE_*`.

In Cloudflare Workers & Pages → your Worker → Settings → Variables and Secrets, set:

| Name | Kind | Value |
| --- | --- | --- |
| `CARDANO_NETWORK` | Variable | `cardano:preprod` initially |
| `PRICE_LOVELACE` | Variable | Price in lovelace, e.g. `5000000` |
| `FRONTEND_ORIGIN` | Variable | Exact Worker HTTPS origin, without trailing slash |
| `DATABASE_URL` | Secret | Neon connection string, with SSL |
| `FACILITATOR_URL` | Secret | Hosted facilitator base URL |
| `SELLER_ADDRESS` | Secret | Matching receiving address |
| `ADMIN_TOKEN` | Secret | One `openssl rand -hex 32` result |
| `GATEWAY_TOKEN` | Secret | A **different** `openssl rand -hex 32` result |
| `BLOCKFROST_PREPROD_PROJECT_ID` | Secret | Preprod project ID for payment recovery and admin checks |
| `BLOCKFROST_MAINNET_PROJECT_ID` | Secret | Mainnet project ID for payment recovery and admin checks |

Set both Blockfrost secrets if you have unresolved orders on both networks. The API uses the ID matching each order's recorded network, even after the storefront switches to mainnet. The `VITE_BLOCKFROST_*` browser build values do not configure backend recovery.

Variables and secrets can also be set with `npx wrangler secret put NAME --config apps/api/wrangler.jsonc` for each secret. Do not write real values into `wrangler.jsonc`, `.env.example`, source, CI, or a public issue. Keep `ADMIN_ALLOW_BEARER` unset. The admin expects HTTPS and an exact same-origin `FRONTEND_ORIGIN`; `ADMIN_ALLOW_INSECURE_LOCALHOST` is for local HTTP only. Redeploy/restart if your platform requires it after changing variables.

Configure an access policy with MFA for `/admin` and `/api/admin/*`, without putting an interactive challenge in front of `/api/gateway/*`. Configure edge rate limits for new orders and admin login. Workers, Neon, facilitator and provider quotas must be measured against expected bursts.

## 3. Connect the home gateway

Follow [the standalone gateway guide](GATEWAY_DEPLOYMENT.md) and copy `.env.gateway.example` to a private `.env.gateway`. `API_URL` is this Worker's origin; `GATEWAY_TOKEN` must match the Worker secret exactly. The gateway sends outbound requests only. The operator physically checks the plate and authorizes each next batch in `/admin`. Paid orders remain in Neon if the printer or gateway is offline.

## Shipping destinations and pricing

Checkout accepts a free-text country or territory and international postal codes, including destinations where no postal code applies. The database country column is already text, so this change needs no new migration. The displayed ADA price currently includes shipping for every destination; there is no country-specific shipping calculation or destination restriction. Set `PRICE_LOVELACE` with worldwide fulfillment costs in mind before taking mainnet orders, and verify that you can deliver to each destination you intend to serve. The admin delivery address shows the submitted country.

## 4. Verify before taking sales

1. Confirm `GET /api/health` shows configured payment settings and `GET /api/ready` reaches Neon. Neither proves a successful on-chain payment. Check gateway heartbeat and supported G-code sizes in admin.
2. On **preprod**, complete a real wallet payment: inspect HTTP 402 and the `PAYMENT-RESPONSE`, transaction hash, settled order and chain confirmation. Interrupt one payment and reconcile the **same** signed transaction rather than asking for another signature.
3. With the printer offline, verify payment still settles into a waiting order. Restore the gateway, empty the plate, start a batch in admin, inspect the actual print, then mark it sent. Test a restart mid-print and resolve ambiguous status manually.
4. Restore a database backup into a separate database and reconcile its state against the chain and physical printer. Monitor 5xx, stale heartbeat, payment attempts needing review, queue age and disk usage. See [operations](OPERATIONS.md) and [security](SECURITY.md).
5. Only after the above, switch **both** the Worker and web build to mainnet credentials, repeat a low-value real purchase, and publish your shop's terms, shipping/refund policy, privacy/contact details and applicable business notices. A payment success does not imply a physically successful print.

Changing a running shop's network leaves older unpaid orders ineligible for payment. Paid orders retain their recorded network. Do not mix networks casually, and do not attempt to resolve uncertain payments by creating fresh transactions.
