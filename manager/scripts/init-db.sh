#!/usr/bin/env bash
# manager/scripts/init-db.sh
# Run once after `wrangler d1 create shuttle-db` to apply schema + seed settings.
# Usage:
#   bash scripts/init-db.sh [--remote]
#
# Without --remote, executes against the local D1 instance.
# Pass --remote to apply to the deployed Cloudflare D1.
set -euo pipefail

DB_NAME="shuttle-db"
FLAG=""
if [[ "${1:-}" == "--remote" ]]; then
  FLAG="--remote"
  echo "Applying to REMOTE D1 ($DB_NAME)..."
else
  echo "Applying to LOCAL D1 ($DB_NAME)..."
fi

# 1. Apply schema
pnpm run wrangler d1 execute "$DB_NAME" $FLAG --file=../schema.sql

echo "✓ Schema applied."

# 2. Seed default settings (idempotent)
pnpm run wrangler d1 execute "$DB_NAME" $FLAG --command="
INSERT OR IGNORE INTO settings_global (key, value) VALUES
  ('poll_interval',        '60'),
  ('upterm_relay',         'ssh.uptermd.dev:22'),
  ('authorized_keys',      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICHJHU9NPqaC1JykYSkRV26RGB0HSgZuc5Wn7aD4LU46'),
  ('output_cap_kb',        '512'),
  ('retention_days',       '30'),
  ('manager_primary_url',  ''),
  ('manager_fallback_url', '');
"

echo "✓ Default settings seeded."

# 3. Seed a default auth record (password: 'changeme-immediately')
#    sha256('changeme-immediately' + 'default-salt') — REPLACE THIS via /api/auth/change-password
#    This is just a placeholder so the login endpoint doesn't error before first setup.
pnpm run wrangler d1 execute "$DB_NAME" $FLAG --command="
INSERT OR IGNORE INTO auth (id, password_hash, password_salt)
VALUES (
  1,
  'PLACEHOLDER_SET_VIA_WRANGLER_SECRET',
  'default-salt'
);
"

echo "✓ Auth row created (placeholder — change password immediately after first login)."
echo ""
echo "Next steps:"
echo "  1. wrangler secret put SHUTTLE_PSK"
echo "  2. wrangler secret put TELEGRAM_BOT_TOKEN  (if using Telegram)"
echo "  3. wrangler secret put TELEGRAM_WEBHOOK_SECRET  (if using Telegram)"
echo "  4. wrangler deploy"
echo "  5. After deploy: set initial password via Telegram /resetpw or curl the change-password endpoint"
