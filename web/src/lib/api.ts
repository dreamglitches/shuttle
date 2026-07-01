// Shuttle Web — Typed API client
// All requests go through these functions. Errors surface as thrown objects
// with { error: string }. Session links and output are never put in URLs.

const BASE = '';  // same-origin — manager serves both API and static assets

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let err = `HTTP ${res.status}`;
    try { const j = await res.json(); err = j.error ?? err; } catch {}
    throw { error: err, status: res.status };
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const get  = <T>(path: string)                  => req<T>('GET',    path);
const post = <T>(path: string, body?: unknown)   => req<T>('POST',   path, body);
const patch = <T>(path: string, body?: unknown)  => req<T>('PATCH',  path, body);
const del   = <T>(path: string, body?: unknown)  => req<T>('DELETE', path, body);

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const auth = {
  login:          (password: string)                            => post('/api/auth/login', { password }),
  logout:         ()                                            => post('/api/auth/logout'),
  changePassword: (current: string, next: string)              =>
    post('/api/auth/change-password', { current_password: current, new_password: next }),
};

// ─── Servers ──────────────────────────────────────────────────────────────────
export const servers = {
  list:    (archived = false) => get<Server[]>(`/api/servers${archived ? '?archived=true' : ''}`),
  get:     (id: string)       => get<Server>(`/api/servers/${id}`),
  rename:  (id: string, name: string) => patch(`/api/servers/${id}`, { name }),
  archive: (id: string)       => del(`/api/servers/${id}`),
  delete:  (id: string)       => del(`/api/servers/${id}?confirm=true`),
};

// ─── Actions ──────────────────────────────────────────────────────────────────
export const actions = {
  list:   (serverId: string, opts?: { status?: string; type?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.type)   params.set('type', opts.type);
    if (opts?.limit)  params.set('limit', String(opts.limit));
    const qs = params.toString();
    return get<Action[]>(`/api/servers/${serverId}/actions${qs ? '?' + qs : ''}`);
  },
  get:    (serverId: string, actionId: string) => get<Action>(`/api/servers/${serverId}/actions/${actionId}`),
  create: (serverId: string, req: CreateActionRequest) =>
    post<{ id: string; status: string }>(`/api/servers/${serverId}/actions`, req),
  cancel: (serverId: string, actionId: string) =>
    post(`/api/servers/${serverId}/actions/${actionId}/cancel`),

  // Convenience helpers
  createSession:  (serverId: string, notify = false) =>
    actions.create(serverId, { type: 'create_session', notify_telegram: notify }),
  killSession:    (serverId: string, notify = false) =>
    actions.create(serverId, { type: 'kill_session', notify_telegram: notify }),
  execCmd:        (serverId: string, cmd: string, timeout?: number, notify = false) =>
    actions.create(serverId, { type: 'execute_cmd', payload: { cmd, timeout }, notify_telegram: notify }),
  stopCmd:        (serverId: string, actionId: string) =>
    actions.create(serverId, { type: 'stop_cmd', payload: { action_id: actionId } }),
  getOutput:      (serverId: string, actionId: string) =>
    actions.create(serverId, { type: 'get_cmd_output', payload: { action_id: actionId } }),
};

// ─── Settings ─────────────────────────────────────────────────────────────────
export const settings = {
  getGlobal:    ()                              => get<{ global: GlobalSettings }>('/api/settings'),
  patchGlobal:  (updates: Partial<GlobalSettings>) => patch('/api/settings', updates),
  getServer:    (id: string)                    => get<ServerSettings>(`/api/servers/${id}/settings`),
  patchServer:  (id: string, updates: Partial<GlobalSettings>) =>
    patch(`/api/servers/${id}/settings`, updates),
};

// ─── Telegram ─────────────────────────────────────────────────────────────────
export const telegram = {
  generateLink: () => post<{ code: string; expires_in_seconds: number }>('/api/telegram/link'),
};

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Server {
  id: string;
  name: string | null;
  status: 'active' | 'stale' | 'archived';
  first_seen_at: number;
  last_seen_at: number;
  last_ip: string | null;
  client_version: string | null;
  arch: string | null;
  current_session_id: string | null;
  current_command_id: string | null;
  settings_override: Partial<GlobalSettings> | null;
}

export interface Action {
  id: string;
  server_id: string;
  type: ActionType;
  payload: Record<string, unknown> | null;
  status: ActionStatus;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
  completed_at: number | null;
  result: ActionResult | null;
  notify_telegram: boolean;
  created_by: string;
}

export interface ActionResult {
  session_link?: string;
  output?: string;
  exit_code?: number;
  error?: string;
  truncated?: boolean;
  prev_exists?: boolean;
}

export type ActionType =
  | 'create_session' | 'kill_session'
  | 'execute_cmd' | 'get_cmd_output' | 'stop_cmd'
  | 'update_client';

export type ActionStatus =
  | 'pending' | 'delivered' | 'acked' | 'running'
  | 'completed' | 'failed' | 'timed_out' | 'stopped';

export interface GlobalSettings {
  poll_interval: number;
  upterm_relay: string;
  authorized_keys: string;
  output_cap_kb: number;
  retention_days: number;
  manager_primary_url: string;
  manager_fallback_url: string;
}

export interface ServerSettings {
  global: GlobalSettings;
  override: Partial<GlobalSettings>;
  merged: GlobalSettings;
}

export interface CreateActionRequest {
  type: ActionType;
  payload?: Record<string, unknown>;
  notify_telegram?: boolean;
}
