# Deploy only the printer gateway

Cloudflare hosts the frontend/API and Neon stores orders. Your Linux server runs only the gateway and holds the sliced G-code files. The gateway connects outbound to the Worker and talks privately to Moonraker. No public server address, inbound port, reverse proxy or Cloudflare Tunnel is needed.

## 1. Get the code

Install Docker Engine with the Docker Compose plugin and Git. Confirm `docker compose version` works. Your server must reach both the public Worker over HTTPS and the printer on its LAN (or private VPN).

For a new checkout:

```bash
git clone https://github.com/Kammerlo/x402-cardano-3dprinting-service.git
cd x402-cardano-3dprinting-service
cp .env.gateway.example .env.gateway
chmod 600 .env.gateway
nano .env.gateway
```

If you already have the checkout, use it and preserve any existing `.env.gateway`. A private repository requires your own GitHub authentication.

Fill in these four values:

| Variable | Value |
| --- | --- |
| `API_URL` | `https://x402-cardano-3dprinting-service.th-kammerlocher.workers.dev` |
| `GATEWAY_TOKEN` | The exact existing gateway token configured in the Cloudflare Worker |
| `MOONRAKER_URL` | Your printer's LAN URL, e.g. `http://192.168.1.100:7125` |
| `MOONRAKER_API_KEY` | Your Moonraker key, or empty if authentication is not required for this host |

The gateway token must be 64 hexadecimal characters and different from the admin token. To create one for a new installation, run `openssl rand -hex 32` and configure the same value on BOTH the gateway and the Worker. Do not change only one side. Keep the admin token exclusively in Cloudflare/your password manager.

Do not use `localhost` as the printer address: inside Docker it refers to the gateway container. Do not put Cloudflare Access's interactive login in front of `/api/gateway/*`; those routes authenticate with the gateway token.

## 2. Add G-code

Place your tested files directly in the repository's `prints/` folder:

```text
prints/proof-token-1.gcode
prints/proof-token-2.gcode
prints/proof-token-4.gcode
```

Each number is the exact quantity that file prints. Supply the batch sizes you support; they need not be consecutive. Include a one-object file so a single waiting order can print. Files must be non-empty regular files, not symlinks. The gateway discovers sizes automatically. Test the G-code with your exact printer/material before using it for customer orders.

## 3. Start it

Run all commands from the repository root:

```bash
docker compose -f docker-compose.gateway.yml up -d --build
docker compose -f docker-compose.gateway.yml ps
docker compose -f docker-compose.gateway.yml logs --tail=100 -f gateway
```

Press Ctrl+C to leave the logs; the gateway continues running. No API, database or frontend container is started, and no ports are published. The container restarts after a host reboot when Docker itself starts.

In the public admin dashboard, check the gateway's last-seen time and available batch sizes. Heartbeat and queue checks run about every 15 seconds; printer timeouts can make this slower. A running container alone does not prove printer/API connectivity.

## 4. Print orders

1. Turn the printer on and ensure Moonraker reports it idle.
2. Physically empty the build plate.
3. In admin, confirm the plate is empty and click **Start the next batch**.
4. After completion, remove the prints and repeat the plate confirmation for the next batch.
5. Ship the orders and mark them as sent.

The gateway never automatically starts a fresh plate without the operator's short-lived authorization. Cloudflare can continue accepting/settling orders while your printer or gateway is offline. When the gateway returns, use the dashboard to start the next batch.

## Update or restart

Prefer to update while the printer is idle:

```bash
git pull --ff-only origin main
docker compose -f docker-compose.gateway.yml up -d --build
```

After changing `.env.gateway`, apply it with:

```bash
docker compose -f docker-compose.gateway.yml up -d --force-recreate gateway
```

Restart without changing configuration:

```bash
docker compose -f docker-compose.gateway.yml restart gateway
```

Stop the gateway:

```bash
docker compose -f docker-compose.gateway.yml stop gateway
```

Stopping the gateway does not send a stop command to the printer. If a restart or outage occurs during printing, inspect the physical printer and review the current batch in admin. Do not assume the batch failed and automatically reprint it. The persistent journal prevents the same batch from being started twice; use the dashboard's completed/needs-review/replacement actions after inspection.

## Keep recovery data

Keep the `gateway_data` volume, `prints/`, and `.env.gateway`. Do not use `down -v`, delete the journal or prune this volume. Preserve the same checkout directory / Compose project name when upgrading: changing it can create a different volume.

If switching from the older `gateway-compose.yml`, run the new command in the SAME checkout with the SAME Compose project name. Both use the same service and volume keys. Do not run two gateway installations for one printer.

While idle, back up the journal:

```bash
docker compose -f docker-compose.gateway.yml exec -T gateway tar -C /data -czf - . > gateway-state-$(date +%F).tar.gz
```

Store that backup off the server together with your G-code. Keep any backup containing `.env.gateway` private.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| API 401 | Gateway token exactly matches the Worker, with no quotes/whitespace pasted into Cloudflare |
| API 503 on gateway routes | Worker gateway/admin tokens are valid, distinct 64-character hexadecimal values |
| HTML/login page instead of JSON | API_URL points to the Worker origin; Cloudflare Access does not block gateway API routes |
| Moonraker timeout | Printer power, private IP, routing from Docker and firewall |
| Moonraker 401/403 | MOONRAKER_API_KEY or Moonraker's trusted-host configuration |
| No available batch sizes | Correct filenames, files are non-empty and readable in `prints/` |
| Start button unavailable | Printer idle, fresh heartbeat, supported G-code size and plate-empty confirmation |
| Batch stuck after outage | Inspect printer, then resolve the current batch in admin; preserve the journal |

The gateway needs no Neon migrations or database access. Database migrations belong to the cloud API deployment.
