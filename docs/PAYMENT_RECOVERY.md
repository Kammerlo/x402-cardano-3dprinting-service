# Delayed payments and recovery

Checkout and Check payment status recheck the original signed transaction for up to ten minutes, with 15 seconds between completed requests (maximum 40 rechecks). No new wallet signature is requested. A delayed 402 is not proof that an earlier transaction failed.

Customers can save the transaction hash and use Check payment in the storefront later, without a wallet connection. Orders and signed payments received by the backend remain in PostgreSQL when the browser closes. If the signed request never reached the backend, the server cannot recover its hash: the original tab still holds the signed payment, and a hash lookup clearly reports no linked order rather than claiming payment failure.

## Enable automatic chain checks

1. Run `db/009_chain_payment_checks.sql` on Neon before deploying this change. It is additive and safe to run again.
2. Add the matching **runtime Secret** to the Cloudflare Worker:
   - `BLOCKFROST_PREPROD_PROJECT_ID` for preprod.
   - `BLOCKFROST_MAINNET_PROJECT_ID` for mainnet.
3. Deploy the Worker. These runtime secrets are separate from the frontend's `VITE_BLOCKFROST_*` build variables.

The public hash lookup only checks transactions already associated with an order. It uses the order's network and verifies the stored signed hash, payment terms, successful execution, receiving address, lovelace amount and canonical confirmation depth through Blockfrost. It honors the signed x402 confirmation policy, with a minimum of one newer block. Matching payments are atomically marked PAID with a CHAIN_SETTLEMENT event and become eligible for supervised printing. It never submits transactions. Script/escrow payments are not automatically reconciled by this direct-payment verifier.

Known pending hashes are limited to one provider check per 15 seconds across Worker instances. Missing credentials, provider outages, rate limits and 404s never mark an order paid or discard it. Hash lookups return only transaction, network, payment/fulfillment status and chain-check result—no customer information or order access secrets. A recorded payment is not continuously rechecked for later chain rollbacks.

## Operator override

Under an awaiting-payment order's More actions, use Mark verified transaction as settled only after verifying the network, receiving address and full amount on-chain. Paste the stored hash to confirm. The action requires an authenticated admin, CSRF protection, a matching saved attempt and no active payment reconciliation. It records MANUAL_SETTLEMENT plus the normal admin audit, and releases the order for printing. It does not create a facilitator receipt or transfer funds. Repeated requests cannot create duplicate paid events.
