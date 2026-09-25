# Admin security and deployment boundary

The admin can change paid orders and authorize physical printing. Automated tests exercise the security controls; no application can be guaranteed unbreakable.

## Authentication

- Generate **independent 64-character random hex** `ADMIN_TOKEN` and `GATEWAY_TOKEN` values with `openssl rand -hex 32`. Missing, malformed or identical credentials fail closed on the corresponding privileged API.
- Admin login exchanges the access key for a random server-side session. The cookie is `__Host-print-admin`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and expires after eight hours. Only the session hash is stored in Postgres. The access key is not kept in browser storage. A credential fingerprint invalidates sessions when `ADMIN_TOKEN` changes.
- State-changing admin requests require the session, a per-session CSRF token and an exact `Origin` match against `FRONTEND_ORIGIN`. Sign-out revokes the server session; “Sign out all admin sessions” revokes every session. The UI also locks and attempts revocation after 15 minutes without interaction; if disconnected, the server's eight-hour expiry remains the fallback.
- Login is limited to 20 attempts/minute across the database. Bundled Nginx also limits login by source IP (5/minute, burst 5). Configure trusted-proxy real-IP handling or an edge rule when behind a reverse proxy; do not trust client-supplied forwarding headers. Global throttling can temporarily deny legitimate login during an attack, so restrict admin access at the edge.
- Bearer admin access is **disabled by default**. `ADMIN_ALLOW_BEARER=true` is an explicit non-browser automation opt-in that bypasses cookie/CSRF authentication; leave it unset for normal operation. Gateway credentials never authorize admin endpoints.
- Admin mutations create an audit record before execution, with route, hashed-session tag, time and resulting HTTP status. The audit does not store credentials, request bodies or customer data. A record with no result indicates interruption; reconcile actual state before repeating a physical action.

These controls follow the [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) guidance. They are not an independent penetration-test certification.

## Deployment requirements

Serve the admin frontend and `/api/admin/*` on the **same HTTPS origin**, using the included Nginx proxy or equivalent. Set `FRONTEND_ORIGIN` to that exact origin, without a trailing slash. A separate Vercel/Workers cross-site admin deployment must proxy the admin API through the frontend origin; do not weaken cookies to work around it. Restrict `/admin` and `/api/admin/*` with your VPN or an access proxy with MFA for Internet-facing deployments. Keep gateway access separate from that interactive login policy.

Local development only: `ADMIN_ALLOW_INSECURE_LOCALHOST=true` permits an HTTP origin at localhost/127.0.0.1 and a separate non-Secure development cookie. It is ignored for other hostnames. Never enable it for a public origin. HTTPS, proxy access rules, OS updates, database protection and backups remain operator responsibilities.

Nginx serves a Content Security Policy, no framing, nosniff and no-referrer headers. React renders customer input as text. No arbitrary G-code upload, shell commands, or Moonraker URL editing is exposed to the admin. Keep dependencies and container images patched.

## Physical and payment boundaries

Every start requires a confirmed empty plate, a recent idle heartbeat and an available batch file. The database serializes starts and accepts the expected current plate ID, preventing a stale dashboard from advancing another plate. Start permission expires after 60 seconds; the gateway rechecks Moonraker before upload and immediately before launch. An ambiguous start is not automatically repeated. The API cannot sense whether a plate is physically empty: that remains the operator's assertion.

The gateway has no inbound listener and receives no shipping details. Do not forward Moonraker or printer ports to the Internet. Preserve gateway journals through restarts and recovery. Someone holding the gateway secret or controlling the printer LAN is inside the printer-control trust boundary; rotate credentials on compromise.

Orders and signed attempts remain in Postgres. Public order lookup requires a high-entropy order secret; only its hash is stored. Signed payments use the official x402 SDK and same-transaction reconciliation. No private wallet keys enter the backend. Rate-limit new public orders, protect backups containing customer details/signed attempts, and configure retention and monitoring appropriate to your deployment.
