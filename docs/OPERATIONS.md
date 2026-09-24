# Operator runbook

1. Ensure `/api/catalog` reports the printer ready, with a fresh gateway heartbeat and all four approved G-code plates present. Open `/admin`, enter `ADMIN_TOKEN`, and inspect paid orders and full delivery addresses. Avoid sharing screenshots of this view.
2. Check the printer is idle, the matching 1–4 copy pre-sliced plate files exist, filament and bed are ready, and the gateway is armed. Press **Create batch**. It atomically assigns up to four oldest paid orders to one plate.
3. The gateway polls the API, checks the batch ID/count, checks printer idle state, records a journal entry, uploads the chosen G-code and starts it once. The dashboard moves BATCHED → PRINTING → PRINTED. The actual U1 reports completion through Moonraker.
4. Inspect physical output, pack each of the N tokens, use the matching private order addresses, and mark orders **SHIPPED** individually. The dashboard never prints shipping labels automatically.
5. If a job shows NEEDS_REVIEW or gets stuck in DISPATCHING/PRINTING, inspect Moonraker, gateway logs and `/data/{batch-id}.json` before any restart. The journal deliberately stops automatic duplicate launches. Record manual resolution; the current UI has no requeue control. If you refund, send ADA manually, verify the transfer, then mark **REFUNDED**. That label alone does not send money.
6. Restart the gateway only after the last print is resolved to re-arm it for one next launch. Back up Neon and the persistent journal. Pause orders if fulfillment is blocked.

## Order states

`AWAITING_PAYMENT → PAID → BATCHED → PRINTING → PRINTED → SHIPPED`; exceptions are `NEEDS_REVIEW` and manually recorded `REFUNDED`. Batches use `QUEUED → DISPATCHING → PRINTING → PRINTED`. Orders and batches remain private. A transaction hash, when available, links to Cardanoscan.

## Payment ambiguity

The browser preserves a signed payload in session storage and presents **Recheck signed payment** after an interrupted request. It resends the same signature. Do not ask a customer to sign another transaction while status is uncertain. The operator must reconcile the transaction in the explorer and database if facilitator settlement succeeds but persistence fails. No automatic refund or on-chain reconciliation daemon exists in this version.
