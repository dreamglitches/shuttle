// Shuttle Manager — Client-facing handlers (beacon, ack, result, error)

import type {
  Env,
  BeaconRequest,
  BeaconResponse,
  AckRequest,
  ResultRequest,
  ErrorReport,
  PendingAction,
  ActionPayload,
  ActionResult,
} from '../types.js';
import {
  upsertServer,
  claimPendingActions,
  reAckFromBeacon,
  ackAction,
  completeAction,
  getGlobalSettings,
  getServerSettingsOverride,
  mergeSettings,
  writeAudit,
  updateServerCurrentSession,
  updateServerCurrentCommand,
} from '../db/queries.js';
import { sendTelegramNotification } from '../telegram/notify.js';

export function clientIP(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

// POST /api/client/beacon
export async function handleBeacon(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<BeaconRequest>();
  const now = Math.floor(Date.now() / 1000);
  const ip = clientIP(request);

  // Upsert server record
  await upsertServer(env, body.server_id, ip, body.client_version, body.arch, now);

  // Re-apply any acks the client says it missed
  if (body.ack_action_ids?.length) {
    await reAckFromBeacon(env, body.ack_action_ids, now);
  }

  // Claim pending actions atomically
  const claimedRows = await claimPendingActions(env, body.server_id, now);
  const pending_actions: PendingAction[] = claimedRows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload ? (JSON.parse(row.payload) as ActionPayload) : {},
  }));

  // Build merged settings for this server
  const global = await getGlobalSettings(env);
  const override = await getServerSettingsOverride(env, body.server_id);
  const settings = mergeSettings(global, override);

  // Check if update is available (from settings_global update_* keys)
  // Placeholder — populated when update mechanism is built in Phase 4
  const update = null;

  const response: BeaconResponse = { settings, pending_actions, update };
  return jsonResponse(response);
}

// POST /api/client/actions/:id/ack
export async function handleAck(
  request: Request,
  env: Env,
  actionId: string,
): Promise<Response> {
  const body = await request.json<AckRequest>();
  const now = Math.floor(Date.now() / 1000);
  await ackAction(env, actionId, now);
  await writeAudit(env, `client:${body.server_id}`, 'action_acked', actionId);
  return jsonResponse({ ok: true });
}

// POST /api/client/actions/:id/result
export async function handleResult(
  request: Request,
  env: Env,
  actionId: string,
): Promise<Response> {
  const body = await request.json<ResultRequest>();
  const now = Math.floor(Date.now() / 1000);

  // Enforce output size cap
  const global = await getGlobalSettings(env);
  const outputCapBytes = global.output_cap_kb * 1024;
  const result = enforceOutputCap(body.result, outputCapBytes);

  const actionRow = await completeAction(
    env,
    actionId,
    body.final_status,
    JSON.stringify(result),
    now,
  );

  if (actionRow) {
    // Update server's current_session_id / current_command_id
    if (
      actionRow.type === 'create_session' &&
      body.final_status === 'completed' &&
      result.session_link
    ) {
      await updateServerCurrentSession(env, body.server_id, actionId);
    } else if (
      actionRow.type === 'kill_session' ||
      (actionRow.type === 'create_session' && body.final_status !== 'completed')
    ) {
      await updateServerCurrentSession(env, body.server_id, null);
    }

    if (
      actionRow.type === 'execute_cmd' &&
      ['completed', 'failed', 'timed_out', 'stopped'].includes(body.final_status)
    ) {
      await updateServerCurrentCommand(env, body.server_id, null);
    }

    // Telegram notification
    if (actionRow.notify_telegram) {
      await sendTelegramNotification(env, actionRow, result);
    }
  }

  await writeAudit(
    env,
    `client:${body.server_id}`,
    'action_result',
    `${actionId} → ${body.final_status}`,
  );

  return jsonResponse({ ok: true });
}

// POST /api/client/error
export async function handleClientError(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<ErrorReport>();
  await writeAudit(
    env,
    `client:${body.server_id}`,
    'client_error',
    JSON.stringify({ action_id: body.action_id, error: body.error, context: body.context }),
  );
  return jsonResponse({ ok: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function enforceOutputCap(result: ActionResult, capBytes: number): ActionResult {
  if (!result.output) return result;
  const enc = new TextEncoder();
  const bytes = enc.encode(result.output);
  if (bytes.length <= capBytes) return result;
  const marker = `\n[...truncated at ${Math.round(capBytes / 1024)} KB]`;
  const truncated = new TextDecoder().decode(bytes.slice(0, capBytes - enc.encode(marker).length));
  return { ...result, output: truncated + marker, truncated: true };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
