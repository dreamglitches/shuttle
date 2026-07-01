// Shuttle Manager — Server lifecycle handlers

import type { Env, ServerRow } from '../types.js';
import {
  listServers,
  getServer,
  updateServerName,
  setServerStatus,
  deleteServer,
  writeAudit,
} from '../db/queries.js';

// GET /api/servers
export async function handleListServers(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get('archived') === 'true';
  const servers = await listServers(env, includeArchived);
  return jsonResponse(servers.map(serializeServer));
}

// GET /api/servers/:id
export async function handleGetServer(
  _request: Request,
  env: Env,
  serverId: string,
): Promise<Response> {
  const server = await getServer(env, serverId);
  if (!server) return notFound();
  return jsonResponse(serializeServer(server));
}

// PATCH /api/servers/:id  { name?: string }
export async function handlePatchServer(
  request: Request,
  env: Env,
  serverId: string,
): Promise<Response> {
  const server = await getServer(env, serverId);
  if (!server) return notFound();

  const body = await request.json<{ name?: string }>();
  if (typeof body.name === 'string') {
    await updateServerName(env, serverId, body.name.trim().slice(0, 64));
    await writeAudit(env, 'web', 'server_renamed', `${serverId} → "${body.name}"`);
  }
  return jsonResponse({ ok: true });
}

// DELETE /api/servers/:id
// ?confirm=true performs hard delete (only allowed if already archived)
// Without flag: archives the server
export async function handleDeleteServer(
  request: Request,
  env: Env,
  serverId: string,
): Promise<Response> {
  const server = await getServer(env, serverId);
  if (!server) return notFound();

  const url = new URL(request.url);
  const hardDelete = url.searchParams.get('confirm') === 'true';

  if (hardDelete) {
    if (server.status !== 'archived') {
      return errorResponse(
        'Server must be archived before hard-delete. Send DELETE without ?confirm=true first.',
        409,
      );
    }
    await deleteServer(env, serverId);
    await writeAudit(env, 'web', 'server_deleted', serverId);
    return jsonResponse({ ok: true });
  }

  // Archive step
  await setServerStatus(env, serverId, 'archived');
  await writeAudit(env, 'web', 'server_archived', serverId);
  return jsonResponse({ ok: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function serializeServer(row: ServerRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    last_ip: row.last_ip,
    client_version: row.client_version,
    arch: row.arch,
    current_session_id: row.current_session_id,
    current_command_id: row.current_command_id,
    settings_override: row.settings_override
      ? JSON.parse(row.settings_override)
      : null,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(): Response {
  return errorResponse('Server not found', 404);
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}
