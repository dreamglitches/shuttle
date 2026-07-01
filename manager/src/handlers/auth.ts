// Shuttle Manager — Operator auth handlers (login, logout, change-password)

import type { Env, LoginRequest, ChangePasswordRequest } from '../types.js';
import {
  getAuth,
  setAuth,
  createSession,
  deleteSession,
  writeAudit,
} from '../db/queries.js';
import {
  hashPassword,
  generateSalt,
  generateToken,
  parseCookie,
} from '../auth/psk.js';

const SESSION_COOKIE_TTL = 86400; // 24 hours
const LOGIN_RATE_KEY = 'ratelimit:login:';
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_S = 900; // 15 minutes

// POST /api/auth/login
export async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  // Rate limit by IP
  const rateDenied = await checkLoginRate(env, ip);
  if (rateDenied) {
    return errorResponse('Too many login attempts. Try again later.', 429);
  }

  const body = await request.json<LoginRequest>();
  const auth = await getAuth(env);

  if (!auth) {
    // No password set yet — first-run: accept any password and store it
    const salt = generateSalt();
    const hash = await hashPassword(body.password, salt);
    await setAuth(env, hash, salt);
    const token = generateToken();
    const now = Math.floor(Date.now() / 1000);
    await createSession(env, token, now);
    await writeAudit(env, 'web', 'first_run_login', ip);
    return sessionResponse(token);
  }

  const hash = await hashPassword(body.password, auth.password_salt);
  if (hash !== auth.password_hash) {
    await writeAudit(env, 'web', 'login_failed', ip);
    await incrementLoginRate(env, ip);
    return errorResponse('Invalid password', 401);
  }

  const token = generateToken();
  const now = Math.floor(Date.now() / 1000);
  await createSession(env, token, now);
  await writeAudit(env, 'web', 'login', ip);
  return sessionResponse(token);
}

// POST /api/auth/logout
export async function handleLogout(
  request: Request,
  env: Env,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const token = parseCookie(cookieHeader, 'shuttle_session');
  if (token) await deleteSession(env, token);
  await writeAudit(env, 'web', 'logout', undefined);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'shuttle_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict',
    },
  });
}

// POST /api/auth/change-password
export async function handleChangePassword(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<ChangePasswordRequest>();
  const auth = await getAuth(env);
  if (!auth) return errorResponse('Not configured', 500);

  const currentHash = await hashPassword(body.current_password, auth.password_salt);
  if (currentHash !== auth.password_hash) {
    return errorResponse('Current password incorrect', 401);
  }

  const newSalt = generateSalt();
  const newHash = await hashPassword(body.new_password, newSalt);
  await setAuth(env, newHash, newSalt);
  await writeAudit(env, 'web', 'password_changed', undefined);
  return jsonResponse({ ok: true });
}

// ─── Rate limiting helpers ────────────────────────────────────────────────────

async function checkLoginRate(env: Env, ip: string): Promise<boolean> {
  const key = `${LOGIN_RATE_KEY}${ip}`;
  const count = await env.SHUTTLE_RATE.get(key);
  return parseInt(count ?? '0', 10) >= LOGIN_MAX_ATTEMPTS;
}

async function incrementLoginRate(env: Env, ip: string): Promise<void> {
  const key = `${LOGIN_RATE_KEY}${ip}`;
  const count = await env.SHUTTLE_RATE.get(key);
  const n = parseInt(count ?? '0', 10) + 1;
  await env.SHUTTLE_RATE.put(key, String(n), { expirationTtl: LOGIN_WINDOW_S });
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function sessionResponse(token: string): Response {
  const maxAge = SESSION_COOKIE_TTL;
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `shuttle_session=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    },
  });
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
