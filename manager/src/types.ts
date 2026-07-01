// Shuttle Manager — shared types

export interface Env {
  SHUTTLE_DB: D1Database;
  SHUTTLE_RATE: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  ENVIRONMENT?: string;
}

// ─── D1 row shapes ────────────────────────────────────────────────────────────

export interface ServerRow {
  id: string;
  name: string | null;
  first_seen_at: number;
  last_seen_at: number;
  last_ip: string | null;
  client_version: string | null;
  arch: string | null;
  status: 'active' | 'stale' | 'archived';
  current_session_id: string | null;
  current_command_id: string | null;
  settings_override: string | null; // JSON
}

export interface ActionRow {
  id: string;
  server_id: string;
  type: ActionType;
  payload: string | null; // JSON
  status: ActionStatus;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
  completed_at: number | null;
  result: string | null; // JSON
  notify_telegram: number;
  created_by: string;
}

export interface AuthRow {
  id: 1;
  password_hash: string;
  password_salt: string;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  telegram_link_expires: number | null;
  totp_secret: string | null;
}

export interface SessionRow {
  token: string;
  created_at: number;
  expires_at: number;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  event: string;
  detail: string | null;
}

// ─── Domain types ─────────────────────────────────────────────────────────────

export type ActionType =
  | 'create_session'
  | 'kill_session'
  | 'execute_cmd'
  | 'get_cmd_output'
  | 'stop_cmd'
  | 'update_client';

export type ActionStatus =
  | 'pending'
  | 'delivered'
  | 'acked'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'stopped';

export interface GlobalSettings {
  poll_interval: number;          // seconds
  upterm_relay: string;
  authorized_keys: string;
  output_cap_kb: number;
  retention_days: number;
  manager_primary_url: string;
  manager_fallback_url: string;
}

export interface ActionPayload {
  // create_session / kill_session
  session_id?: string;
  // execute_cmd
  cmd?: string;
  timeout?: number;  // seconds, 0 = unlimited
  // get_cmd_output / stop_cmd
  action_id?: string;
  // update_client
  version?: string;
  download_url?: string;
  sha256?: string;
  signature?: string; // base64 ed25519 sig
  cleanup_prev?: boolean;
}

export interface ActionResult {
  session_link?: string;
  output?: string;
  exit_code?: number;
  error?: string;
  truncated?: boolean;
  prev_exists?: boolean; // for update_client — signals .prev cleanup pending
}

// ─── API request / response shapes ───────────────────────────────────────────

export interface BeaconRequest {
  server_id: string;
  client_version: string;
  arch: string;
  ack_action_ids: string[];
  prev_binary_exists?: boolean; // signals .prev backup present after update
}

export interface BeaconResponse {
  settings: GlobalSettings;
  pending_actions: PendingAction[];
  update: UpdateInfo | null;
}

export interface PendingAction {
  id: string;
  type: ActionType;
  payload: ActionPayload;
}

export interface UpdateInfo {
  version: string;
  download_url: string;
  sha256: string;
  signature: string; // base64 ed25519 sig over sha256 hex
}

export interface AckRequest {
  server_id: string;
}

export interface ResultRequest {
  server_id: string;
  result: ActionResult;
  final_status: ActionStatus; // completed | failed | timed_out | stopped
}

export interface ErrorReport {
  server_id: string;
  action_id: string | null;
  error: string;
  context?: string;
}

export interface LoginRequest {
  password: string;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface CreateActionRequest {
  type: ActionType;
  payload?: ActionPayload;
  notify_telegram?: boolean;
}
