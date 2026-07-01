// Shuttle Manager — Action create / cancel / history handlers

import type {
  Env,
  ActionRow,
  ActionType,
  ActionStatus,
  CreateActionRequest,
} from '../types.js';
import {
  getServer,
  getAction,
  listServerActions,
  insertAction,
  cancelAction,
  writeAudit,
  updateServerCurrentCommand,
} from '../db/queries.js';

// POST /api/servers/:id/actions
export async function handleCreateAction(
  request: Request,
  env: Env,
  serverId: string,
  createdBy: 'web' | 'telegram',
): Promise<Response> {
  const server = await getServer(env, serverId);
  if (!server) return errorResponse('Server not found', 404);
  if (server.status === 'archived') {
    return errorResponse('Cannot create actions for archived server', 409);
  }

  const body = await request.json<CreateActionRequest>();

  if (!isValidActionType(body.type)) {
    return errorResponse(`Unknown action type: ${body.type}`, 400);
  }

  // Concurrency guard: only one execute_cmd at a time per server
  if (body.type === 'execute_cmd') {
    if (server.current_command_id) {
      return errorResponse(
        `Server is busy: command ${server.current_command_id} is still running`,
        409,
      );
    }
  }

  // Only one session at a time
  if (body.type === 'create_session') {
    if (server.current_session_id) {
      return errorResponse(
        `Server already has an active session: ${server.current_session_id}`,
        409,
      );
    }
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await insertAction(env, {
    id,
    server_id: serverId,
    type: body.type,
    payload: body.payload ? JSON.stringify(body.payload) : null,
    status: 'pending',
    created_at: now,
    notify_telegram: body.notify_telegram ? 1 : 0,
    created_by: createdBy,
  });

  // If execute_cmd, mark server as having an in-flight command atomically
  if (body.type === 'execute_cmd') {
    await updateServerCurrentCommand(env, serverId, id);
  }

  await writeAudit(
    env,
    createdBy,
    'action_created',
    `${body.type} for ${serverId} [${id}]`,
  );

  return jsonResponse({ id, status: 'pending' }, 201);
}

// GET /api/servers/:id/actions
export async function handleListActions(
  request: Request,
  env: Env,
  serverId: string,
): Promise<Response> {
  const server = await getServer(env, serverId);
  if (!server) return errorResponse('Server not found', 404);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const statusFilter = url.searchParams.get('status') as ActionStatus | null;
  const typeFilter = url.searchParams.get('type') as ActionType | null;

  const actions = await listServerActions(
    env,
    serverId,
    limit,
    offset,
    statusFilter ?? undefined,
    typeFilter ?? undefined,
  );

  return jsonResponse(actions.map(serializeAction));
}

// GET /api/servers/:id/actions/:aid
export async function handleGetAction(
  _request: Request,
  env: Env,
  _serverId: string,
  actionId: string,
): Promise<Response> {
  const action = await getAction(env, actionId);
  if (!action) return errorResponse('Action not found', 404);
  return jsonResponse(serializeAction(action));
}

// POST /api/servers/:id/actions/:aid/cancel
export async function handleCancelAction(
  _request: Request,
  env: Env,
  serverId: string,
  actionId: string,
): Promise<Response> {
  const action = await getAction(env, actionId);
  if (!action) return errorResponse('Action not found', 404);
  if (action.server_id !== serverId) return errorResponse('Action not found', 404);

  const cancelled = await cancelAction(env, actionId);
  if (!cancelled) {
    return errorResponse(
      `Cannot cancel action in status '${action.status}'. Only pending actions can be cancelled.`,
      409,
    );
  }

  await writeAudit(env, 'web', 'action_cancelled', actionId);
  return jsonResponse({ ok: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ACTION_TYPES: ActionType[] = [
  'create_session',
  'kill_session',
  'execute_cmd',
  'get_cmd_output',
  'stop_cmd',
  'update_client',
];

function isValidActionType(t: string): t is ActionType {
  return VALID_ACTION_TYPES.includes(t as ActionType);
}

function serializeAction(row: ActionRow) {
  return {
    id: row.id,
    server_id: row.server_id,
    type: row.type,
    payload: row.payload ? JSON.parse(row.payload) : null,
    status: row.status,
    created_at: row.created_at,
    delivered_at: row.delivered_at,
    acked_at: row.acked_at,
    completed_at: row.completed_at,
    result: row.result ? JSON.parse(row.result) : null,
    notify_telegram: row.notify_telegram === 1,
    created_by: row.created_by,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}
