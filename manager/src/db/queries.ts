// Shuttle Manager — D1 query helpers

import type {
  Env,
  ServerRow,
  ActionRow,
  AuthRow,
  GlobalSettings,
  ActionStatus,
  ActionType,
} from '../types.js';

// ─── Servers ──────────────────────────────────────────────────────────────────

export async function getServer(
  env: Env,
  id: string,
): Promise<ServerRow | null> {
  return env.SHUTTLE_DB.prepare('SELECT * FROM servers WHERE id = ?')
    .bind(id)
    .first<ServerRow>();
}

export async function listServers(
  env: Env,
  includeArchived = false,
): Promise<ServerRow[]> {
  const q = includeArchived
    ? 'SELECT * FROM servers ORDER BY last_seen_at DESC'
    : "SELECT * FROM servers WHERE status != 'archived' ORDER BY last_seen_at DESC";
  const { results } = await env.SHUTTLE_DB.prepare(q).all<ServerRow>();
  return results;
}

export async function upsertServer(
  env: Env,
  id: string,
  ip: string,
  clientVersion: string,
  arch: string,
  now: number,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    `INSERT INTO servers (id, first_seen_at, last_seen_at, last_ip, client_version, arch, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at   = excluded.last_seen_at,
       last_ip        = excluded.last_ip,
       client_version = excluded.client_version,
       arch           = excluded.arch,
       status         = CASE WHEN status = 'archived' THEN 'archived' ELSE 'active' END`,
  )
    .bind(id, now, now, ip, clientVersion, arch)
    .run();
}

export async function updateServerName(
  env: Env,
  id: string,
  name: string,
): Promise<void> {
  await env.SHUTTLE_DB.prepare('UPDATE servers SET name = ? WHERE id = ?')
    .bind(name, id)
    .run();
}

export async function setServerStatus(
  env: Env,
  id: string,
  status: 'active' | 'stale' | 'archived',
): Promise<void> {
  await env.SHUTTLE_DB.prepare('UPDATE servers SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
}

export async function deleteServer(env: Env, id: string): Promise<void> {
  await env.SHUTTLE_DB.prepare('DELETE FROM servers WHERE id = ?')
    .bind(id)
    .run();
}

export async function updateServerCurrentSession(
  env: Env,
  serverId: string,
  sessionId: string | null,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    'UPDATE servers SET current_session_id = ? WHERE id = ?',
  )
    .bind(sessionId, serverId)
    .run();
}

export async function updateServerCurrentCommand(
  env: Env,
  serverId: string,
  commandId: string | null,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    'UPDATE servers SET current_command_id = ? WHERE id = ?',
  )
    .bind(commandId, serverId)
    .run();
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function getAction(
  env: Env,
  id: string,
): Promise<ActionRow | null> {
  return env.SHUTTLE_DB.prepare('SELECT * FROM actions WHERE id = ?')
    .bind(id)
    .first<ActionRow>();
}

export async function listServerActions(
  env: Env,
  serverId: string,
  limit = 50,
  offset = 0,
  statusFilter?: ActionStatus,
  typeFilter?: ActionType,
): Promise<ActionRow[]> {
  let q =
    'SELECT * FROM actions WHERE server_id = ?';
  const binds: (string | number)[] = [serverId];
  if (statusFilter) {
    q += ' AND status = ?';
    binds.push(statusFilter);
  }
  if (typeFilter) {
    q += ' AND type = ?';
    binds.push(typeFilter);
  }
  q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  binds.push(limit, offset);
  const { results } = await env.SHUTTLE_DB.prepare(q)
    .bind(...binds)
    .all<ActionRow>();
  return results;
}

export async function insertAction(
  env: Env,
  action: Omit<ActionRow, 'delivered_at' | 'acked_at' | 'completed_at' | 'result'>,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    `INSERT INTO actions
       (id, server_id, type, payload, status, created_at, notify_telegram, created_by)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(
      action.id,
      action.server_id,
      action.type,
      action.payload ?? null,
      action.created_at,
      action.notify_telegram,
      action.created_by,
    )
    .run();
}

/**
 * Atomically claim all pending actions for a server: sets status → 'delivered'.
 * Returns the claimed rows so the beacon response can include them.
 */
export async function claimPendingActions(
  env: Env,
  serverId: string,
  now: number,
): Promise<ActionRow[]> {
  // D1/SQLite RETURNING clause — atomic, no TOCTOU
  const { results } = await env.SHUTTLE_DB.prepare(
    `UPDATE actions
     SET status = 'delivered', delivered_at = ?
     WHERE server_id = ? AND status = 'pending'
     RETURNING *`,
  )
    .bind(now, serverId)
    .all<ActionRow>();
  return results;
}

export async function ackAction(
  env: Env,
  actionId: string,
  now: number,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    `UPDATE actions SET status = 'acked', acked_at = ?
     WHERE id = ? AND status IN ('delivered', 'pending')`,
  )
    .bind(now, actionId)
    .run();
}

export async function startAction(
  env: Env,
  actionId: string,
  now: number,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    `UPDATE actions SET status = 'running'
     WHERE id = ? AND status IN ('acked', 'delivered', 'pending')`,
  )
    .bind(actionId)
    .run();
  // suppress 'now' warning — kept for future use
  void now;
}

export async function completeAction(
  env: Env,
  actionId: string,
  finalStatus: ActionStatus,
  result: string, // JSON string
  now: number,
): Promise<ActionRow | null> {
  return env.SHUTTLE_DB.prepare(
    `UPDATE actions
     SET status = ?, completed_at = ?, result = ?
     WHERE id = ?
     RETURNING *`,
  )
    .bind(finalStatus, now, result, actionId)
    .first<ActionRow>();
}

export async function cancelAction(
  env: Env,
  actionId: string,
): Promise<boolean> {
  const result = await env.SHUTTLE_DB.prepare(
    `UPDATE actions SET status = 'stopped'
     WHERE id = ? AND status = 'pending'
     RETURNING id`,
  )
    .bind(actionId)
    .first<{ id: string }>();
  return result !== null;
}

export async function reAckFromBeacon(
  env: Env,
  actionIds: string[],
  now: number,
): Promise<void> {
  // Re-apply acks for any that missed their immediate POST
  for (const id of actionIds) {
    await ackAction(env, id, now);
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getGlobalSettings(
  env: Env,
): Promise<GlobalSettings> {
  const { results } = await env.SHUTTLE_DB.prepare(
    'SELECT key, value FROM settings_global',
  ).all<{ key: string; value: string }>();

  const map: Record<string, string> = {};
  for (const row of results) map[row.key] = row.value;

  return {
    poll_interval:        parseInt(map.poll_interval ?? '60', 10),
    upterm_relay:         map.upterm_relay ?? 'ssh.uptermd.dev:22',
    authorized_keys:      map.authorized_keys ?? '',
    output_cap_kb:        parseInt(map.output_cap_kb ?? '512', 10),
    retention_days:       parseInt(map.retention_days ?? '30', 10),
    manager_primary_url:  map.manager_primary_url ?? '',
    manager_fallback_url: map.manager_fallback_url ?? '',
  };
}

export async function setGlobalSetting(
  env: Env,
  key: string,
  value: string,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    'INSERT OR REPLACE INTO settings_global (key, value) VALUES (?, ?)',
  )
    .bind(key, value)
    .run();
}

export async function getServerSettingsOverride(
  env: Env,
  serverId: string,
): Promise<Partial<GlobalSettings>> {
  const row = await env.SHUTTLE_DB.prepare(
    'SELECT settings_override FROM servers WHERE id = ?',
  )
    .bind(serverId)
    .first<{ settings_override: string | null }>();
  if (!row?.settings_override) return {};
  try {
    return JSON.parse(row.settings_override) as Partial<GlobalSettings>;
  } catch {
    return {};
  }
}

export async function setServerSettingsOverride(
  env: Env,
  serverId: string,
  override: Partial<GlobalSettings>,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    'UPDATE servers SET settings_override = ? WHERE id = ?',
  )
    .bind(JSON.stringify(override), serverId)
    .run();
}

export function mergeSettings(
  global: GlobalSettings,
  override: Partial<GlobalSettings>,
): GlobalSettings {
  return { ...global, ...override };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function getAuth(env: Env): Promise<AuthRow | null> {
  return env.SHUTTLE_DB.prepare('SELECT * FROM auth WHERE id = 1').first<AuthRow>();
}

export async function setAuth(
  env: Env,
  passwordHash: string,
  passwordSalt: string,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    `INSERT INTO auth (id, password_hash, password_salt)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       password_hash = excluded.password_hash,
       password_salt = excluded.password_salt`,
  )
    .bind(passwordHash, passwordSalt)
    .run();
}

export async function setTelegramChatId(
  env: Env,
  chatId: string,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    `UPDATE auth SET telegram_chat_id = ?, telegram_link_code = NULL,
       telegram_link_expires = NULL WHERE id = 1`,
  )
    .bind(chatId)
    .run();
}

export async function setTelegramLinkCode(
  env: Env,
  code: string,
  expiresAt: number,
): Promise<void> {
  await env.SHUTTLE_DB.prepare(
    'UPDATE auth SET telegram_link_code = ?, telegram_link_expires = ? WHERE id = 1',
  )
    .bind(code, expiresAt)
    .run();
}

// ─── Sessions (operator web sessions) ─────────────────────────────────────────

export async function createSession(
  env: Env,
  token: string,
  now: number,
): Promise<void> {
  const expiresAt = now + 86400; // 24h TTL
  await env.SHUTTLE_DB.prepare(
    'INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)',
  )
    .bind(token, now, expiresAt)
    .run();
}

export async function getSession(
  env: Env,
  token: string,
  now: number,
): Promise<boolean> {
  const row = await env.SHUTTLE_DB.prepare(
    'SELECT token FROM sessions WHERE token = ? AND expires_at > ?',
  )
    .bind(token, now)
    .first<{ token: string }>();
  return row !== null;
}

export async function deleteSession(
  env: Env,
  token: string,
): Promise<void> {
  await env.SHUTTLE_DB.prepare('DELETE FROM sessions WHERE token = ?')
    .bind(token)
    .run();
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export async function writeAudit(
  env: Env,
  actor: string,
  event: string,
  detail?: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.SHUTTLE_DB.prepare(
    'INSERT INTO audit_log (at, actor, event, detail) VALUES (?, ?, ?, ?)',
  )
    .bind(now, actor, event, detail ?? null)
    .run();
}
