# Current architecture

The configured shop network is `cardano:preprod` or `cardano:mainnet`. The public API reads it at startup from `CARDANO_NETWORK` and the browser reads it from `/api/catalog`. A CIP-30 wallet is explicitly selected and wrapped by Evolution SDK with the corresponding network and Blockfrost provider. The browser verifies the x402 offer's network, amount, asset and receiving address before it asks the wallet to sign.

A real HTTP 402 offer, signed `PAYMENT-SIGNATURE`, hosted facilitator verification/settlement and `PAYMENT-RESPONSE` precede the database transition to `PAID`. The API reserves one signed transaction per order before calling the facilitator. The browser retains the signed payload in session storage for same-transaction retries; if it is lost after an ambiguous settlement, operator reconciliation is required.

The home gateway never accepts browser calls. It polls the cloud API and sends authenticated heartbeat/status over outbound HTTPS. It checks all four pre-sliced U1 plate files and Moonraker idle state. The API pauses creation of new orders when the heartbeat is stale, gateway is unarmed, or printer readiness fails. The operator batches up to four paid orders, then the one-shot gateway journals, uploads and starts the prepared plate. Printer status reports are conditional; uncertain starts require manual inspection. Addresses stay only in Neon/operator API.

The U1 firmware and hosted facilitator contracts cannot be validated without actual access. See [deployment](DEPLOYMENT.md) for the test sequence and [security](SECURITY.md) for remaining operational limits.
