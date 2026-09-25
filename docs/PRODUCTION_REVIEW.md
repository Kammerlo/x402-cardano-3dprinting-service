# Production review

Reviewed against main commit 45d2b8c3e2ad4b1779c74c749fe496f1ddee6944.

## Package provenance

The application already uses the official `@x402/cardano` 2.26.0 package on both server and browser, with matching `@x402/core` and `@x402/hono`. The [Cardano Developer Portal](https://developers.cardano.org/x402/) identifies `@x402/cardano` as the official core SDK package. The npm lockfile uses registry packages, not an application fork. No custom payment signature verification was substituted for the SDK.

## Findings addressed

- Concurrent copies of a signed payment could call settlement concurrently: add a database lease, retained original transaction and verified receipt recovery.
- Operators could see attempts but could not reconcile them: add an authenticated SDK reconciliation action, without exposing signed payloads in the dashboard.
- Older orders disappeared after 200 records: add search, paging and global counters; retain current plate visibility.
- Uncertain but usable objects could only be shipped/refunded/reprinted: add explicit inspected-good recovery, plus replacement prints for shipped orders.
- Gateway timer work could overlap and journal writes could be torn: serialize recurring loops, flush and atomically replace journal files; reject unexpected printer filenames/states.
- Development servers ran in Compose: serve compiled assets with Nginx, non-watching server processes, restart policies and graceful API shutdown.
- Missing request resource limits: bound JSON size, Node active requests and local pool backlog, and document edge protection. Add database readiness separately from printer status.
- Dense routing/payment and JSX code: extract payment/domain modules and format application code for review.

## Remaining release gates

This is a hardening change, not a guarantee that every failure is recoverable automatically. Run CI with PostgreSQL, test real preprod wallet/facilitator integration, exercise physical printer failure recovery, configure backups and alerting, and measure burst capacity in the target deployment. Recovery after settlement succeeds but all database writes fail still depends on facilitator/chain reconciliation. Exactly-once physical printing cannot be inferred from an HTTP timeout; ambiguous jobs deliberately require inspection. A single gateway and supervised plates are operational requirements.

Country is present and retained in checkout and admin shipping. Shipping remains Germany-only, consistent with the existing price and policy. No real funds, printer jobs or production database were touched by this review.
