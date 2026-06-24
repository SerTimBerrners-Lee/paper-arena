// auth.mjs — pluggable identity. Three providers, one shape:
//   verify*(cred) -> { subject, username, avatar } | null
// plus a tiny HS256 JWT (no dependency) used to bind a WebSocket to a user.
import crypto from 'node:crypto';

export const IS_PROD = process.env.NODE_ENV === 'production';
const DEFAULT_SECRET = 'dev-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
export const JWT_IS_DEFAULT = JWT_SECRET === DEFAULT_SECRET;
export const HAS_BOT_TOKEN = !!BOT_TOKEN;
// Dev/guest login: explicit env wins; otherwise ON in dev, OFF in production.
export const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH != null
  ? process.env.ALLOW_DEV_AUTH === 'true'
  : !IS_PROD;

// Fail closed: never run production with a forgeable default signing secret.
if (IS_PROD && JWT_IS_DEFAULT) {
  throw new Error('SECURITY: set JWT_SECRET before running in production (the default is public and forgeable)');
}

// Constant-time check for the admin secret. With no ADMIN_TOKEN set, /admin/grant
// is only reachable in dev (ALLOW_DEV_AUTH) — never in production.
export function checkAdmin(supplied) {
  if (ADMIN_TOKEN) {
    const a = Buffer.from(String(supplied || ''));
    const b = Buffer.from(ADMIN_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return ALLOW_DEV_AUTH;
}

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signToken(payload, ttlSec = 7 * 24 * 3600) {
  const nowSec = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...payload, iat: nowSec, exp: nowSec + ttlSec })}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  const a = Buffer.from(parts[2]); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body; try { body = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
  return body; // { sub: <userId>, name, ... }
}

// Telegram Mini App initData validation (HMAC per the WebApp spec).
export function verifyTelegram(initData, maxAgeSec = 24 * 3600) {
  if (!BOT_TOKEN || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (computed !== hash) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (maxAgeSec && authDate && Date.now() / 1000 - authDate > maxAgeSec) return null;
  let user = {};
  try { user = JSON.parse(params.get('user') || '{}'); } catch { return null; }
  if (!user.id) return null;
  return { subject: String(user.id), username: user.username || user.first_name || `tg${user.id}`, avatar: user.photo_url || null };
}

// Dev/guest login (non-prod): a name maps to a stable account so re-login is the
// same player. Gated by ALLOW_DEV_AUTH.
export function verifyDev(name) {
  if (!ALLOW_DEV_AUTH) return null;
  const clean = String(name || '').replace(/[^\w \-]/g, '').trim().slice(0, 16) || 'Guest';
  return { subject: clean.toLowerCase(), username: clean, avatar: null };
}
