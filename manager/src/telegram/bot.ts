// Shuttle Manager — Telegram bot command dispatcher (full manager access)

import type { Env } from '../types.js';
import { sendText } from '../handlers/telegram.js';
import {
  listServers,
  getServer,
  listServerActions,
  insertAction,
  cancelAction,
  updateServerName,
  setServerStatus,
  getGlobalSettings,
  setGlobalSetting,
  writeAudit,
  updateServerCurrentCommand,
  setAuth,
} from '../db/queries.js';
import { hashPassword, generateSalt } from '../auth/psk.js';

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; from?: { id: number }; chat: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; message?: { chat: { id: number } }; data?: string };
}

export async function handleBotMessage(
  env: Env,
  update: TelegramUpdate,
  chatId: string,
  _fromId: string,
): Promise<void> {
  const text = update.message?.text?.trim() ?? update.callback_query?.data ?? '';
  if (!text) return;

  const [cmd, ...args] = text.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case '/list':
    case '/ls':
      await cmdList(env, chatId);
      break;
    case '/server':
      await cmdServer(env, chatId, args[0]);
      break;
    case '/session':
      await cmdSession(env, chatId, args[0]);
      break;
    case '/kill':
      await cmdKill(env, chatId, args[0]);
      break;
    case '/exec':
      await cmdExec(env, chatId, args[0], args.slice(1).join(' '));
      break;
    case '/output':
      await cmdOutput(env, chatId, args[0]);
      break;
    case '/stop':
      await cmdStop(env, chatId, args[0]);
      break;
    case '/rename':
      await cmdRename(env, chatId, args[0], args[1]);
      break;
    case '/archive':
      await cmdArchive(env, chatId, args[0]);
      break;
    case '/settings':
      await cmdSettings(env, chatId);
      break;
    case '/set':
      await cmdSet(env, chatId, args[0], args.slice(1).join(' '));
      break;
    case '/notify':
      await cmdNotify(env, chatId, args[0], args[1]);
      break;
    case '/resetpw':
      await cmdResetPassword(env, chatId, args[0]);
      break;
    case '/cancel':
      await cmdCancelAction(env, chatId, args[0]);
      break;
    case '/help':
      await cmdHelp(env, chatId);
      break;
    default:
      await sendText(env, chatId, `Unknown command. Send /help for the command list.`);
  }
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdList(env: Env, chatId: string): Promise<void> {
  const servers = await listServers(env, false);
  if (!servers.length) {
    await sendText(env, chatId, 'No active servers.');
    return;
  }
  const lines = servers.map((s) => {
    const name = s.name ?? s.id.slice(0, 12);
    const ago = formatAgo(s.last_seen_at);
    const icon = s.status === 'active' ? '🟢' : s.status === 'stale' ? '🟡' : '⚫';
    const session = s.current_session_id ? ' [session]' : '';
    const cmd = s.current_command_id ? ' [cmd]' : '';
    return `${icon} <b>${name}</b> · ${s.arch ?? '?'} · ${ago}${session}${cmd}`;
  });
  await sendText(env, chatId, `<b>Fleet (${servers.length})</b>\n\n${lines.join('\n')}`);
}

async function cmdServer(env: Env, chatId: string, nameOrId: string): Promise<void> {
  if (!nameOrId) { await sendText(env, chatId, 'Usage: /server &lt;name|id&gt;'); return; }
  const server = await resolveServer(env, nameOrId);
  if (!server) { await sendText(env, chatId, `Server not found: ${nameOrId}`); return; }
  const lines = [
    `<b>${server.name ?? server.id.slice(0, 16)}</b>`,
    `ID: <code>${server.id}</code>`,
    `Status: ${server.status}`,
    `Arch: ${server.arch ?? 'unknown'}`,
    `Version: ${server.client_version ?? 'unknown'}`,
    `Last IP: ${server.last_ip ?? 'unknown'}`,
    `Last seen: ${formatAgo(server.last_seen_at)}`,
    `Session: ${server.current_session_id ?? 'none'}`,
    `Command: ${server.current_command_id ?? 'none'}`,
  ];
  await sendText(env, chatId, lines.join('\n'));
}

async function cmdSession(env: Env, chatId: string, nameOrId: string): Promise<void> {
  if (!nameOrId) { await sendText(env, chatId, 'Usage: /session &lt;name|id&gt;'); return; }
  const server = await resolveServer(env, nameOrId);
  if (!server) { await sendText(env, chatId, `Server not found: ${nameOrId}`); return; }
  if (server.current_session_id) {
    await sendText(env, chatId, `⚠️ Server already has an active session.\nUse /kill ${nameOrId} first.`);
    return;
  }
  const id = await createAction(env, server.id, 'create_session', {}, 1);
  await writeAudit(env, 'telegram', 'action_created', `create_session for ${server.id}`);
  await sendText(env, chatId, `✅ Session requested (action <code>${id.slice(0, 12)}</code>)\nYou'll be notified when it's ready.`);
}

async function cmdKill(env: Env, chatId: string, nameOrId: string): Promise<void> {
  if (!nameOrId) { await sendText(env, chatId, 'Usage: /kill &lt;name|id&gt;'); return; }
  const server = await resolveServer(env, nameOrId);
  if (!server) { await sendText(env, chatId, `Server not found: ${nameOrId}`); return; }
  const id = await createAction(env, server.id, 'kill_session', {}, 0);
  await writeAudit(env, 'telegram', 'action_created', `kill_session for ${server.id}`);
  await sendText(env, chatId, `🛑 Kill requested (action <code>${id.slice(0, 12)}</code>)`);
}

async function cmdExec(env: Env, chatId: string, nameOrId: string, cmd: string): Promise<void> {
  if (!nameOrId || !cmd) {
    await sendText(env, chatId, 'Usage: /exec &lt;name|id&gt; &lt;command&gt;');
    return;
  }
  const server = await resolveServer(env, nameOrId);
  if (!server) { await sendText(env, chatId, `Server not found: ${nameOrId}`); return; }
  if (server.current_command_id) {
    await sendText(env, chatId, `⚠️ Server is busy running command <code>${server.current_command_id.slice(0, 12)}</code>\nUse /stop to stop it first.`);
    return;
  }
  const id = await createAction(env, server.id, 'execute_cmd', { cmd }, 1);
  await updateServerCurrentCommand(env, server.id, id);
  await writeAudit(env, 'telegram', 'action_created', `execute_cmd for ${server.id}: ${cmd.slice(0, 80)}`);
  await sendText(env, chatId, `▶️ Command dispatched (action <code>${id.slice(0, 12)}</code>)\n<code>${escapeHtml(cmd)}</code>\nYou'll be notified when it finishes.`);
}

async function cmdOutput(env: Env, chatId: string, actionId: string): Promise<void> {
  if (!actionId) { await sendText(env, chatId, 'Usage: /output &lt;action_id&gt;'); return; }
  // Request current output snapshot from client
  // We create a get_cmd_output action referencing the original
  // (simplified: just report last result from DB)
  const actions = await listServerActions(env, '', 1, 0, 'running');
  const action = actions.find((a) => a.id.startsWith(actionId));
  if (!action) {
    await sendText(env, chatId, `No running action found matching <code>${actionId}</code>`);
    return;
  }
  const result = action.result ? JSON.parse(action.result) : null;
  const output = result?.output ?? '(no output yet)';
  await sendText(env, chatId, `Output for <code>${action.id.slice(0, 12)}</code>:\n<pre>${escapeHtml(output.slice(-1500))}</pre>`);
}

async function cmdStop(env: Env, chatId: string, nameOrId: string): Promise<void> {
  if (!nameOrId) { await sendText(env, chatId, 'Usage: /stop &lt;name|id&gt;'); return; }
  const server = await resolveServer(env, nameOrId);
  if (!server) { await sendText(env, chatId, `Server not found: ${nameOrId}`); return; }
  if (!server.current_command_id) {
    await sendText(env, chatId, `No running command on this server.`);
    return;
  }
  const id = await createAction(env, server.id, 'stop_cmd', { action_id: server.current_command_id }, 0);
  await writeAudit(env, 'telegram', 'action_created', `stop_cmd for ${server.id}`);
  await sendText(env, chatId, `🛑 Stop requested (action <code>${id.slice(0, 12)}</code>)`);
}

async function cmdRename(env: Env, chatId: string, nameOrId: string, newName: string): Promise<void> {
  if (!nameOrId || !newName) { await sendText(env, chatId, 'Usage: /rename &lt;name|id&gt; &lt;new_name&gt;'); return; }
  const server = await resolveServer(env, nameOrId);
  if (!server) { await sendText(env, chatId, `Server not found: ${nameOrId}`); return; }
  await updateServerName(env, server.id, newName.slice(0, 64));
  await writeAudit(env, 'telegram', 'server_renamed', `${server.id} → "${newName}"`);
  await sendText(env, chatId, `✅ Renamed to <b>${escapeHtml(newName)}</b>`);
}

async function cmdArchive(env: Env, chatId: string, nameOrId: string): Promise<void> {
  if (!nameOrId) { await sendText(env, chatId, 'Usage: /archive &lt;name|id&gt;'); return; }
  const server = await resolveServer(env, nameOrId);
  if (!server) { await sendText(env, chatId, `Server not found: ${nameOrId}`); return; }
  await setServerStatus(env, server.id, 'archived');
  await writeAudit(env, 'telegram', 'server_archived', server.id);
  await sendText(env, chatId, `⚫ Server archived.`);
}

async function cmdSettings(env: Env, chatId: string): Promise<void> {
  const s = await getGlobalSettings(env);
  const lines = [
    `<b>Global Settings</b>`,
    `poll_interval: <code>${s.poll_interval}s</code>`,
    `upterm_relay: <code>${s.upterm_relay}</code>`,
    `output_cap_kb: <code>${s.output_cap_kb} KB</code>`,
    `retention_days: <code>${s.retention_days} days</code>`,
    `authorized_keys: <code>${s.authorized_keys.slice(0, 40)}…</code>`,
    `manager_primary: <code>${s.manager_primary_url || '(not set)'}</code>`,
    `manager_fallback: <code>${s.manager_fallback_url || '(not set)'}</code>`,
  ];
  await sendText(env, chatId, lines.join('\n'));
}

async function cmdSet(env: Env, chatId: string, key: string, value: string): Promise<void> {
  if (!key || !value) { await sendText(env, chatId, 'Usage: /set &lt;key&gt; &lt;value&gt;'); return; }
  const allowed = ['poll_interval', 'upterm_relay', 'output_cap_kb', 'retention_days', 'manager_primary_url', 'manager_fallback_url'];
  if (!allowed.includes(key)) {
    await sendText(env, chatId, `Unknown key. Allowed: ${allowed.join(', ')}`);
    return;
  }
  await setGlobalSetting(env, key, value);
  await writeAudit(env, 'telegram', 'settings_updated', `${key}=${value}`);
  await sendText(env, chatId, `✅ Set <code>${key}</code> = <code>${escapeHtml(value)}</code>`);
}

async function cmdNotify(env: Env, chatId: string, actionId: string, onOff: string): Promise<void> {
  if (!actionId || !['on', 'off'].includes(onOff?.toLowerCase())) {
    await sendText(env, chatId, 'Usage: /notify &lt;action_id&gt; on|off');
    return;
  }
  const val = onOff.toLowerCase() === 'on' ? 1 : 0;
  await env.SHUTTLE_DB.prepare(
    "UPDATE actions SET notify_telegram = ? WHERE id LIKE ?",
  ).bind(val, `${actionId}%`).run();
  await sendText(env, chatId, `🔔 Notifications ${val ? 'enabled' : 'disabled'} for action <code>${actionId}</code>`);
}

async function cmdCancelAction(env: Env, chatId: string, actionId: string): Promise<void> {
  if (!actionId) { await sendText(env, chatId, 'Usage: /cancel &lt;action_id&gt;'); return; }
  const cancelled = await cancelAction(env, actionId);
  if (cancelled) {
    await sendText(env, chatId, `✅ Action <code>${actionId.slice(0, 12)}</code> cancelled.`);
  } else {
    await sendText(env, chatId, `❌ Cannot cancel — action may already be in progress.`);
  }
}

async function cmdResetPassword(env: Env, chatId: string, newPassword: string): Promise<void> {
  if (!newPassword) {
    await sendText(env, chatId, 'Usage: /resetpw &lt;new_password&gt;\n⚠️ This resets your web dashboard password.');
    return;
  }
  if (newPassword.length < 12) {
    await sendText(env, chatId, '❌ Password must be at least 12 characters.');
    return;
  }
  const salt = generateSalt();
  const hash = await hashPassword(newPassword, salt);
  await setAuth(env, hash, salt);
  await writeAudit(env, 'telegram', 'password_reset', chatId);
  await sendText(env, chatId, '✅ Web dashboard password has been reset.');
}

async function cmdHelp(env: Env, chatId: string): Promise<void> {
  const help = [
    '<b>Shuttle Bot Commands</b>',
    '',
    '/list — List all servers',
    '/server &lt;name|id&gt; — Server details',
    '/session &lt;name|id&gt; — Start terminal session',
    '/kill &lt;name|id&gt; — Kill session',
    '/exec &lt;name|id&gt; &lt;cmd&gt; — Run command',
    '/output &lt;action_id&gt; — Get command output',
    '/stop &lt;name|id&gt; — Stop running command',
    '/rename &lt;name|id&gt; &lt;new&gt; — Rename server',
    '/archive &lt;name|id&gt; — Archive server',
    '/settings — View global settings',
    '/set &lt;key&gt; &lt;value&gt; — Update a setting',
    '/notify &lt;id&gt; on|off — Toggle notifications',
    '/cancel &lt;action_id&gt; — Cancel pending action',
    '/resetpw &lt;new_password&gt; — Reset web password',
  ].join('\n');
  await sendText(env, chatId, help);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveServer(env: Env, nameOrId: string) {
  // Try direct ID first, then name lookup
  const byId = await getServer(env, nameOrId);
  if (byId) return byId;
  const servers = await listServers(env, false);
  return servers.find((s) => s.name?.toLowerCase() === nameOrId.toLowerCase()) ?? null;
}

async function createAction(
  env: Env,
  serverId: string,
  type: Parameters<typeof insertAction>[1]['type'],
  payload: Record<string, unknown>,
  notifyTelegram: 0 | 1,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await insertAction(env, {
    id,
    server_id: serverId,
    type,
    payload: JSON.stringify(payload),
    status: 'pending',
    created_at: now,
    notify_telegram: notifyTelegram,
    created_by: 'telegram',
  });
  return id;
}

function formatAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
