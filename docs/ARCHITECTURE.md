# Current architecture

The configured shop network is `cardano:preprod` or `cardano:mainnet`. The public API reads it at startup from `CARDANO_NETWORK` and the browser reads it from `/api/catalog`. A CIP-30 wallet is explicitly selected and wrapped by Evolution SDK with the corresponding network and Blockfrost provider. The browser verifies the x402 offer's network, amount, asset and receiving address before it asks the wallet to sign.

A real HTTP 402 offer, signed `PAYMENT-SIGNATURE`, hosted facilitator verification/settlement and `PAYMENT-RESPONSE` precede the database transition to `PAID`. The API reserves one signed transaction per order before calling the facilitator. The browser retains the signed payload in session storage for same-transaction retries; if it is lost after an ambiguous settlement, operator reconciliation is required.

The home gateway has no inbound listener and receives no addresses. It reports the sizes discovered from local G-code files and Moonraker readiness. `start_print_batch` locks shop settings and paid orders, checks the expected current plate ID and a fresh idle heartbeat, and authorizes one matching plate for 60 seconds. An explicit empty-plate confirmation is required for every start. Completion alone never advances the queue. The gateway claims, journals, uploads and starts the job once, checking physical idle state before upload and again before launch. Uncertain starts require operator review.

Admin routes share session authentication, CSRF/origin checks and mutation auditing. Browser credentials are exchanged for expiring HttpOnly cookies. Admin bearer access is opt-in for non-browser automation and disabled by default.

The U1 firmware and hosted facilitator contracts cannot be validated without actual access. See [deployment](DEPLOYMENT.md) for the test sequence and [security](SECURITY.md) for remaining operational limits.
