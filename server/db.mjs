// db.mjs — SQLite (bun:sqlite, WAL) storage for the virtual economy.
// Money is always INTEGER CENTS. The append-only `ledger_entries` table is the
// source of truth; cached balances (users/accounts) are only ever moved inside
// the same transaction that posts the matching ledger rows, so they can be
// reconciled against the ledger at any time (see economy.reconcile()).
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export { randomUUID } from 'node:crypto';

const DB_PATH = process.env.DB_PATH
  || (() => {
    const dir = process.env.DB_DIR || join(import.meta.dir, 'data');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'arena.db');
  })();

export const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 4000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  auth_provider TEXT NOT NULL,
  auth_subject  TEXT NOT NULL,
  username      TEXT NOT NULL,
  avatar_url    TEXT,
  referral_code TEXT UNIQUE,
  referred_by   TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  frozen_cents  INTEGER NOT NULL DEFAULT 0,
  practice_balance_cents INTEGER NOT NULL DEFAULT 500, -- separate fake/practice bankroll (free mode)
  created_at    INTEGER NOT NULL,
  UNIQUE(auth_provider, auth_subject),
  CHECK (balance_cents >= 0),
  CHECK (frozen_cents  >= 0)
);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,   -- 'house' | 'escrow' | 'mint'
  balance_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id          TEXT NOT NULL,
  from_account    TEXT NOT NULL,    -- 'user:<id>' | 'house' | 'escrow' | 'mint'
  to_account      TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  kind            TEXT NOT NULL,    -- grant|stake|payout|rake|forfeit|cashout
  match_player_id INTEGER,
  idempotency_key TEXT UNIQUE,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,        -- 'wager' | 'practice'
  stake_cents INTEGER NOT NULL,
  seed        INTEGER,
  status      TEXT NOT NULL DEFAULT 'live',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS match_players (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id             TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  engine_player_id     INTEGER NOT NULL,
  stake_cents          INTEGER NOT NULL,
  joined_at            INTEGER NOT NULL,
  ended_at             INTEGER,
  result               TEXT,        -- killed|enclosed|self|cashout|forfeit
  killed_by_user_id    TEXT,
  payout_cents         INTEGER NOT NULL DEFAULT 0,
  stake_returned_cents INTEGER NOT NULL DEFAULT 0,
  kills                INTEGER NOT NULL DEFAULT 0,
  max_area_cells       INTEGER NOT NULL DEFAULT 0,
  duration_ms          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_stats (
  user_id              TEXT PRIMARY KEY,
  games                INTEGER NOT NULL DEFAULT 0,
  kills                INTEGER NOT NULL DEFAULT 0,
  deaths               INTEGER NOT NULL DEFAULT 0,
  max_area_cells       INTEGER NOT NULL DEFAULT 0,
  total_earned_cents   INTEGER NOT NULL DEFAULT 0,
  total_staked_cents   INTEGER NOT NULL DEFAULT 0,
  total_returned_cents INTEGER NOT NULL DEFAULT 0,
  net_profit_cents     INTEGER NOT NULL DEFAULT 0,
  best_streak          INTEGER NOT NULL DEFAULT 0,
  referral_earned_cents INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stats_earned ON user_stats(total_earned_cents DESC);
CREATE INDEX IF NOT EXISTS idx_stats_net    ON user_stats(net_profit_cents DESC);
CREATE INDEX IF NOT EXISTS idx_mp_user      ON match_players(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_mp    ON ledger_entries(match_player_id);
CREATE INDEX IF NOT EXISTS idx_users_refby  ON users(referred_by);

CREATE TABLE IF NOT EXISTS bot_flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  score      REAL NOT NULL,
  reasons    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_botflags_user ON bot_flags(user_id, id DESC);
`);

// Seed the three system accounts (idempotent).
for (const id of ['house', 'escrow', 'mint']) {
  db.prepare('INSERT OR IGNORE INTO accounts (id, balance_cents) VALUES (?, 0)').run(id);
}
