# Paper Arena

Real-time multiplayer Paper.io-style territory game with an **authoritative server**, a
**double-entry virtual economy**, and a cyberpunk PlayCanvas client. Runs as a Telegram
Mini App and on the web.

> Status: virtual currency only — no real-money deposits/withdrawals yet (that's a deliberate
> Phase 3+ with the gambling/compliance weight it implies).

## Features
- **Authoritative Bun WebSocket server** — clients send only a direction; the server simulates
  and broadcasts compact deltas. Anti-cheat by construction.
- **Deterministic grid engine** (`src/core/gameCore.mjs`) — pure, seeded RNG, reused *unchanged*
  on both client and server.
- **Two arenas**: **paid** (stake ◇0.20/life — killer gets ◇0.15, referrer ◇0.03 if referred,
  the house keeps the rest) and **free practice** (separate refillable balance, same mechanics).
- **Double-entry ledger** (`bun:sqlite`) — integer cents, idempotency keys, conservation
  invariant (Σ of all balances = 0), verified on boot and via `/health`.
- **Referrals** (15% of your invitees' kills), **in-game live scoreboard**, all-time leaderboards.
- **Auth**: Telegram Mini App (`initData` HMAC), HS256 JWT, dev login (non-prod only).
- **Anti-bot (Phase 1)**: behavioural heuristics (input-timing regularity, instant respawns,
  raw-socket / foreign origin) → advisory flags for review.
- **Provably-fair RNG**: each arena commits to a hashed secret seed (`sha256`), seeds the
  deterministic sim from it, and reveals the seed on epoch rotation so anyone can verify the
  house couldn't bias outcomes. Auditable at `/fairness`.
- **i18n** (RU / EN / UK), **dark / light theme**, mobile-first.
- 42 automated tests (engine, wire protocol, economy, anti-bot, provably-fair).

## Stack
Bun · Vite · PlayCanvas (WebGL) · bun:sqlite · vanilla JS (no UI framework)

## Run (dev)
```bash
bun install
bun run server   # authoritative server on :3801
bun run dev      # Vite client on :5173
```
Open two tabs at <http://localhost:5173>. The paid arena needs ≥2 players; free play starts
instantly against bots.

## Test
```bash
bun test test
```

## Production env
| var | purpose |
|---|---|
| `NODE_ENV=production` | enables fail-closed checks |
| `JWT_SECRET` | **required in prod** — the server refuses to start with the default |
| `ALLOW_DEV_AUTH=false` | disable name-only dev login |
| `ADMIN_TOKEN` | guards `/admin/*` (grants, bot flags) |
| `BOT_TOKEN` | Telegram Mini App auth |
| `ALLOWED_ORIGINS` | comma-list of allowed WS origins; others are flagged bot-like |
| `PORT` / `DB_PATH` / `MAX_CONN_PER_IP` | server port / sqlite path / per-IP socket cap |

## Layout
- `src/core/gameCore.mjs` — deterministic sim (shared client+server)
- `src/adapters/` — `botController` (shared), `arenaRenderer` & `inputController` (client)
- `src/net/` — `protocol` (shared), `netClient`, `api` (client)
- `src/ui/` — `screens`, `hud`; plus `src/i18n.mjs`
- `server/` — `index` (HTTP + WS), `arena`, `snapshotter`, `session`, `db`, `economy`, `auth`, `antibot`, `fairness`
- `test/` — `gameCore`, `protocol`, `economy`, `arenaKill`, `antibot`, `fairness`

## Roadmap
Real deposits/withdrawals (TON / Telegram Stars) with KYC, limits and review; Sybil & collusion
detection; a client-side replay verifier on top of the shipped seed-reveal; WS input rate-limiting.
Real-money operation carries real gambling/compliance weight (especially in some jurisdictions) —
virtual-only by design until that's properly addressed.
