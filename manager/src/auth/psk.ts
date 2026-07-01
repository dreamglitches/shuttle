// Shuttle Manager — PSK HMAC-SHA256 request authentication
//
// Every client request is signed: HMAC-SHA256 over "METHOD\nPATH\nTIMESTAMP\nHEX(SHA256(body))"
// keyed by the fleet PSK. A ±300-second timestamp window prevents replay.
//
// Auth abstraction: all client auth flows through verifyClientAuth().
// To migrate to per-server credentials: change this one function.

import type { Env } from '../types.js';

const TIMESTAMP_TOLERANCE_S = 300; // ±5 minutes
const RATE_LIMIT_PER_SERVER = 10;  // requests per minute per server
const RATE_LIMIT_GLOBAL = 1000;    // requests per minute globally

export async function verifyClientAuth(
  request: Request,
  env: Env,
  serverId: string,
): Promise<{ ok: boolean; reason?: string }> {
  // Rate limiting — per server and globally
  const rateDenied = await checkRateLimit(env, serverId);
  if (rateDenied) return { ok: false, reason: 'rate_limited' };

  const timestampHeader = request.headers.get('X-Shuttle-Timestamp');
  const signatureHeader = request.headers.get('X-Shuttle-Signature');
  const pskHeader = request.headers.get('X-Shuttle-PSK');

  if (!timestampHeader || !signatureHeader || !pskHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  // Timestamp window check
  const ts = parseInt(timestampHeader, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > TIMESTAMP_TOLERANCE_S) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }

  // Retrieve PSK from env secret (set via `wrangler secret put SHUTTLE_PSK`)
  const psk = (env as unknown as Record<string, string>).SHUTTLE_PSK;
  if (!psk) return { ok: false, reason: 'psk_not_configured' };

  // Reconstruct the signed message
  const url = new URL(request.url);
  const bodyBytes = await request.clone().arrayBuffer();
  const bodyHash = await sha256Hex(bodyBytes);
  const message = `${request.method}\n${url.pathname}\n${timestampHeader}\n${bodyHash}`;

  // Verify HMAC
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(psk),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = hexToBytes(signatureHeader);
  const messageBytes = new TextEncoder().encode(message);
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, messageBytes);

  if (!valid) return { ok: false, reason: 'invalid_signature' };
  return { ok: true };
}

// ─── Session cookie auth (operator frontend) ──────────────────────────────────

export async function verifySessionAuth(
  request: Request,
  env: Env,
): Promise<boolean> {
  const cookieHeader = request.headers.get('Cookie') ?? '';
  const token = parseCookie(cookieHeader, 'shuttle_session');
  if (!token) return false;

  const now = Math.floor(Date.now() / 1000);
  // Import lazily to avoid circular deps
  const { getSession } = await import('../db/queries.js');
  return getSession(env, token, now);
}

export function parseCookie(header: string, name: string): string | null {
  const parts = header.split(';').map((p) => p.trim());
  for (const part of parts) {
    const [k, ...rest] = part.split('=');
    if (k?.trim() === name) return rest.join('=').trim();
  }
  return null;
}

// ─── Password hashing (PBKDF2-SHA256) ────────────────────────────────────────

export async function hashPassword(
  password: string,
  salt: string,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      iterations: 100_000,
    },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export function generateSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export function generateToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

// ─── Rate limiting (KV-backed sliding window) ─────────────────────────────────

async function checkRateLimit(env: Env, serverId: string): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60000);
  const serverKey = `ratelimit:client:${serverId}:${minute}`;
  const globalKey = `ratelimit:client:global:${minute}`;

  const [serverCount, globalCount] = await Promise.all([
    env.SHUTTLE_RATE.get(serverKey),
    env.SHUTTLE_RATE.get(globalKey),
  ]);

  const sc = parseInt(serverCount ?? '0', 10);
  const gc = parseInt(globalCount ?? '0', 10);

  if (sc >= RATE_LIMIT_PER_SERVER || gc >= RATE_LIMIT_GLOBAL) return true;

  // Increment (fire-and-forget, don't await to save CPU budget)
  void env.SHUTTLE_RATE.put(serverKey, String(sc + 1), { expirationTtl: 120 });
  void env.SHUTTLE_RATE.put(globalKey, String(gc + 1), { expirationTtl: 120 });
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hash));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
