# Shuttle

Self-hosted remote fleet terminal access and control. A purpose-built replacement for ad-hoc `tmate` usage across a personal server fleet.

## Components

| Component | Description |
|---|---|
| `client/` | Go daemon (`shuttled`) — polls for actions, manages tmux+upterm sessions |
| `manager/` | Cloudflare Worker + D1 — action queue, state, API |
| `web/` | SvelteKit dashboard — server list, session control, command execution |
| Telegram bot | Built into the manager Worker — full management via bot commands |

## Architecture

```
 ┌──────────────┐   beacon/poll (HTTPS, HMAC-PSK)   ┌──────────────────┐
 │   shuttled    │ ─────────────────────────────────▶ │  Manager (CF)    │
 │ (Go, systemd) │ ◀───────────────────────────────── │  Worker + D1     │
 └──────┬────────┘   settings + pending actions        └────────┬─────────┘
        │                                                        │
        ▼ (ephemeral extraction, zero persistent footprint)      ├── Web dashboard
 ┌─────────────┐     SSH (upterm relay)                         └── Telegram bot
 │ tmux+upterm │ ─────────────────────────────▶ operator's SSH client
 └─────────────┘
```

- Clients **never accept inbound connections** — all traffic is client-initiated.
- The manager never contacts clients directly; it only answers their polls.
- Zero client fingerprint on disk (no config files, no log files, no credential files).

---

## Quick Start

### 1. Deploy the Manager

```bash
cd manager
pnpm install

# Create D1 database
wrangler d1 create shuttle-db
# → Copy the database_id into wrangler.toml

# Create KV namespace
wrangler kv:namespace create SHUTTLE_RATE
# → Copy the id into wrangler.toml

# Apply schema (creates tables + seeds default settings)
pnpm run db:init

# Set secrets (never commit these)
wrangler secret put SHUTTLE_PSK          # your fleet pre-shared key
wrangler secret put TELEGRAM_BOT_TOKEN   # optional
wrangler secret put TELEGRAM_WEBHOOK_SECRET  # optional

# Deploy
wrangler deploy
```

### 2. Build and Deploy the Web Frontend

```bash
cd web
pnpm install
pnpm build          # outputs to web/dist/
# dist/ is picked up automatically by the manager's [assets] binding
```

### 3. Build Client Binaries

```bash
cd client

# Download and compress embedded tmux+upterm binaries
make embed

# Build release binaries for all arches
# PSK must match the SHUTTLE_PSK secret set in step 1
make build PSK=<your-fleet-psk>
# → dist/shuttled-linux-amd64
# → dist/shuttled-linux-arm64
# → dist/shuttled-linux-386
```

> **Security note**: The PSK is compiled into the binary. Anyone who extracts the binary can read the PSK. Mitigate by keeping binaries off public hosts, using HMAC-signed requests (replay-resistant), and rate-limiting the beacon endpoint.

### 4. Install on a Server

```bash
# From a pre-built binary:
bash install.sh --binary dist/shuttled-linux-amd64

# From a URL (e.g. a private GitHub release):
bash install.sh --url https://your-host/shuttled-linux-amd64

# Force user-level install (no root required):
bash install.sh --binary dist/shuttled-linux-amd64 --user
```

### 5. Generate Update Signing Key

```bash
# Generate ed25519 keypair for signed updates
openssl genpkey -algorithm Ed25519 -out update_private.pem
openssl pkey -in update_private.pem -pubout -out update_public.pem

# Get the 32 raw bytes for client/internal/update/keys.go
openssl pkey -in update_public.pem -pubin -outform DER | tail -c 32 | xxd -i
```

Replace the placeholder bytes in [`client/internal/update/keys.go`](client/internal/update/keys.go) with your key.  
Keep `update_private.pem` **offline** — it signs updates that go to your entire fleet.

---

## Client Daemon

### PSK embedding

The fleet PSK is baked in at link time — **not** in the systemd unit, not in any config file:

```bash
go build -tags release \
  -ldflags "-X github.com/shuttle-fleet/shuttle/client/internal/auth.PSK=<psk> -s -w" \
  -o shuttled ./cmd/shuttled
```

To rotate the PSK: rebuild all binaries with the new PSK and re-run `install.sh`.

### Zero fingerprint

The client leaves **no** recognizable on-disk artifacts:

- No config files, no log files, no PID files, no credential files
- Embedded tmux + upterm are extracted to `/tmp/.<random-hex>/` with opaque names and deleted on session end or clean exit
- Tmux sessions use opaque names (`s-<hex>`, `c-<hex>`)
- All shell environments have `HISTFILE=/dev/null` to prevent history pollution

The only intentional exceptions, clearly documented:

| File | Purpose | Cleaned by |
|---|---|---|
| Binary at install path | The daemon itself | `uninstall.sh` |
| `.prev` next to binary | Update rollback backup | Deleted on confirmed successful update or `uninstall.sh` |
| `~/.shuttled_id` | Fallback ID (only when `/etc/machine-id`, MAC, and DMI UUID are all unreadable) | `uninstall.sh` |

### Crash recovery

On startup, the client:
1. Scans `/tmp/` for any leftover ephemeral dirs from a prior crash and removes them
2. Scans `tmux ls` for any `s-*` (session) and `c-*` (command) sessions — kills orphaned sessions, re-attaches to in-progress commands

### Self-update + rollback

Updates are delivered via the beacon response `update` field. The client:
1. Downloads the new binary
2. Verifies SHA-256 checksum and ed25519 signature (against the compiled-in public key)
3. Atomically swaps the binary (`rename` — atomic on same filesystem)
4. Keeps `.prev` as a rollback backup
5. Exits cleanly → systemd restarts with the new binary
6. After one successful beacon post-update, the manager sends `cleanup_prev` → client deletes `.prev`

**Rollback**: if the new binary crash-loops (systemd `StartLimitBurst=5`), `ExecStopPost=shuttled --rollback-check` swaps `.prev` back over the current binary and the service recovers.

If you're unsure whether an update succeeded, the web dashboard and Telegram bot show a "pending cleanup" badge. You can manually confirm deletion there.

---

## Manager API

### Client endpoints (HMAC-PSK auth)

All client requests are signed: `HMAC-SHA256(METHOD\nPATH\nTIMESTAMP\nHEX(SHA256(body)))` keyed by the PSK. ±5 minute timestamp window prevents replay.

| Method | Path | Description |
|---|---|---|
| POST | `/api/client/beacon` | Poll for pending actions, deliver results, update settings |
| POST | `/api/client/actions/:id/ack` | Immediate action acknowledgment |
| POST | `/api/client/actions/:id/result` | Immediate result delivery |
| POST | `/api/client/error` | Error reporting |

### Frontend endpoints (session cookie auth)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Password login, sets `shuttle_session` cookie |
| GET | `/api/servers` | List servers |
| POST | `/api/servers/:id/actions` | Create action |
| GET/PATCH | `/api/settings` | Global settings |
| POST | `/api/telegram/link` | Generate bot linking code |
| POST | `/api/telegram/webhook` | Telegram bot webhook |

---

## Telegram Bot Commands

| Command | Description |
|---|---|
| `/list` | List all active servers |
| `/server <name\|id>` | Server details |
| `/session <name\|id>` | Start terminal session |
| `/kill <name\|id>` | Kill session |
| `/exec <name\|id> <cmd>` | Run command |
| `/output <action_id>` | Get current command output |
| `/stop <name\|id>` | Stop running command |
| `/rename <name\|id> <new>` | Rename server |
| `/archive <name\|id>` | Archive server |
| `/settings` | View global settings |
| `/set <key> <value>` | Update a setting |
| `/notify <action_id> on\|off` | Toggle Telegram notification |
| `/cancel <action_id>` | Cancel pending action |
| `/resetpw <new_password>` | Reset web dashboard password |
| `/link <code>` | Link Telegram account (one-time code from web) |

> The bot silently ignores all messages not from the linked `telegram_chat_id`.

---

## Capacity

At the default 60s poll interval, one server generates ~1,440 requests/day. Cloudflare Workers Free allows 100,000 req/day → comfortable cap at ~69 servers before upgrading to Workers Paid ($5/month).

---

## Security Notes

- The PSK is shared across all clients. If extracted from one binary, all beacon endpoints are exposed. Mitigate: HMAC signing (replay-resistant), rate limiting per-server-id.
- Upterm sessions always use `--authorized-keys` — `--accept` alone is not access control.
- Web login is rate-limited: 5 attempts per 15 minutes per IP.
- Session cookies: `HttpOnly; Secure; SameSite=Strict`, 24h TTL.
- Update signing key should be kept **offline**. A compromised manager cannot substitute a different key because the public key is compiled in.
- The Telegram bot is publicly discoverable. All security relies on the strict `telegram_chat_id` allowlist server-side.

---

## Deferred Work

These are explicitly not built yet — designed to allow easy addition later:

- Per-server credentials (replacing the shared PSK) — auth abstracted behind `verifyClientAuth()`
- Self-hosted `uptermd` relay — relay address is a configurable setting from day one
- TOTP 2FA for web login — `totp_secret` column reserved in the `auth` table
- Adaptive polling / Durable Objects push channel — would reduce action delivery latency below the poll interval
