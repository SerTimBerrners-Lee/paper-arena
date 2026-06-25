// arena.mjs — the authoritative continuous arena + the virtual-money bridge.
// Owns ONE deterministic game, ticks it at 12 tps, drives bots, applies human
// inputs, broadcasts deltas, and (for wager humans) freezes a stake per life and
// settles it on death/cash-out via the double-entry ledger. Bots are non-economic.
import { createGame, setDirection, tickGame, respawnPlayer, makeRng } from '../src/core/gameCore.mjs';
import { BotController } from '../src/adapters/botController.mjs';
import { Snapshotter } from './snapshotter.mjs';
import { Session } from './session.mjs';
import { encodeKeyframe, peekOp, OP, decodeInput, STATUS } from '../src/net/protocol.mjs';
import {
  createMatch, startLife, endLifeByDeath, endLifeByWin, settleBotKill, getWallet, DEFAULT_STAKE_CENTS,
  practiceStake, practiceReward, getPracticeWallet, recordBotFlag,
} from './economy.mjs';
import { scoreTelemetry, SUSPECT_THRESHOLD, noteInput, noteDeath, noteRespawn } from './antibot.mjs';
import { newRound } from './fairness.mjs';

const MAX_SLOTS = 16;
const MIN_HUMANS = 2;
const TICK_MS = 1000 / 12;
const RESPAWN_TICKS = 24;        // bots come back ~2s after death
const SEND_HIGH_WATER = 128 * 1024; // bytes buffered to a socket before we treat the client as "behind"
const SEND_RESYNC_LOW = 16 * 1024;  // once its buffer drains below this, resync that client with a keyframe
const IDLE_WARN_TICKS = 6 * 12;     // show the inactivity countdown over the last 6 seconds
const EPOCH_TICKS = 12 * 60 * 3; // ~3 min of active play per provably-fair epoch
const INTERMISSION_TICKS = 12 * 3; // ~3s frozen "match over" beat after a domination, before the next PAID match

function sanitizeName(n) {
  if (typeof n !== 'string') return '';
  return n.replace(/[^\w \-]/g, '').trim().slice(0, 16);
}

export class Arena {
  constructor({ mode = 'wager', minHumans } = {}) {
    this.mode = mode;                 // 'wager' (paid) | 'free' (bots, no money)
    this.maxSlots = MAX_SLOTS;
    // free arena starts the moment one human is in (play vs bots, no waiting)
    this.minHumans = minHumans != null ? minHumans : (mode === 'free' ? 1 : MIN_HUMANS);
    this.stakeCents = DEFAULT_STAKE_CENTS;
    // provably-fair: commit to a secret seed, seed the house RNG from it, reveal on rotation
    this.fair = newRound();
    this.epoch = 1;
    this.reveals = [];          // recent {epoch, commit, serverSeed} for /fairness audit
    this._epochStartTick = 0;
    this.game = createGame({
      cols: 110, rows: 110, ticksPerSecond: 12, botCount: MAX_SLOTS - 1, startRadius: 1,
      seed: this.fair.numericSeed,
    });
    // All slots start as (unowned) bots — even slot 0, which createGame marks human.
    this.game.players[0].isHuman = false;
    this.game.players[0].name = 'Bot 0';

    this.bots = new BotController({ seed: this.game.config.seed });
    this.snap = new Snapshotter(this.game);
    this.sessions = new Set();
    this.slotSession = new Array(MAX_SLOTS).fill(null);
    this.lives = new Array(MAX_SLOTS).fill(null); // per-slot economic "life" or null
    this.fragCount = new Int16Array(MAX_SLOTS);   // per-slot kills this life (bots too) for the live board
    this.metaDirty = new Set();
    this.deadTicks = new Int16Array(MAX_SLOTS);
    this.status = STATUS.WAITING;
    this._wasActive = false;
    this._sentWaiting = false;
    this.phase = 'live';            // 'live' | 'intermission' (post-domination match-over freeze)
    this._intermissionLeft = 0;
    this.match = mode === 'wager' ? createMatch('wager', this.stakeCents, this.game.config.seed) : null;
  }

  createSession() { return new Session(); }

  // advisory anti-bot evaluation — flag a suspicious session once (never auto-bans)
  _evalBot(s) {
    if (!s || !s.userId || s.tel.flagged) return;
    const r = scoreTelemetry(s.tel);
    if (r.score >= SUSPECT_THRESHOLD) {
      s.tel.flagged = true;
      recordBotFlag(s.userId, r.score, r.reasons);
      console.log(`[antibot] flagged ${s.userId} score=${r.score.toFixed(2)} [${r.reasons.join(', ')}]`);
    }
  }

  start() {
    this._nextTickAt = performance.now();
    const loop = () => {
      const now = performance.now();
      while (now >= this._nextTickAt) {
        this.step();
        this._nextTickAt += TICK_MS;
        if (now - this._nextTickAt > 5 * TICK_MS) this._nextTickAt = now; // fell behind: don't spiral
      }
      this._timer = setTimeout(loop, Math.max(0, this._nextTickAt - performance.now()));
    };
    loop();
  }

  countHumans() {
    let c = 0;
    for (const s of this.sessions) if (s.slotId >= 0) c += 1;
    return c;
  }

  step() {
    // Post-domination match-over: the final conquered board sits FROZEN for everyone (no
    // sim, no deltas) while each player holds on their result screen, then a fresh PAID
    // match opens. This makes a win a discrete game that ends for all — the next one costs
    // a new stake.
    if (this.phase === 'intermission') {
      this._intermissionLeft -= 1;
      if (this._intermissionLeft > 0) return;
      this._startNextMatch();
      return;
    }
    const humans = this.countHumans();
    this.status = humans >= this.minHumans ? STATUS.ACTIVE : STATUS.WAITING;

    if (this.status === STATUS.WAITING) {
      this._wasActive = false;
      if (!this._sentWaiting) { this.broadcastStatus(humans); this._sentWaiting = true; }
      return; // freeze the world until 2 humans are present
    }
    this._sentWaiting = false;

    // waiting -> active: re-baseline + hand everyone a fresh keyframe.
    if (!this._wasActive) {
      this.snap.resync(this.game);
      for (const s of this.sessions) this.sendKeyframe(s);
      this._wasActive = true;
    }

    // 1. apply queued human inputs
    for (const s of this.sessions) {
      if (s.slotId >= 0 && s.pendingDir) { setDirection(this.game, s.slotId, s.pendingDir); s.pendingDir = null; }
    }
    // 2. drive bots (skips human-controlled slots)
    this.bots.decide(this.game);
    // 3. advance the authoritative sim
    const events = tickGame(this.game);
    // 4. neutralize the engine's GLOBAL game-over (a single human death must not
    //    freeze the continuous arena); per-player death travels via events.
    this.game.over = false;
    this.game.deathReason = null;
    // 5. track peak area for live lives, then settle deaths economically.
    for (let id = 0; id < MAX_SLOTS; id += 1) {
      const life = this.lives[id];
      if (life && this.game.players[id].alive) life.maxArea = Math.max(life.maxArea, this.game.players[id].area);
    }
    for (const e of events) {
      if (e.type !== 'death') continue;
      if (e.killerId != null && e.killerId !== e.id) this.fragCount[e.killerId] += 1; // any killer (bot too)
      this.onDeath(e);
    }
    // 5b. domination: a player conquered the board → settle their win + reset the round.
    const dom = events.find((e) => e.type === 'domination');
    if (dom) this._onDomination(dom.id);
    // 6. respawn dead BOT slots (humans respawn on request)
    for (let id = 0; id < MAX_SLOTS; id += 1) {
      const p = this.game.players[id];
      if (p.alive) { this.deadTicks[id] = 0; continue; }
      if (p.isHuman) continue;
      this.deadTicks[id] += 1;
      if (this.deadTicks[id] >= RESPAWN_TICKS) { respawnPlayer(this.game, id); this.deadTicks[id] = 0; this.fragCount[id] = 0; }
    }
    // 7. broadcast the delta + (a few times a second) the live scoreboard
    const delta = this.snap.build(this.game, this.status, this.metaDirty, events);
    this.metaDirty.clear();
    this.broadcast(delta);
    if (this.game.tick % 6 === 0) this.broadcastScoreboard();
    this.broadcastIdleWarnings();
    // 8. rotate the provably-fair epoch (reveal the old seed, commit to a new one)
    if (this.game.tick - this._epochStartTick >= EPOCH_TICKS) this._rollEpoch();
  }

  // Tell each human how many seconds until inactivity death — only inside the warning
  // window and only when the displayed second changes (so it isn't spammed every tick).
  broadcastIdleWarnings() {
    const limit = this.game.config.idleDeathTicks;
    if (!limit) return;
    for (const s of this.sessions) {
      if (s.slotId < 0) continue;
      const p = this.game.players[s.slotId];
      let secs = 0;
      if (p && p.alive) {
        const left = limit - p.idleTicks;
        if (left > 0 && left <= IDLE_WARN_TICKS) secs = Math.ceil(left / 12);
      }
      if (s.idleWarn !== secs) { s.idleWarn = secs; this.sendJSON(s, { type: 'idle', seconds: secs }); }
    }
  }

  // ── provably-fair epoch rotation ─────────────────────────────────────────────
  // The just-ended epoch's seed is now safe to reveal (its outcomes are in the past);
  // anyone can check sha256(serverSeed) === the commit we published for that epoch.
  // Then we commit to a fresh secret seed and re-seed the house RNG from it.
  _rollEpoch() {
    this.reveals.unshift({ epoch: this.epoch, commit: this.fair.commit, serverSeed: this.fair.serverSeed });
    if (this.reveals.length > 20) this.reveals.length = 20;
    this.fair = newRound();
    this.epoch += 1;
    this._epochStartTick = this.game.tick;
    this.game.rng = makeRng(this.fair.numericSeed);
  }
  getFairness() {
    return { mode: this.mode, epoch: this.epoch, commit: this.fair.commit, epochTicks: EPOCH_TICKS, reveals: this.reveals };
  }

  // Top players by kills (alive only; bots included) for the in-game corner board.
  buildScoreboard() {
    const share = Math.floor(this.stakeCents * 0.75); // ◇ per kill (wager only)
    const rows = [];
    for (let id = 0; id < MAX_SLOTS; id += 1) {
      const p = this.game.players[id];
      if (!p.alive) continue;
      rows.push({ id, name: p.name, kills: this.fragCount[id], area: p.area, bot: !p.isHuman });
    }
    rows.sort((a, b) => b.kills - a.kills || b.area - a.area);
    return rows.slice(0, 5).map((r) => ({
      id: r.id, name: r.name, kills: r.kills, bot: r.bot,
      earnedCents: r.kills * share,
    }));
  }
  broadcastScoreboard() {
    const msg = JSON.stringify({ type: 'scoreboard', rows: this.buildScoreboard() });
    for (const s of this.sessions) if (s.ws && !s.behind) try { s.ws.send(msg); } catch {}
  }

  // ── economy: settle one death event ──────────────────────────────────────────
  onDeath(e) {
    const killerSlot = (e.killerId != null && e.killerId !== e.id) ? e.killerId : -1;
    const killerLife = killerSlot >= 0 ? this.lives[killerSlot] : null;
    const life = this.lives[e.id];
    let rewardCents = 0;

    // settle the victim's wager (only if it was an economic life)
    if (life && life.mpId != null) {
      const killerUserId = killerLife && killerLife.mpId != null ? killerLife.userId : null;
      const killerMpId = killerLife && killerLife.mpId != null ? killerLife.mpId : null;
      const res = endLifeByDeath(life.mpId, {
        killerUserId, killerMpId, reason: e.reason,
        victimKills: life.kills, victimArea: life.maxArea, victimDurationMs: Date.now() - life.startMs,
      });
      if (res) rewardCents = res.payoutToKillerCents;
    } else if (!life && killerLife && killerLife.mpId != null) {
      // bot victim, human killer: bots count as if they paid the entry fee → mint the reward
      rewardCents = settleBotKill(killerLife.userId, killerLife.mpId, this.stakeCents, `${killerLife.mpId}:${killerLife.kills + 1}`);
    } else if (killerLife && killerLife.practice && killerLife.userId) {
      // free arena: fake reward to the practice balance (any victim, including bots)
      rewardCents = Math.floor(this.stakeCents * 0.75);
      practiceReward(killerLife.userId, rewardCents);
    }

    // tell the victim they died, with their run stats
    if (life) {
      this.lives[e.id] = null;
      const vs = this.slotSession[e.id];
      const lostC = (life.mpId != null || life.practice) ? life.stakeCents : 0;
      if (vs) this.sendJSON(vs, {
        type: 'death', reason: e.reason, mode: life.mode, practice: !!life.practice,
        areaCells: life.maxArea, areaPct: life.maxArea / this.game.cellCount,
        kills: life.kills, durationMs: Date.now() - life.startMs,
        lostCents: lostC, earnedCents: life.earnedCents, netCents: life.earnedCents - lostC,
        wallet: life.mpId != null && life.userId ? getWallet(life.userId) : null,
        practiceBalanceCents: life.practice && life.userId ? getPracticeWallet(life.userId).practiceBalanceCents : null,
      });
      // anti-bot telemetry: record the death + (advisory) flag a suspicious session
      if (vs) { noteDeath(vs.tel, e.reason, Date.now()); this._evalBot(vs); }
    }

    // credit a HUMAN killer — bot victims count toward the frag tally too (so the
    // in-game kill counter moves), but only a wager human victim pays out money.
    if (killerLife) {
      killerLife.kills += 1;
      killerLife.earnedCents += rewardCents;
      const ks = this.slotSession[killerSlot];
      if (ks) this.sendJSON(ks, {
        type: 'kill', rewardCents, kills: killerLife.kills,
        wallet: killerLife.mpId != null && killerLife.userId ? getWallet(killerLife.userId) : null,
      });
    }
  }

  // ── domination win — MATCH OVER for everyone ────────────────────────────────────
  // A player conquered the whole arena → the match ENDS for all. The conqueror's per-kill
  // rewards were already paid (each rival died this tick, credited to them); here we return
  // THEIR stake (a win, not a loss) and show them the victory screen. Every rival already
  // got a 'conquered' death screen; remaining clients (spectating/waiting) get a match-over
  // notice. Then the whole arena FREEZES for a short beat (the final conquered board stays
  // on screen) before a fresh PAID match opens — playing again costs a new stake.
  _onDomination(slot) {
    const s = this.slotSession[slot];
    const life = this.lives[slot];
    const winnerName = this.game.players[slot] ? this.game.players[slot].name : 'Player';
    if (life) {
      let returned = 0;
      if (life.mpId != null && s) {
        const r = endLifeByWin(life.mpId, { victimKills: life.kills, victimArea: life.maxArea, victimDurationMs: Date.now() - life.startMs });
        returned = r ? r.returnedCents : 0;
      } else if (life.practice && s) {
        practiceReward(s.userId, life.stakeCents); // return the practice stake on a win
        returned = life.stakeCents;
      }
      if (s) this.sendJSON(s, {
        type: 'victory', mode: life.mode, practice: !!life.practice,
        kills: life.kills, earnedCents: life.earnedCents, returnedCents: returned,
        areaCells: life.maxArea, areaPct: life.maxArea / this.game.cellCount,
        durationMs: Date.now() - life.startMs,
        wallet: life.mpId != null && s.userId ? getWallet(s.userId) : null,
        practiceBalanceCents: life.practice && s.userId ? getPracticeWallet(s.userId).practiceBalanceCents : null,
      });
      this.lives[slot] = null;
    }
    // tell EVERYONE the match ended (winner & conquered already have richer screens; the
    // client only surfaces this as a toast when no result screen is already up).
    const over = { type: 'matchover', winner: winnerName, winnerSlot: slot };
    for (const o of this.sessions) this.sendJSON(o, over);
    // freeze the arena on the final board, then open the next match.
    this.phase = 'intermission';
    this._intermissionLeft = INTERMISSION_TICKS;
  }

  // End of the frozen interlude → a brand-new PAID match: roll a fresh provably-fair seed
  // (a new match deserves a new commit), wipe the board, and honour any "play again" the
  // players queued while the arena was frozen.
  _startNextMatch() {
    this._rollEpoch();   // reveal the just-ended match's seed, commit + reseed a new one
    this._resetBoard();
    this.phase = 'live';
    for (const s of this.sessions) {
      if (s.queuedRespawn) { s.queuedRespawn = false; this.respawn(s); }
      else if (s.queuedJoinName != null) { const n = s.queuedJoinName; s.queuedJoinName = null; this.joinSlot(s, n); }
    }
  }

  // Fresh round: wipe the whole grid, respawn bots onto new homes, leave humans (the winner
  // + the conquered) dead so they re-enter via their result screen, then re-baseline every
  // client with a keyframe (the board changed wholesale, a delta would be huge).
  _resetBoard() {
    this.game.owner.fill(-1);
    this.game.trail.fill(-1);
    for (let id = 0; id < MAX_SLOTS; id += 1) {
      const p = this.game.players[id];
      p.area = 0; p.trailCells.length = 0; p.idleTicks = 0; p._stuckTicks = 0;
      this.fragCount[id] = 0; this.deadTicks[id] = 0;
      const s = this.slotSession[id];
      if (s && s.slotId === id) p.alive = false;     // winner + conquered humans re-enter on request
      else respawnPlayer(this.game, id);             // bots get a fresh home
    }
    this.game.version += 1;
    this.snap.resync(this.game);
    for (const s of this.sessions) this.sendKeyframe(s);
  }

  // ── socket lifecycle ────────────────────────────────────────────────────────
  onOpen(ws) {
    ws.data.session.ws = ws;
    this.sessions.add(ws.data.session);
  }

  onClose(ws) {
    const s = ws.data.session;
    this.releaseSlot(s);
    this.sessions.delete(s);
  }

  onMessage(ws, msg) {
    const s = ws.data.session;
    if (typeof msg === 'string') { this.onControl(s, msg); return; }
    const ab = msg.buffer ? msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) : msg;
    if (peekOp(ab) === OP.INPUT) {
      s.pendingDir = decodeInput(ab);
      noteInput(s.tel, Date.now());
      if (s.tel.inputs % 40 === 0) this._evalBot(s); // periodic check (a bot may never die)
    }
  }

  onControl(s, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.type === 'hello') this.joinSlot(s, m.name);
    else if (m.type === 'respawn') this.respawn(s);
    else if (m.type === 'resync') this.sendKeyframe(s);
    else if (m.type === 'ping') this.sendJSON(s, { type: 'pong', t: m.t });
  }

  // Open a fresh economic life for a wager slot (freeze the stake). Returns false
  // and notifies the client if they cannot afford it. Practice lives are free.
  openLife(s, slot) {
    const area = this.game.players[slot].area;
    const base = { mpId: null, userId: s.userId || null, mode: this.mode, practice: false, stakeCents: 0, kills: 0, earnedCents: 0, maxArea: area, startMs: Date.now() };
    if (this.mode === 'wager') {
      const mpId = startLife(s.userId, this.match, slot, this.stakeCents);
      if (mpId == null) { this.sendJSON(s, { type: 'error', code: 'insufficient_funds' }); return false; }
      this.lives[slot] = { ...base, mpId, stakeCents: this.stakeCents };
      this.sendJSON(s, { type: 'wallet', ...getWallet(s.userId) });
    } else if (s.userId) {
      // free arena, logged in → PRACTICE economy: same mechanics on a fake, refillable
      // balance so the player sees what they'd earn (and is enticed to play for real).
      if (!practiceStake(s.userId, this.stakeCents)) { this.sendJSON(s, { type: 'error', code: 'practice_empty' }); return false; }
      this.lives[slot] = { ...base, practice: true, stakeCents: this.stakeCents };
    } else {
      this.lives[slot] = base; // anonymous free → no economy
    }
    return true;
  }

  // ── join / leave ────────────────────────────────────────────────────────────
  joinSlot(s, name) {
    if (s.slotId >= 0) { this.sendKeyframe(s); return; } // already in
    // arena frozen between matches: remember the request and honour it when the next one opens
    if (this.phase === 'intermission') { s.queuedJoinName = name || ''; return; }
    // one active life per user — block a second tab from staking the same account twice
    if (s.userId) {
      for (const o of this.sessions) {
        if (o !== s && o.userId === s.userId && o.slotId >= 0) {
          this.sendJSON(s, { type: 'error', code: 'already_in_game' });
          return;
        }
      }
    }
    // prefer taking over an ALIVE bot in place (seamless "player instead of bot")
    let slot = -1;
    for (let id = 0; id < MAX_SLOTS; id += 1) {
      if (this.slotSession[id] === null && this.game.players[id].alive) { slot = id; break; }
    }
    let wasDead = false;
    if (slot < 0) {
      for (let id = 0; id < MAX_SLOTS; id += 1) if (this.slotSession[id] === null) { slot = id; break; }
      wasDead = slot >= 0;
    }
    if (slot < 0) { this.sendJSON(s, { type: 'error', code: 'full' }); return; }

    if (wasDead) respawnPlayer(this.game, slot); // it was dead: give a fresh home
    if (!this.openLife(s, slot)) { if (wasDead) this.game.players[slot].alive = false; return; } // stake refused

    const p = this.game.players[slot];
    p.isHuman = true;
    p.name = sanitizeName(name) || s.name || `Player ${slot}`;
    s.slotId = slot;
    s.name = p.name;
    this.slotSession[slot] = s;
    this.metaDirty.add(slot);
    this.deadTicks[slot] = 0;
    this.fragCount[slot] = 0;
    this.sendKeyframe(s);
  }

  respawn(s) {
    if (s.slotId < 0) return;
    if (this.phase === 'intermission') { s.queuedRespawn = true; return; } // wait for the next match
    if (this.game.players[s.slotId].alive) return; // not actually dead
    noteRespawn(s.tel, Date.now()); // anti-bot: how fast after death they re-enter
    if (!this.openLife(s, s.slotId)) return;       // stake refused → stay on death screen
    respawnPlayer(this.game, s.slotId);
    this.metaDirty.add(s.slotId);
    this.deadTicks[s.slotId] = 0;
    this.fragCount[s.slotId] = 0;
  }

  releaseSlot(s) {
    const id = s.slotId;
    if (id < 0) return;
    // Disconnecting/leaving mid-life forfeits the stake to the house (idempotent:
    // a life already settled by death/cash-out is a no-op here).
    const life = this.lives[id];
    if (life && life.mpId != null) {
      endLifeByDeath(life.mpId, { killerUserId: null, reason: 'forfeit', victimKills: life.kills, victimArea: life.maxArea, victimDurationMs: Date.now() - life.startMs });
    }
    this.lives[id] = null;
    this.fragCount[id] = 0;
    const p = this.game.players[id];
    p.isHuman = false;
    p.name = `Bot ${id}`;
    const c = this.game.config;
    p.maxTrail = c.minBotTrail + Math.floor(this.game.rng() * (c.maxBotTrail - c.minBotTrail + 1));
    this.slotSession[id] = null;
    this.metaDirty.add(id);
    s.slotId = -1;
    s.pendingDir = null;
  }

  // ── send helpers ────────────────────────────────────────────────────────────
  sendKeyframe(s) {
    if (!s.ws) return;
    try { s.ws.send(encodeKeyframe(this.game, s.slotId >= 0 ? s.slotId : 0, this.status)); } catch {}
  }
  sendJSON(s, obj) { if (s.ws) try { s.ws.send(JSON.stringify(obj)); } catch {} }
  // Backpressure-aware broadcast. A slow client (e.g. flaky mobile link) can't drain 12
  // deltas/s; if we keep sending, its socket buffer balloons into a multi-second freeze.
  // So when a socket falls behind we STOP feeding it deltas until it drains, then hand it
  // a fresh keyframe to re-baseline (deltas are incremental, so skipped ones can't be lost).
  broadcast(buf) {
    for (const s of this.sessions) {
      if (!s.ws) continue;
      let buffered = 0;
      try { buffered = s.ws.getBufferedAmount ? s.ws.getBufferedAmount() : 0; } catch {}
      if (buffered > SEND_HIGH_WATER) {
        if (!s.behind) { s.behind = true; console.log(`[net] slot ${s.slotId} behind (buffered=${buffered}) — throttling`); }
        continue;
      }
      if (s.behind) {
        if (buffered > SEND_RESYNC_LOW) continue; // still draining the backlog
        s.behind = false;
        console.log(`[net] slot ${s.slotId} drained → keyframe resync`);
        this.sendKeyframe(s);
        continue;
      }
      try { s.ws.send(buf); } catch {}
    }
  }
  broadcastStatus(humans) {
    const msg = JSON.stringify({ type: 'status', status: 'waiting', humans, needed: this.minHumans });
    for (const s of this.sessions) if (s.ws) try { s.ws.send(msg); } catch {}
  }
}
