// Shuttle Manager — Global and per-server settings handlers

import type { Env, GlobalSettings } from '../types.js';
import {
  getGlobalSettings,
  setGlobalSetting,
  getServerSettingsOverride,
  setServerSettingsOverride,
  getServer,
  writeAudit,
} from '../db/queries.js';

const ALLOWED_GLOBAL_KEYS = new Set<keyof GlobalSettings>([
  'poll_interval',
  'upterm_relay',
  'authorized_keys',
  'output_cap_kb',
  'retention_days',
  'manager_primary_url',
  'manager_fallback_url',
]);

// GET /api/settings
export async function handleGetSettings(
  _request: Request,
  env: Env,
): Promise<Response> {
  const global = await getGlobalSettings(env);
  return jsonResponse({ global });
}

// PATCH /api/settings  { key: value, ... }
export async function handlePatchSettings(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<Partial<Record<keyof GlobalSettings, string | number>>>();
  const updated: string[] = [];

  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_GLOBAL_KEYS.has(k as keyof GlobalSettings)) {
      return errorResponse(`Unknown setting key: ${k}`, 400);
    }
    await setGlobalSetting(env, k, String(v));
    updated.push(k);
  }

  await writeAudit(env, 'web', 'settings_updated', updated.join(', '));
  return jsonResponse({ ok: true, updated });
}

// GET /api/servers/:id/settings
export async function handleGetServerSettings(
  _request: Request,
  env: Env,
  serverId: string,
): Promise<Response> {
  const server = await getServer(env, serverId);
  if (!server) return errorResponse('Server not found', 404);

  const global = await getGlobalSettings(env);
  const override = await getServerSettingsOverride(env, serverId);
  return jsonResponse({ global, override, merged: { ...global, ...override } });
}

// PATCH /api/servers/:id/settings  { key: value, ... } — sets per-server override
export async function handlePatchServerSettings(
  request: Request,
  env: Env,
  serverId: string,
): Promise<Response> {
  const server = await getServer(env, serverId);
  if (!server) return errorResponse('Server not found', 404);

  const body = await request.json<Partial<GlobalSettings>>();
  const current = await getServerSettingsOverride(env, serverId);

  // Merge with existing override (null value removes that key)
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_GLOBAL_KEYS.has(k as keyof GlobalSettings)) {
      return errorResponse(`Unknown setting key: ${k}`, 400);
    }
    if (v === null || v === undefined) {
      delete (current as Record<string, unknown>)[k];
    } else {
      (current as Record<string, unknown>)[k] = v;
    }
  }

  await setServerSettingsOverride(env, serverId, current);
  await writeAudit(env, 'web', 'server_settings_updated', serverId);
  return jsonResponse({ ok: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}
