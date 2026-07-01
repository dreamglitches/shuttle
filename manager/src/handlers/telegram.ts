// Shuttle Manager — Telegram webhook + link handler (Phase 3 full bot)

import type { Env } from '../types.js';
import {
  getAuth,
  setTelegramChatId,
  setTelegramLinkCode,
  writeAudit,
} from '../db/queries.js';
import { generateToken } from '../auth/psk.js';
import { handleBotMessage } from '../telegram/bot.js';

// POST /api/telegram/webhook
export async function handleTelegramWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  // Validate Telegram webhook secret token
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  const expected = (env as unknown as Record<string, string>).TELEGRAM_WEBHOOK_SECRET;
  if (!expected || secret !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  const update = await request.json<TelegramUpdate>();
  const message = update.message ?? update.callback_query?.message;
  if (!message) return ok();

  const chatId = String(
    update.message?.chat.id ?? update.callback_query?.from.id,
  );
  const fromId = String(
    update.message?.from?.id ?? update.callback_query?.from.id,
  );

  // Strict allowlist: must be the linked chat ID (or linking flow)
  const auth = await getAuth(env);
  const isLinked = auth?.telegram_chat_id === chatId;
  const text = update.message?.text ?? '';

  // Linking flow: any chat can complete linking with a valid code
  if (text.startsWith('/link ') || text === '/link') {
    await handleLinkCommand(env, text, chatId, auth);
    return ok();
  }

  // All other commands require the linked chat
  if (!isLinked) {
    // Silent reject — don't reveal the bot's purpose
    return ok();
  }

  await handleBotMessage(env, update, chatId, fromId);
  await writeAudit(env, 'telegram', 'bot_command', text.slice(0, 120));
  return ok();
}

// POST /api/telegram/link — generate a one-time link code
export async function handleTelegramLink(
  _request: Request,
  env: Env,
): Promise<Response> {
  const code = generateToken().slice(0, 16).toUpperCase();
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes
  await setTelegramLinkCode(env, code, expiresAt);
  await writeAudit(env, 'web', 'telegram_link_generated', undefined);
  return jsonResponse({ code, expires_in_seconds: 600 });
}

// ─── Link command handler ──────────────────────────────────────────────────────

async function handleLinkCommand(
  env: Env,
  text: string,
  chatId: string,
  auth: Awaited<ReturnType<typeof getAuth>>,
): Promise<void> {
  if (!auth) return;
  const parts = text.trim().split(/\s+/);
  const code = parts[1]?.toUpperCase();
  if (!code) return;

  const now = Math.floor(Date.now() / 1000);
  if (
    auth.telegram_link_code === code &&
    auth.telegram_link_expires &&
    auth.telegram_link_expires > now
  ) {
    await setTelegramChatId(env, chatId);
    await writeAudit(env, 'telegram', 'telegram_linked', chatId);
    await sendText(env, chatId, '✅ Telegram linked successfully. You now have full bot access.');
  } else {
    await sendText(env, chatId, '❌ Invalid or expired link code.');
  }
}

// ─── Minimal send helper ──────────────────────────────────────────────────────

export async function sendText(env: Env, chatId: string, text: string): Promise<void> {
  const token = (env as unknown as Record<string, string>).TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// ─── Telegram types (minimal) ─────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: TelegramMessage;
    data?: string;
  };
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number };
  text?: string;
}

function ok(): Response {
  return new Response('OK', { status: 200 });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
