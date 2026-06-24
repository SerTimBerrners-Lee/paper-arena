// economy.mjs — the virtual-money rules, as small idempotent transactions over
// the double-entry ledger in db.mjs. Invariant: every cent is conserved, so the
// sum of ALL account balances (users + house + escrow + mint) is always 0 — the
// `mint` account just goes negative by however much has been granted. Stakes are
// humans-only; bots never touch the ledger.
import { db, randomUUID } from './db.mjs';

export const DEFAULT_STAKE_CENTS = 20;   // 20¢ per life
export const KILLER_RATE = 0.75;         // 75% of the stake to the killer (◇0.15 of ◇0.20)
export const REFERRAL_RATE = 0.15;       // 15% to the killer's referrer if any (◇0.03); rest = house
export const WELCOME_GRANT_CENTS = 500;  // virtual ◇5.00 handed to every new account

// Split a stake on a kill: killer 75%, referrer 15% (only when the killer was
// referred), the remainder (10% with a referrer, 25% without) to the house.
function splitKill(stake, hasReferrer) {
  const killer = Math.floor(stake * KILLER_RATE);
  const referral = hasReferrer ? Math.floor(stake * REFERRAL_RATE) : 0;
  return { killer, referral, house: stake - killer - referral };
}

// ── low-level ledger posting ────────────────────────────────────────────────
const insLedger = db.prepare(
  `INSERT INTO ledger_entries
     (txn_id, from_account, to_account, amount_cents, kind, match_player_id, idempotency_key, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const keyExists = db.prepare('SELECT 1 FROM ledger_entries WHERE idempotency_key = ? LIMIT 1');

function adjust(account, delta) {
  if (account.startsWith('user:')) {
    db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(delta, account.slice(5));
  } else {
    db.prepare('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?').run(delta, account);
  }
}

// Move `amount` cents from->to and record it. The UNIQUE idempotency_key makes a
// replayed event a hard error we catch at the call site (we pre-check first).
function post(txnId, from, to, amount, kind, key, mpId = null) {
  if (amount <= 0) return;
  insLedger.run(txnId, from, to, amount, kind, mpId, key, Date.now());
  adjust(from, -amount);
  adjust(to, amount);
}

const processed = (key) => !!keyExists.get(key);

// ── stats rollup ────────────────────────────────────────────────────────────
function ensureStats(userId) {
  db.prepare('INSERT OR IGNORE INTO user_stats (user_id) VALUES (?)').run(userId);
}
function bumpStats(userId, d = {}) {
  ensureStats(userId);
  const net = (d.earned || 0) + (d.returned || 0) - (d.staked || 0);
  db.prepare(`UPDATE user_stats SET
       games                = games + ?,
       kills                = kills + ?,
       deaths               = deaths + ?,
       total_earned_cents   = total_earned_cents + ?,
       total_staked_cents   = total_staked_cents + ?,
       total_returned_cents = total_returned_cents + ?,
       net_profit_cents     = net_profit_cents + ?,
       max_area_cells       = MAX(max_area_cells, ?),
       best_streak          = MAX(best_streak, ?)
     WHERE user_id = ?`).run(
    d.games || 0, d.kills || 0, d.deaths || 0,
    d.earned || 0, d.staked || 0, d.returned || 0, net,
    d.area || 0, d.streak || 0, userId,
  );
}

const referrerOf = (userId) => { const u = getUser(userId); return u && u.referred_by ? u.referred_by : null; };
function bumpReferral(userId, cents) {
  ensureStats(userId);
  db.prepare('UPDATE user_stats SET referral_earned_cents = referral_earned_cents + ? WHERE user_id = ?').run(cents, userId);
}

// ── reads ────────────────────────────────────────────────────────────────────
export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const getMatchPlayer = (id) => db.prepare('SELECT * FROM match_players WHERE id = ?').get(id);

export const resolveReferrer = (code) => {
  if (!code) return null;
  const r = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(String(code).toUpperCase());
  return r ? r.id : null;
};
function genReferralCode() {
  for (let i = 0; i < 10; i += 1) {
    const c = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    if (!db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(c)) return c;
  }
  return randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
}
export function getReferralInfo(userId) {
  const u = getUser(userId);
  if (!u) return null;
  ensureStats(userId);
  const s = db.prepare('SELECT referral_earned_cents FROM user_stats WHERE user_id = ?').get(userId);
  const count = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(userId).c;
  return { code: u.referral_code, referrals: count, earnedCents: s ? s.referral_earned_cents : 0 };
}

export function getWallet(userId) {
  const u = getUser(userId);
  return u ? { balanceCents: u.balance_cents, frozenCents: u.frozen_cents } : null;
}

export const PRACTICE_START_CENTS = 500; // refillable practice bankroll for free mode

export const getPracticeWallet = (userId) => {
  const u = getUser(userId);
  return u ? { practiceBalanceCents: u.practice_balance_cents } : null;
};
// Practice money is FAKE (no ledger, no conservation): a refillable bankroll so the
// free/bots mode mirrors the real economy and shows the player what they'd earn.
export const practiceStake = db.transaction((userId, stake) => {
  const u = getUser(userId);
  if (!u || u.practice_balance_cents < stake) return false;
  db.prepare('UPDATE users SET practice_balance_cents = practice_balance_cents - ? WHERE id = ?').run(stake, userId);
  return true;
});
export function practiceReward(userId, cents) {
  if (!userId || cents <= 0) return;
  db.prepare('UPDATE users SET practice_balance_cents = practice_balance_cents + ? WHERE id = ?').run(cents, userId);
}
export const refreshPractice = db.transaction((userId) => {
  const u = getUser(userId);
  if (!u) return null;
  if (u.practice_balance_cents < PRACTICE_START_CENTS) {
    db.prepare('UPDATE users SET practice_balance_cents = ? WHERE id = ?').run(PRACTICE_START_CENTS, userId);
  }
  return getPracticeWallet(userId);
});

export function getProfile(userId) {
  const u = getUser(userId);
  if (!u) return null;
  ensureStats(userId);
  const s = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(userId);
  const referrals = db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by = ?').get(userId).c;
  return {
    id: u.id,
    username: u.username,
    avatarUrl: u.avatar_url,
    balanceCents: u.balance_cents,
    frozenCents: u.frozen_cents,
    practiceBalanceCents: u.practice_balance_cents,
    referralCode: u.referral_code,
    stats: {
      games: s.games, kills: s.kills, deaths: s.deaths,
      maxAreaCells: s.max_area_cells,
      totalEarnedCents: s.total_earned_cents,
      totalStakedCents: s.total_staked_cents,
      totalReturnedCents: s.total_returned_cents,
      netProfitCents: s.net_profit_cents,
      bestStreak: s.best_streak,
      referralEarnedCents: s.referral_earned_cents,
      referrals,
      kd: s.deaths ? +(s.kills / s.deaths).toFixed(2) : s.kills,
    },
  };
}

export function leaderboard(metric = 'earned', limit = 50) {
  const col = metric === 'referrals' ? 'referral_earned_cents'
    : metric === 'net' ? 'net_profit_cents' : 'total_earned_cents';
  return db.prepare(`
    SELECT u.id, u.username, u.avatar_url,
           s.total_earned_cents, s.net_profit_cents, s.referral_earned_cents, s.kills, s.deaths, s.games, s.max_area_cells
    FROM user_stats s JOIN users u ON u.id = s.user_id
    ORDER BY s.${col} DESC, s.kills DESC
    LIMIT ?`).all(limit).map((r, i) => ({
    rank: i + 1, id: r.id, username: r.username, avatarUrl: r.avatar_url,
    earnedCents: r.total_earned_cents, netCents: r.net_profit_cents, referralEarnedCents: r.referral_earned_cents,
    kills: r.kills, deaths: r.deaths, games: r.games, maxAreaCells: r.max_area_cells,
  }));
}

// The list of users I referred, with their activity (for the Referrals page).
export function getReferrals(userId) {
  const list = db.prepare(`
    SELECT u.username, COALESCE(s.games, 0) games, COALESCE(s.kills, 0) kills, u.created_at
    FROM users u LEFT JOIN user_stats s ON s.user_id = u.id
    WHERE u.referred_by = ?
    ORDER BY s.kills DESC, u.created_at ASC
    LIMIT 100`).all(userId).map((r) => ({ username: r.username, games: r.games, kills: r.kills }));
  return { ...getReferralInfo(userId), list };
}

// ── anti-bot flags (advisory; reviewed before any future withdrawal) ────────────
export function recordBotFlag(userId, score, reasons) {
  db.prepare('INSERT INTO bot_flags (user_id, score, reasons, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, score, Array.isArray(reasons) ? reasons.join(',') : String(reasons), Date.now());
}
export function getBotFlags(limit = 50) {
  return db.prepare(`SELECT bf.id, bf.user_id, bf.score, bf.reasons, bf.created_at, u.username
                     FROM bot_flags bf LEFT JOIN users u ON u.id = bf.user_id
                     ORDER BY bf.id DESC LIMIT ?`).all(limit);
}
export const botFlagCount = () => db.prepare('SELECT COUNT(*) c FROM bot_flags').get().c;

// ── accounts ─────────────────────────────────────────────────────────────────
export function getOrCreateUser(provider, subject, username, avatar = null, referrerCode = null) {
  const existing = db.prepare('SELECT id FROM users WHERE auth_provider = ? AND auth_subject = ?').get(provider, String(subject));
  if (existing) {
    if (username) db.prepare('UPDATE users SET username = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?').run(username, avatar, existing.id);
    return getProfile(existing.id);
  }
  const id = randomUUID();
  const code = genReferralCode();
  const refId = referrerCode ? resolveReferrer(referrerCode) : null;
  const create = db.transaction(() => {
    db.prepare(`INSERT INTO users (id, auth_provider, auth_subject, username, avatar_url, referral_code, referred_by, balance_cents, frozen_cents, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`)
      .run(id, provider, String(subject), username || `Player`, avatar, code, (refId && refId !== id) ? refId : null, Date.now());
    ensureStats(id);
    // welcome credit so the virtual economy is playable immediately (Phase 3 = real deposits)
    if (WELCOME_GRANT_CENTS > 0) post(randomUUID(), 'mint', `user:${id}`, WELCOME_GRANT_CENTS, 'grant', `grant:welcome:${id}`);
  });
  create();
  return getProfile(id);
}

// Test/admin top-up: mint -> user. Idempotent on `ref`.
export const grant = db.transaction((userId, amountCents, ref) => {
  const key = `grant:${ref}`;
  if (!processed(key) && amountCents > 0) post(randomUUID(), 'mint', `user:${userId}`, amountCents, 'grant', key);
  return getWallet(userId);
});

// ── match lifecycle ───────────────────────────────────────────────────────────
export function createMatch(mode, stakeCents, seed = null) {
  const id = randomUUID();
  db.prepare('INSERT INTO matches (id, mode, stake_cents, seed, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, mode, stakeCents, seed, 'live', Date.now());
  return id;
}

// Freeze a stake and open one "life". Returns the match_player id, or null if the
// player cannot afford the stake.  user -> escrow.
export const startLife = db.transaction((userId, matchId, enginePlayerId, stakeCents) => {
  const u = getUser(userId);
  if (!u || u.balance_cents < stakeCents) return null;
  const info = db.prepare(`INSERT INTO match_players (match_id, user_id, engine_player_id, stake_cents, joined_at)
                           VALUES (?, ?, ?, ?, ?)`).run(matchId, userId, enginePlayerId, stakeCents, Date.now());
  const mpId = Number(info.lastInsertRowid);
  post(randomUUID(), `user:${userId}`, 'escrow', stakeCents, 'stake', `stake:${mpId}`, mpId);
  db.prepare('UPDATE users SET frozen_cents = frozen_cents + ? WHERE id = ?').run(stakeCents, userId);
  bumpStats(userId, { games: 1, staked: stakeCents });
  return mpId;
});

// A life ends in death. If a real (human, non-self) killer is named, they take
// 90% and the house rakes 10%; otherwise the whole stake is forfeit to the house.
// Idempotent: a match_player can only be settled once (guarded by ended_at).
export const endLifeByDeath = db.transaction((victimMpId, opts = {}) => {
  const mp = getMatchPlayer(victimMpId);
  if (!mp || mp.ended_at != null) return null; // already settled
  const stake = mp.stake_cents;
  const { killerUserId = null, killerMpId = null, reason = 'killed',
          victimKills = 0, victimArea = 0, victimDurationMs = 0 } = opts;
  const hasKiller = killerUserId && killerUserId !== mp.user_id;
  const txn = randomUUID();
  let payout = 0;

  if (hasKiller) {
    const refId = referrerOf(killerUserId);
    const sp = splitKill(stake, !!refId);
    payout = sp.killer;
    post(txn, 'escrow', `user:${killerUserId}`, sp.killer, 'payout', `payout:${victimMpId}`, victimMpId);
    if (refId && sp.referral > 0) { post(txn, 'escrow', `user:${refId}`, sp.referral, 'referral', `ref:${victimMpId}`, victimMpId); bumpReferral(refId, sp.referral); }
    if (sp.house > 0) post(txn, 'escrow', 'house', sp.house, 'rake', `rake:${victimMpId}`, victimMpId);
    bumpStats(killerUserId, { kills: 1, earned: sp.killer });
    if (killerMpId) db.prepare('UPDATE match_players SET kills = kills + 1 WHERE id = ?').run(killerMpId);
  } else {
    post(txn, 'escrow', 'house', stake, 'forfeit', `forfeit:${victimMpId}`, victimMpId);
  }

  db.prepare('UPDATE users SET frozen_cents = frozen_cents - ? WHERE id = ?').run(stake, mp.user_id);
  db.prepare(`UPDATE match_players SET ended_at = ?, result = ?, killed_by_user_id = ?,
                 kills = ?, max_area_cells = ?, duration_ms = ? WHERE id = ?`)
    .run(Date.now(), hasKiller ? (reason || 'killed') : 'forfeit', hasKiller ? killerUserId : null,
         victimKills, victimArea, victimDurationMs, victimMpId);
  bumpStats(mp.user_id, { deaths: 1, area: victimArea, streak: victimKills });
  return { stakeCents: stake, payoutToKillerCents: payout, killerUserId: hasKiller ? killerUserId : null };
});

// A bot has no stake of its own, but we treat it AS IF it paid the entry fee:
// killing a bot mints the same 90% reward to the human killer (10% rake to house).
// This injects money into circulation (mint just goes more negative), so the
// conservation invariant (Σ balances == 0) still holds. Idempotent on `ref`.
export const settleBotKill = db.transaction((killerUserId, killerMpId, stakeCents, ref) => {
  if (!killerUserId) return 0;
  const key = `botkill:${ref}`;
  if (processed(key)) return 0;
  const refId = referrerOf(killerUserId);
  const sp = splitKill(stakeCents, !!refId);
  const txn = randomUUID();
  post(txn, 'mint', `user:${killerUserId}`, sp.killer, 'payout', key, killerMpId);
  if (refId && sp.referral > 0) { post(txn, 'mint', `user:${refId}`, sp.referral, 'referral', `botref:${ref}`, killerMpId); bumpReferral(refId, sp.referral); }
  if (sp.house > 0) post(txn, 'mint', 'house', sp.house, 'rake', `botrake:${ref}`, killerMpId);
  bumpStats(killerUserId, { kills: 1, earned: sp.killer });
  if (killerMpId) db.prepare('UPDATE match_players SET kills = kills + 1 WHERE id = ?').run(killerMpId);
  return sp.killer;
});

// ── integrity ─────────────────────────────────────────────────────────────────
// Sum of every balance must be exactly 0 (conservation), and the sum of users'
// frozen stakes must equal the escrow balance.
export function reconcile() {
  const u = db.prepare('SELECT COALESCE(SUM(balance_cents),0) b, COALESCE(SUM(frozen_cents),0) f FROM users').get();
  const a = db.prepare('SELECT COALESCE(SUM(balance_cents),0) b FROM accounts').get();
  const escrow = db.prepare("SELECT balance_cents b FROM accounts WHERE id = 'escrow'").get().b;
  const total = u.b + a.b;
  return { total, frozenSum: u.f, escrow, ok: total === 0 && u.f === escrow };
}
