// index.mjs — Bun server entry: HTTP economy/auth API + WebSocket game upgrade.
// Run on the Mac: `bun run server/index.mjs` (PORT 3801). In dev the Vite client
// (:5173) calls this cross-origin; in prod a reverse proxy fronts both.
import { Arena } from './arena.mjs';
import {
  verifyDev, verifyTelegram, signToken, verifyToken,
  ALLOW_DEV_AUTH, ADMIN_TOKEN, JWT_IS_DEFAULT, HAS_BOT_TOKEN, IS_PROD, checkAdmin,
} from './auth.mjs';
import {
  getOrCreateUser, getProfile, getWallet, leaderboard, grant, reconcile, DEFAULT_STAKE_CENTS, refreshPractice, getReferrals, getBotFlags,
} from './economy.mjs';

const PORT = Number(process.env.PORT || 3801);
const arenaWager = new Arena({ mode: 'wager' }); // paid arena (min 2 humans)
const arenaFree = new Arena({ mode: 'free' });   // free arena (bots, starts instantly)
arenaWager.start();
arenaFree.start();

// Per-IP WebSocket connection cap (mitigates one client filling all arena slots).
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP || 6);
const ipConns = new Map();
const clientIp = (req, srv) => {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const ri = srv.requestIP && srv.requestIP(req);
  return ri ? ri.address : 'unknown';
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const json = (obj, status = 200) => Response.json(obj, { status, headers: CORS });
const err = (code, status = 400) => json({ error: code }, status);

function userIdFromAuth(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const claims = verifyToken(m[1]);
  return claims ? claims.sub : null;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ── WebSocket game socket: /ws?mode=wager|free&token=<jwt> ───────────────────
    if (path === '/ws') {
      const mode = url.searchParams.get('mode') === 'free' ? 'free' : 'wager';
      const claims = verifyToken(url.searchParams.get('token') || '');
      if (mode === 'wager' && !claims) return err('auth_required', 401); // paid play needs auth
      const ip = clientIp(req, srv);
      if ((ipConns.get(ip) || 0) >= MAX_CONN_PER_IP) return err('too_many_connections', 429);
      const arena = mode === 'free' ? arenaFree : arenaWager;
      const session = arena.createSession();
      session.mode = mode;
      // anti-bot signal: connections not coming from the real web app (raw sockets /
      // foreign origins) are treated as suspicious. In prod set ALLOWED_ORIGINS.
      const origin = req.headers.get('origin') || '';
      const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
      session.tel.foreignOrigin = allowed.length ? !allowed.includes(origin) : !origin;
      if (claims) { session.userId = claims.sub; if (claims.name) session.name = claims.name; }
      return srv.upgrade(req, { data: { session, arena, ip } }) ? undefined : err('upgrade_failed', 400);
    }

    // ── auth ────────────────────────────────────────────────────────────────────
    if (path === '/auth/dev' && req.method === 'POST') {
      if (!ALLOW_DEV_AUTH) return err('dev_auth_disabled', 403);
      const body = await req.json().catch(() => ({}));
      const id = verifyDev(body.name);
      if (!id) return err('bad_request');
      const user = getOrCreateUser('dev', id.subject, id.username, id.avatar, body.ref);
      return json({ token: signToken({ sub: user.id, name: user.username }), user });
    }
    if (path === '/auth/telegram' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const id = verifyTelegram(body.initData);
      if (!id) return err('invalid_init_data', 401);
      const user = getOrCreateUser('telegram', id.subject, id.username, id.avatar, body.ref);
      return json({ token: signToken({ sub: user.id, name: user.username }), user });
    }

    // ── reads ─────────────────────────────────────────────────────────────────
    if (path === '/config') return json({ stakeCents: DEFAULT_STAKE_CENTS, minHumans: arenaWager.minHumans, slots: arenaWager.maxSlots });
    if (path === '/leaderboard') {
      const m = url.searchParams.get('metric');
      const metric = (m === 'net' || m === 'referrals') ? m : 'earned';
      return json({ metric, entries: leaderboard(metric, 50) });
    }
    if (path === '/referrals/me') {
      const uid = userIdFromAuth(req); if (!uid) return err('auth_required', 401);
      const r = getReferrals(uid); return r ? json(r) : err('not_found', 404);
    }
    if (path === '/wallet/me') {
      const uid = userIdFromAuth(req); if (!uid) return err('auth_required', 401);
      const w = getWallet(uid); return w ? json(w) : err('not_found', 404);
    }
    if (path === '/practice/refresh' && req.method === 'POST') {
      const uid = userIdFromAuth(req); if (!uid) return err('auth_required', 401);
      const w = refreshPractice(uid); return w ? json(w) : err('not_found', 404);
    }
    if (path === '/profile/me') {
      const uid = userIdFromAuth(req); if (!uid) return err('auth_required', 401);
      const p = getProfile(uid); return p ? json(p) : err('not_found', 404);
    }
    if (path.startsWith('/profile/')) {
      const p = getProfile(decodeURIComponent(path.slice('/profile/'.length)));
      if (!p) return err('not_found', 404);
      const { balanceCents, frozenCents, ...pub } = p; // public view never leaks another user's wallet
      return json(pub);
    }

    // ── admin (test top-up) — requires x-admin-token (or the dev gate if unset) ───
    if (path === '/admin/grant' && req.method === 'POST') {
      if (!checkAdmin(req.headers.get('x-admin-token'))) return err('forbidden', 403);
      const body = await req.json().catch(() => ({}));
      if (!body.userId || !Number.isInteger(body.amount)) return err('bad_request');
      if (Math.abs(body.amount) > 1_000_000) return err('amount_too_large');
      return json(grant(body.userId, body.amount, `admin:${Date.now()}:${body.userId}`));
    }
    if (path === '/admin/flags') {
      if (!checkAdmin(req.headers.get('x-admin-token'))) return err('forbidden', 403);
      return json({ flags: getBotFlags(50) });
    }

    if (path === '/health') return json({ ok: true, wager: arenaWager.countHumans(), free: arenaFree.countHumans(), tick: arenaWager.game.tick, ledger: reconcile() });
    return new Response('Paper Arena server', { status: 200, headers: CORS });
  },
  websocket: {
    open(ws) {
      const ip = ws.data.ip;
      ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
      ws.data.arena.onOpen(ws);
    },
    message(ws, msg) { ws.data.arena.onMessage(ws, msg); },
    close(ws) {
      ws.data.arena.onClose(ws);
      const ip = ws.data.ip;
      const n = (ipConns.get(ip) || 1) - 1;
      if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
    },
  },
});

const rec = reconcile();
console.log(`[arena] authoritative server on :${server.port} (12 tps, 16 slots) | ledger ${rec.ok ? 'OK' : 'DRIFT!'} stake ${DEFAULT_STAKE_CENTS}¢ | ${IS_PROD ? 'PROD' : 'DEV'}`);
const warn = [];
if (JWT_IS_DEFAULT) warn.push('JWT_SECRET is the default (forgeable) — set it before any public deploy');
if (ALLOW_DEV_AUTH) warn.push('dev auth ENABLED — anyone can log in as any name; set ALLOW_DEV_AUTH=false for prod');
if (!ADMIN_TOKEN) warn.push('ADMIN_TOKEN not set — /admin/grant relies on the dev gate');
if (!HAS_BOT_TOKEN) warn.push('BOT_TOKEN not set — Telegram login disabled');
for (const w of warn) console.log(`[security] ⚠ ${w}`);
