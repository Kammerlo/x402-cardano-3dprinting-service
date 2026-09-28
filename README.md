# 402 Print Protocol

**A Cardano payment you can hold in your hand.** This demo uses [x402](https://www.x402.org/) to sell a small 3D-printed token. A visitor connects a Cardano wallet, pays in ADA, and sees the HTTP payment exchange as it happens. After payment is recorded, an operator prints and ships the token.

[Open the preprod demo](https://x402-cardano-3dprinting-preprod.th-kammerlocher.workers.dev/) · [Deployment guide](docs/DEPLOYMENT.md)

> **Preprod is a test network.** Payments there use test ADA and do not result in a shipment. Mainnet requires separate configuration and real ADA.

## The idea

An API can answer a request with **HTTP 402 Payment Required** instead of immediately serving the requested resource. x402 gives the client a machine-readable payment offer and a way to attach proof of payment to the next request. Here, the offer is for an **exact amount of Cardano's native currency**, expressed in lovelace (1 ADA = 1,000,000 lovelace), on either Cardano preprod or mainnet.

The purchase is tied to a real order. The storefront shows a live protocol trace so you can follow the offer, wallet signature, submission, confirmation, and any recovery checks.

## How payment works here

```mermaid
sequenceDiagram
    participant Buyer as Browser + wallet
    participant API as x402 API
    participant F as Facilitator
    participant C as Cardano
    Buyer->>API: Request payment for an order
    API-->>Buyer: HTTP 402 + PAYMENT-REQUIRED
    Buyer->>Buyer: Check network, address, asset and amount; sign
    Buyer->>API: Retry with PAYMENT-SIGNATURE
    API->>F: Verify and settle signed payment
    F->>C: Submit and confirm transaction
    F-->>API: Settlement result
    API-->>Buyer: PAYMENT-RESPONSE + paid order
```

1. **Create an order.** The API saves the product, price, network and delivery details. The order starts as awaiting payment.
2. **Receive the offer.** The first payment request has no signature. The API responds with HTTP 402 and the x402 payment requirements. The browser checks the offered network, receiving address, asset and exact amount against the order.
3. **Sign in the wallet.** A CIP-30 Cardano wallet signs one transaction. The server never receives the wallet's private keys. The browser sends the signed payment in the `PAYMENT-SIGNATURE` header.
4. **Settle and record.** The API uses the official `@x402/cardano` exact scheme and an x402 facilitator to verify and settle the payment. It checks the settlement receipt against the signed transaction and network before recording the order as paid. The response includes `PAYMENT-RESPONSE`.
5. **Print after payment.** A private gateway on the printer's network polls for paid work. The operator checks that the print plate is empty and starts the next supported G-code batch in the admin dashboard. After printing, the operator ships the orders and marks them as sent.

Cardano confirmation can take longer than one HTTP request. The same signed transaction is retained and checked again; an uncertain response is **not** a reason to sign or pay a second time. Customers can later look up their transaction hash without reconnecting a wallet. The API can verify a stored payment against Cardano through Blockfrost when the facilitator has not yet confirmed it. [Payment recovery details](docs/PAYMENT_RECOVERY.md).

The printer may be offline while orders are accepted and settled. Paid orders wait in the database; the operator resumes printing from the dashboard when the printer returns. No new plate starts automatically after a completed batch. [Gateway and print operations](docs/GATEWAY_DEPLOYMENT.md).

## Try it locally

You need Docker Compose, a Cardano wallet on the chosen network, a compatible hosted x402 facilitator, a matching seller address, Blockfrost project ID, and a printer reachable through Moonraker. This is a real payment flow; the repository does not provide a fake facilitator or printer.

1. Copy `.env.local.example` to `.env` and fill in the values for **one network**. Use different random 64-character hexadecimal values for `ADMIN_TOKEN` and `GATEWAY_TOKEN` (`openssl rand -hex 32`). For local HTTP, set `FRONTEND_ORIGIN=http://localhost:5173` and `ADMIN_ALLOW_INSECURE_LOCALHOST=true`.
2. Add printer-tested files such as `prints/proof-token-1.gcode` and `prints/proof-token-4.gcode`. The number is the quantity on that plate; include a one-object file.
3. Run `docker compose up -d --build`. Open [the storefront](http://localhost:5173) and [the admin dashboard](http://localhost:5173/admin). The API is at `http://localhost:8787`.

The full Compose setup runs Postgres, migrations, API, web app and printer gateway. For a hosted setup, deploy the web app and API to Cloudflare, use Neon for Postgres, and run only the outbound gateway near the printer. Follow the [hosted deployment guide](docs/DEPLOYMENT.md) and [gateway-only Compose guide](docs/GATEWAY_DEPLOYMENT.md). The gateway does not need a public inbound port.

## Repository guide

| Path | What it does |
| --- | --- |
| `apps/web` | Storefront, wallet flow, protocol trace and admin dashboard |
| `apps/api` | x402 payment endpoint, orders, settlement and recovery |
| `apps/gateway` | Private connection to Moonraker and supervised print queue |
| `db` | PostgreSQL schema and migrations |
| `model`, `prints` | Token model and operator-provided G-code batches |

For implementation and operating details, see [architecture](docs/ARCHITECTURE.md), [operations](docs/OPERATIONS.md), [security](docs/SECURITY.md), [production review](docs/PRODUCTION_REVIEW.md), and [contributing](CONTRIBUTING.md).

The browser signing flow is adapted from the [Cardano Foundation x402 demo](https://github.com/cardano-foundation/x402-cardano-demo). Review the [open-source release checklist](docs/OPEN_SOURCE_CHECKLIST.md) for the upstream licensing issue before redistributing that adapted code.
