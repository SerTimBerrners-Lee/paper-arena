// api.mjs — tiny client for the server's HTTP economy/auth API. Holds the JWT in
// localStorage and attaches it as a Bearer token.
function apiBase() {
  const env = (import.meta && import.meta.env) || {};
  if (env.VITE_API_URL) return env.VITE_API_URL;
  if (env.DEV) return `${location.protocol}//${location.hostname}:3801`; // Vite dev -> Bun
  return ''; // prod: same origin
}

const LS_TOKEN = 'paper_token';
let token = localStorage.getItem(LS_TOKEN) || null;

export function getToken() { return token; }
export function setToken(t) {
  token = t || null;
  if (t) localStorage.setItem(LS_TOKEN, t); else localStorage.removeItem(LS_TOKEN);
}

async function req(path, opts = {}) {
  const headers = {};
  if (opts.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(apiBase() + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `http_${r.status}`), { status: r.status, code: data.error });
  return data;
}

export const api = {
  config: () => req('/config'),
  loginDev: (name, ref) => req('/auth/dev', { method: 'POST', body: { name, ref } }),
  loginTelegram: (initData, ref) => req('/auth/telegram', { method: 'POST', body: { initData, ref } }),
  wallet: () => req('/wallet/me'),
  refreshPractice: () => req('/practice/refresh', { method: 'POST' }),
  referrals: () => req('/referrals/me'),
  profile: (id) => req(id ? `/profile/${encodeURIComponent(id)}` : '/profile/me'),
  leaderboard: (metric = 'earned') => req(`/leaderboard?metric=${metric}`),
};

// Virtual in-game currency "Credits" (◇), shown 1:1 with the stored dollar value.
// No real money is involved — this is purely a re-skin so it doesn't read as a
// cash-gambling game. Stored as integer cents server-side throughout.
export const CURRENCY = '◇';
export const APP_VERSION = '0.3.0';
// thin space (U+2009) between the coin and the number — a small, consistent gap everywhere
export const fmtMoney = (cents) => `${CURRENCY} ${((cents || 0) / 100).toFixed(2)}`;
