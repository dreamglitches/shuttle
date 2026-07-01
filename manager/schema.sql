-- Shuttle Manager — D1 Schema
-- Apply with: wrangler d1 execute shuttle-db --file=schema.sql

CREATE TABLE IF NOT EXISTS servers (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  last_ip           TEXT,
  client_version    TEXT,
  arch              TEXT,
  status            TEXT NOT NULL DEFAULT 'active', -- active | stale | archived
  current_session_id TEXT,
  current_command_id TEXT,
  settings_override TEXT  -- JSON blob, per-server overrides
);

CREATE TABLE IF NOT EXISTS actions (
  id              TEXT PRIMARY KEY,
  server_id       TEXT NOT NULL,
  type            TEXT NOT NULL, -- create_session|kill_session|execute_cmd|get_cmd_output|stop_cmd|update_client
  payload         TEXT,          -- JSON, action-specific params
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|delivered|acked|running|completed|failed|timed_out|stopped
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER,
  acked_at        INTEGER,
  completed_at    INTEGER,
  result          TEXT,          -- JSON: output, exit_code, error, session_link, etc.
  notify_telegram INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL DEFAULT 'web' -- web | telegram | system
);

CREATE INDEX IF NOT EXISTS idx_actions_server_status ON actions(server_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_created       ON actions(created_at);
CREATE INDEX IF NOT EXISTS idx_actions_server_type   ON actions(server_id, type, status);

CREATE TABLE IF NOT EXISTS settings_global (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed default global settings (INSERT OR IGNORE so re-running is safe)
INSERT OR IGNORE INTO settings_global (key, value) VALUES
  ('poll_interval',        '60'),
  ('upterm_relay',         'ssh.uptermd.dev:22'),
  ('authorized_keys',      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICHJHU9NPqaC1JykYSkRV26RGB0HSgZuc5Wn7aD4LU46'),
  ('output_cap_kb',        '512'),
  ('retention_days',       '30'),
  ('manager_primary_url',  ''),
  ('manager_fallback_url', '');

CREATE TABLE IF NOT EXISTS auth (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  telegram_chat_id TEXT,
  telegram_link_code TEXT,         -- ephemeral code for /link flow
  telegram_link_expires INTEGER,   -- unix ts
  totp_secret    TEXT              -- reserved for future 2FA
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,  -- 'web' | 'telegram' | 'client:<server_id>'
  event  TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
