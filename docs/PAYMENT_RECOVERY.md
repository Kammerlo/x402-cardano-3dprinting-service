# Delayed payments and recovery

Checkout and Check payment status recheck the original signed transaction for up to ten minutes, with 15 seconds between completed requests (maximum 40 rechecks). No new wallet signature is requested. A delayed 402 is not proof that an earlier transaction failed. Once a signed payment has been sent, even the first bare 402 is treated as uncertain rather than a safe invitation to pay again.

Customers can save the transaction hash and use Check payment in the storefront later, without a wallet connection. Orders and signed payments received by the backend remain in PostgreSQL when the browser closes. If the signed request never reached the backend, the server cannot recover its hash: the original tab still holds the signed payment, and a hash lookup clearly reports no linked order rather than claiming payment failure.

## Enable automatic chain checks

1. Run `db/009_chain_payment_checks.sql` on Neon before deploying this change. It is additive and safe to run again.
2. Add the matching **runtime Secret** to the Cloudflare Worker:
   - `BLOCKFROST_PREPROD_PROJECT_ID` for preprod.
   - `BLOCKFROST_MAINNET_PROJECT_ID` for mainnet.
3. Deploy the Worker. These runtime secrets are separate from the frontend's `VITE_BLOCKFROST_*` build variables.

The normal signed-payment retry and the public hash lookup both check transactions already associated with an order when the facilitator cannot confirm them. A confirmed on-chain payment is recorded and returned as paid without a new wallet signature. It uses the order's network and verifies the stored signed hash, payment terms, successful execution, receiving address, lovelace amount and canonical confirmation depth through Blockfrost. It honors the signed x402 confirmation policy, with a minimum of one newer block. Matching payments are atomically marked PAID with a CHAIN_SETTLEMENT event and become eligible for supervised printing. It never submits transactions. Script/escrow payments are not automatically reconciled by this direct-payment verifier.

Known pending hashes are limited to one provider check per 15 seconds across Worker instances. Missing credentials, provider outages, rate limits and 404s never mark an order paid or discard it. Hash lookups return only transaction, network, payment/fulfillment status and chain-check result—no customer information or order access secrets. A recorded payment is not continuously rechecked for later chain rollbacks.

## Offer and admin check troubleshooting

An HTTP 500/503 on the initial "Request payment requirements" step happens before wallet signing. Keep the existing order and retry after the API issue is fixed; no transaction was sent by that attempt. The Worker now returns a safe, actionable HTTP 503 response if the x402 middleware cannot issue an offer. Check Worker logs for the order ID and network, verify `FACILITATOR_URL` is set as an API Worker runtime variable, and check the facilitator's `/supported` response includes x402 version 2, scheme `exact`, and the configured `cardano:mainnet` or `cardano:preprod` network. Also verify `SELLER_ADDRESS`, `CARDANO_NETWORK`, and `DATABASE_URL` and run all migrations. `/api/health` checks configuration presence, not facilitator support or availability.

Admin → awaiting payment → More actions → Check stored payment checks the recorded signed hash against Blockfrost, independent of the facilitator. It reports confirmed, still confirming, not found, temporarily unavailable, mismatched, rate limited for 15 seconds, or missing API credentials. A confirmed matching transaction updates the order to PAID. The button needs the appropriate `BLOCKFROST_*_PROJECT_ID` secret and migration 009. A "not found" result does not prove the transaction can never appear later; retry it. No signed attempt means there is no stored transaction to check.

## Operator override

Under an awaiting-payment order's More actions, use Mark verified transaction as settled only after verifying the network, receiving address and full amount on-chain. Paste the stored hash to confirm. The action requires an authenticated admin, CSRF protection, a matching saved attempt and no active payment reconciliation. It records MANUAL_SETTLEMENT plus the normal admin audit, and releases the order for printing. It does not create a facilitator receipt or transfer funds. Repeated requests cannot create duplicate paid events.
