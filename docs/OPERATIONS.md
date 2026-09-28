# Running the print desk

## Daily workflow

1. Open `/admin`, sign in with your admin access key, and look at **Current plate**. It shows every assigned order and whether printing is in progress. New customer payments are accepted even if the printer is offline.
2. Remove all finished objects and inspect them. If one failed, use its order's **More actions → Needs a reprint**, then **Queue replacement** after inspection. Resolve any **Needs attention** orders before continuing.
3. Tick **I removed all prints and the plate is empty and safe to use**, then **Start the next batch**. The server checks a recent idle heartbeat and chooses a matching G-code size automatically. The gateway rechecks the physical printer before starting. The action also records the previous plate as cleared.
4. The next plate does not start merely because the current print finished. Repeat the empty-plate confirmation for every plate. An authorization expires after one minute; a queued job whose authorization expired needs another explicit start. If offline, restore the connection and retry—there is no delayed automatic start request waiting indefinitely.
5. Open **Ready to send**, package each object using the displayed name, email, address and country, then click **Mark as sent** after dispatch. Use **Sent** to find dispatched orders. Search by name, email or full order ID; results are paginated.

Files determine capacity: `proof-token-N.gcode` contains exactly N customer objects. Supported sizes are shown below the current plate. With files for 1, 3 and 6 and five orders waiting, the next plate has 3 objects. Provide `proof-token-1.gcode` for small queues. See [prepared plates](../prints/README.md).

## Recovery

- **Printer/gateway offline:** payments remain open unless you pause new orders. Restore Moonraker and the gateway; inspect the empty plate and use the same start button. Starting requires a heartbeat less than 30 seconds old.
- **Stopped or uncertain print:** stop the old job and gateway before inspecting the U1 and journal. Use **Review stopped / uncertain print** when offered. Resolve each order with **Inspected: print is good**, **Queue replacement**, or **Record completed refund**. Then clear the plate and start the next batch. Never delete journal files to force an old batch ID to launch again.
- **Damaged/lost shipment:** find it under Sent, use **Needs a reprint**, then **Queue replacement**. The original payment is preserved and the replacement uses a new batch ID.
- **Uncertain payment:** search All orders, then **More actions → Check stored payment**. Reconciliation uses the original transaction and official SDK; it does not request another signature. A saved verified receipt allows recovery even if the facilitator is down. If the process crashed after settlement but before saving the receipt, use facilitator/chain evidence to reconcile. A crashed attempt lease expires after 15 minutes. Do not ask for another payment just because an HTTP response was interrupted.
- **Refund:** transfer funds separately and verify the transfer, then record the completed refund. The button only records bookkeeping.
- **Shop paused:** resume under Shop settings & history. This affects new checkout, not existing paid orders.
- **Session expired:** sign in again. Key rotation revokes old sessions; Sign out all admin sessions is also available. Keep the key in a password manager.

## Backups and rollout

Back up before migrations, including `009_chain_payment_checks.sql`. Migrations retain orders and history. Never use `docker compose down -v` on a live installation. Rebuild API, web and gateway together with `docker compose up -d --build`; old gateway heartbeats do not supply the new G-code manifest and are rejected until upgraded.

Maintain encrypted daily Postgres backups and point-in-time recovery where available. For local Compose: `docker compose exec -T db pg_dump -U print -d print -Fc > orders.dump`. Restore into a separate database and verify orders, payment attempts and current plate. Preserve the `gateway_data` volume. After any restore, reconcile chain payments and the physical printer before permitting starts; a backup can predate both a payment and a physical print. Restored admin sessions should be invalidated by rotating `ADMIN_TOKEN`.

Serve `/admin` and `/api/admin/*` through the same HTTPS origin. Set `FRONTEND_ORIGIN` accordingly. Both access keys must be independent random 64-character hex strings. Keep `ADMIN_ALLOW_BEARER` unset. Local HTTP at localhost only requires `ADMIN_ALLOW_INSECURE_LOCALHOST=true`. See [security](SECURITY.md) for cookie, CSRF, edge/MFA and proxy configuration.

## Monitoring and launch checks

Monitor `/api/health` for configuration and `/api/ready` for database reachability. Alert on repeated 5xx, stale gateway heartbeats, payment attempts awaiting reconciliation, NEEDS_REVIEW orders, queue age and disk capacity. Check `admin_audit` for privileged actions and incomplete audit entries. Never export session cookies, access keys or customer details into public logs.

Node admits at most 100 active requests; the local database pool allows at most 100 waiting queries. Excess work receives a retryable 503. These are per-process resource limits; also configure edge limits for public order creation and admin login. Use one gateway per physical printer. Load-test the actual facilitator/database deployment before promising burst capacity.

Before public sales, test a real preprod wallet payment with the printer offline, interrupted payment recovery, a gateway restart mid-print, a failed object, a replacement plate, and shipment. Test backup restoration. Automated tests mock facilitator responses and do not prove on-chain or mechanical outcomes. The admin assumes a supervised physical printer.
