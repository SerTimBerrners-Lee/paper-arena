// botController.mjs
// Deterministic bot AI, called once per tick. For every alive bot it scores its
// (non-reversing) headings and queues the best via setDirection().
//
// Smarts:
//   • Lookahead — never picks a move that dead-ends (no safe follow-up).
//   • Evade — if an enemy head is closing in while we're exposed, sprint home.
//   • Return — carve to a target length, then re-enter the NEAREST owned cell to
//     close the loop and capture (not just the far spawn).
//   • Attack — from home, hunt the nearest enemy trail within range and cut it.
//   • Explore — otherwise push outward into fresh ground.
//
// Safety: never steps into a wall or its own trail.

import { DIRS, OPPOSITE, setDirection } from '../core/gameCore.mjs';

const ATTACK_RADIUS = 11;

const RIGHT = { up: 'right', right: 'down', down: 'left', left: 'up' };
const LEFT = { up: 'left', left: 'down', down: 'right', right: 'up' };
function turnOf(dir, side) { return side === 'left' ? LEFT[dir] : RIGHT[dir]; }

export class BotController {
  constructor({ seed = 1 } = {}) { this.reset(seed); }

  reset(seed = 1) {
    let a = (seed >>> 0) || 1;
    this._rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // is moving `dir` from (x,y) immediately safe for player id? (in-bounds, not own trail)
  _safe(game, id, x, y, dir) {
    const [dx, dy] = DIRS[dir];
    const nx = x + dx; const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= game.cols || ny >= game.rows) return false;
    if (game.trail[ny * game.cols + nx] === id) return false;
    return true;
  }

  // how many safe onward moves exist after arriving at (x,y) heading `dir`?
  _escapes(game, id, x, y, dir) {
    let c = 0;
    if (this._safe(game, id, x, y, dir)) c += 1;
    if (this._safe(game, id, x, y, turnOf(dir, 'left'))) c += 1;
    if (this._safe(game, id, x, y, turnOf(dir, 'right'))) c += 1;
    return c;
  }

  decide(game) {
    const { cols, rows, players, owner, trail } = game;
    for (let id = 0; id < players.length; id += 1) {
      const bot = players[id];
      if (!bot.alive || bot.isHuman) continue;

      const onOwnLand = owner[bot.y * cols + bot.x] === bot.id;
      const trailLen = bot.trailCells.length;

      // nearest enemy head (manhattan) — for evasion while exposed
      let nearestEnemy = Infinity;
      for (const q of players) {
        if (q.id === id || !q.alive) continue;
        const d = Math.abs(q.x - bot.x) + Math.abs(q.y - bot.y);
        if (d < nearestEnemy) nearestEnemy = d;
      }
      const threatened = trailLen > 0 && nearestEnemy <= 4;
      const returning = (trailLen >= bot.maxTrail && !onOwnLand) || threatened;

      // ATTACK: from safety, hunt the nearest enemy trail cell to cut it.
      let attack = null;
      if (onOwnLand && trailLen === 0) {
        let bestDist = ATTACK_RADIUS + 1;
        for (let dy = -ATTACK_RADIUS; dy <= ATTACK_RADIUS; dy += 1) {
          for (let dx = -ATTACK_RADIUS; dx <= ATTACK_RADIUS; dx += 1) {
            const nx = bot.x + dx; const ny = bot.y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const tr = trail[ny * cols + nx];
            if (tr >= 0 && tr !== id) {
              const dist = Math.abs(dx) + Math.abs(dy);
              if (dist < bestDist) { bestDist = dist; attack = { x: nx, y: ny }; }
            }
          }
        }
      }

      // RETURN target: the NEAREST owned cell (fall back to spawn).
      let home = null;
      if (returning) {
        const R = Math.min(22, trailLen + 6);
        let hd = Infinity;
        for (let dy = -R; dy <= R; dy += 1) {
          for (let dx = -R; dx <= R; dx += 1) {
            const nx = bot.x + dx; const ny = bot.y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (owner[ny * cols + nx] === id) {
              const d = Math.abs(dx) + Math.abs(dy);
              if (d < hd) { hd = d; home = { x: nx, y: ny }; }
            }
          }
        }
        if (!home) home = { x: bot.spawnX, y: bot.spawnY };
      }

      const candidates = [bot.dir, turnOf(bot.dir, 'left'), turnOf(bot.dir, 'right')]
        .filter((d) => d !== OPPOSITE[bot.dir]);

      let best = null; let bestScore = -Infinity;
      for (const dir of candidates) {
        const [dx, dy] = DIRS[dir];
        const nx = bot.x + dx; const ny = bot.y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue; // wall
        const ni = ny * cols + nx;
        if (trail[ni] === bot.id) continue; // own trail = death

        let score = dir === bot.dir ? 2 : 0; // momentum
        const esc = this._escapes(game, id, nx, ny, dir);
        if (esc === 0) score -= 500; else score += esc * 4; // never box yourself in

        if (attack) {
          if (trail[ni] >= 0 && trail[ni] !== id) score += 300; // step ON the trail = the cut
          const dn = Math.abs(bot.x - attack.x) + Math.abs(bot.y - attack.y);
          const dl = Math.abs(nx - attack.x) + Math.abs(ny - attack.y);
          score += (dn - dl) * 22;
        } else if (returning) {
          const dh = Math.abs(nx - home.x) + Math.abs(ny - home.y);
          score += 60 - dh;
          if (owner[ni] === bot.id) score += 35; // re-enter land → closes the loop
        } else {
          score += owner[ni] === bot.id ? -2 : 6; // venture out for fresh ground
          const edge = Math.min(nx, ny, cols - 1 - nx, rows - 1 - ny);
          score += Math.min(edge, 5);
          score += this._rng() * 2;
        }

        if (score > bestScore) { bestScore = score; best = dir; }
      }

      if (best) setDirection(game, id, best);
    }
  }
}
