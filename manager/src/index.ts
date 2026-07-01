// Shuttle Manager — Worker entry point + router

import { Router, error } from 'itty-router';
import type { Env } from './types.js';
import { verifyClientAuth, verifySessionAuth } from './auth/psk.js';
import { handleBeacon, handleAck, handleResult, handleClientError } from './handlers/client.js';
import { handleLogin, handleLogout, handleChangePassword } from './handlers/auth.js';
import { handleListServers, handleGetServer, handlePatchServer, handleDeleteServer } from './handlers/servers.js';
import { handleCreateAction, handleListActions, handleGetAction, handleCancelAction } from './handlers/actions.js';
import { handleGetSettings, handlePatchSettings, handleGetServerSettings, handlePatchServerSettings } from './handlers/settings.js';
import { handleTelegramWebhook, handleTelegramLink } from './handlers/telegram.js';

const router = Router();

// ─── Client-facing endpoints (PSK auth) ────────────────────────────────────────

router.post('/api/client/beacon', async (req: Request, env: Env) => {
  const body = await req.clone().json<{ server_id?: string }>();
  const serverId = body.server_id ?? '';
  const auth = await verifyClientAuth(req, env, serverId);
  if (!auth.ok) return error(401, `Unauthorized: ${auth.reason}`);
  return handleBeacon(req, env);
});

router.post('/api/client/actions/:id/ack', async (req: Request, env: Env, { params }: { params: Record<string, string> }) => {
  const body = await req.clone().json<{ server_id?: string }>();
  const serverId = body.server_id ?? '';
  const auth = await verifyClientAuth(req, env, serverId);
  if (!auth.ok) return error(401, `Unauthorized: ${auth.reason}`);
  return handleAck(req, env, params.id);
});

router.post('/api/client/actions/:id/result', async (req: Request, env: Env, { params }: { params: Record<string, string> }) => {
  const body = await req.clone().json<{ server_id?: string }>();
  const serverId = body.server_id ?? '';
  const auth = await verifyClientAuth(req, env, serverId);
  if (!auth.ok) return error(401, `Unauthorized: ${auth.reason}`);
  return handleResult(req, env, params.id);
});

router.post('/api/client/error', async (req: Request, env: Env) => {
  const body = await req.clone().json<{ server_id?: string }>();
  const serverId = body.server_id ?? '';
  const auth = await verifyClientAuth(req, env, serverId);
  if (!auth.ok) return error(401, `Unauthorized: ${auth.reason}`);
  return handleClientError(req, env);
});

// ─── Auth endpoints (no session required) ────────────────────────────────────

router.post('/api/auth/login', (req: Request, env: Env) => handleLogin(req, env));

router.post('/api/auth/logout', async (req: Request, env: Env) => {
  const authed = await verifySessionAuth(req, env);
  if (!authed) return error(401, 'Unauthorized');
  return handleLogout(req, env);
});

router.post('/api/auth/change-password', async (req: Request, env: Env) => {
  const authed = await verifySessionAuth(req, env);
  if (!authed) return error(401, 'Unauthorized');
  return handleChangePassword(req, env);
});

// ─── Frontend-facing endpoints (session auth) ────────────────────────────────

// Helper: wrap handler with session auth
function withAuth(handler: (req: Request, env: Env, params: Record<string, string>) => Promise<Response>) {
  return async (req: Request, env: Env, ctx: { params?: Record<string, string> }) => {
    const authed = await verifySessionAuth(req, env);
    if (!authed) return error(401, 'Unauthorized');
    return handler(req, env, ctx.params ?? {});
  };
}

// Servers
router.get('/api/servers', withAuth((req, env) => handleListServers(req, env)));
router.get('/api/servers/:id', withAuth((req, env, p) => handleGetServer(req, env, p.id)));
router.patch('/api/servers/:id', withAuth((req, env, p) => handlePatchServer(req, env, p.id)));
router.delete('/api/servers/:id', withAuth((req, env, p) => handleDeleteServer(req, env, p.id)));

// Actions
router.post('/api/servers/:id/actions', withAuth((req, env, p) =>
  handleCreateAction(req, env, p.id, 'web')
));
router.get('/api/servers/:id/actions', withAuth((req, env, p) => handleListActions(req, env, p.id)));
router.get('/api/servers/:id/actions/:aid', withAuth((req, env, p) => handleGetAction(req, env, p.id, p.aid)));
router.post('/api/servers/:id/actions/:aid/cancel', withAuth((req, env, p) =>
  handleCancelAction(req, env, p.id, p.aid)
));

// Settings
router.get('/api/settings', withAuth((req, env) => handleGetSettings(req, env)));
router.patch('/api/settings', withAuth((req, env) => handlePatchSettings(req, env)));
router.get('/api/servers/:id/settings', withAuth((req, env, p) => handleGetServerSettings(req, env, p.id)));
router.patch('/api/servers/:id/settings', withAuth((req, env, p) => handlePatchServerSettings(req, env, p.id)));

// Telegram
router.post('/api/telegram/link', withAuth((req, env) => handleTelegramLink(req, env)));
router.post('/api/telegram/webhook', (req: Request, env: Env) => handleTelegramWebhook(req, env));

// ─── Catch-all ────────────────────────────────────────────────────────────────

router.all('*', () => error(404, 'Not found'));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return router.fetch(request, env).catch((err: unknown) => {
      console.error('Unhandled error:', err);
      return error(500, 'Internal server error');
    });
  },

  // Cron Triggers (configured in wrangler.toml)
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runRetentionPurge(env);
    await runStalenessCheck(env);
  },
} satisfies ExportedHandler<Env>;

// ─── Cron tasks ───────────────────────────────────────────────────────────────

async function runRetentionPurge(env: Env): Promise<void> {
  const { results } = await env.SHUTTLE_DB.prepare(
    "SELECT value FROM settings_global WHERE key = 'retention_days'",
  ).all<{ value: string }>();
  const days = parseInt(results[0]?.value ?? '30', 10);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  await env.SHUTTLE_DB.prepare(
    `DELETE FROM actions WHERE created_at < ? AND status IN ('completed','failed','timed_out','stopped')`,
  ).bind(cutoff).run();
  await env.SHUTTLE_DB.prepare(
    `DELETE FROM audit_log WHERE at < ?`,
  ).bind(cutoff).run();
  await env.SHUTTLE_DB.prepare(
    `DELETE FROM sessions WHERE expires_at < ?`,
  ).bind(Math.floor(Date.now() / 1000)).run();
}

async function runStalenessCheck(env: Env): Promise<void> {
  const { results } = await env.SHUTTLE_DB.prepare(
    "SELECT value FROM settings_global WHERE key = 'poll_interval'",
  ).all<{ value: string }>();
  const pollInterval = parseInt(results[0]?.value ?? '60', 10);
  const staleThreshold = Math.floor(Date.now() / 1000) - pollInterval * 3;
  // Mark stale if last seen > 3 missed intervals ago
  await env.SHUTTLE_DB.prepare(
    `UPDATE servers SET status = 'stale'
     WHERE status = 'active' AND last_seen_at < ?`,
  ).bind(staleThreshold).run();
  // Reactivate if they've come back
  await env.SHUTTLE_DB.prepare(
    `UPDATE servers SET status = 'active'
     WHERE status = 'stale' AND last_seen_at > ?`,
  ).bind(staleThreshold).run();
}
