// Shuttle Manager — Telegram notification sender

import type { Env, ActionRow, ActionResult } from '../types.js';
import { getAuth } from '../db/queries.js';

export async function sendTelegramNotification(
  env: Env,
  action: ActionRow,
  result: ActionResult,
): Promise<void> {
  const token = (env as unknown as Record<string, string>).TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const auth = await getAuth(env);
  if (!auth?.telegram_chat_id) return;

  const text = formatNotification(action, result);
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: auth.telegram_chat_id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

function formatNotification(action: ActionRow, result: ActionResult): string {
  const status = action.status.toUpperCase();
  const icon =
    action.status === 'completed' ? '✅' :
    action.status === 'failed'    ? '❌' :
    action.status === 'timed_out' ? '⏱️' :
    action.status === 'stopped'   ? '🛑' : '📋';

  let body = `${icon} <b>${action.type}</b> — ${status}\n`;
  body += `Server: <code>${action.server_id.slice(0, 12)}</code>\n`;
  body += `Action: <code>${action.id.slice(0, 12)}</code>\n`;

  if (result.session_link) {
    // Deliberately not a clickable link — session links are sensitive
    body += `\nSSH: <code>${result.session_link}</code>`;
  }

  if (result.output) {
    const snippet = result.output.slice(-800);
    body += `\n\nOutput:\n<pre>${escapeHtml(snippet)}</pre>`;
    if (result.truncated) body += '\n<i>(truncated)</i>';
  }

  if (result.exit_code !== undefined) {
    body += `\nExit code: <code>${result.exit_code}</code>`;
  }

  if (result.error) {
    body += `\nError: <code>${escapeHtml(result.error)}</code>`;
  }

  return body;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
