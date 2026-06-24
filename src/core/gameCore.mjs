// gameCore.mjs
// Grid-based Paper.io core. Deterministic, allocation-light, framework-free.
//
// Model:
//   - The world is a `cols x rows` grid. Cell index = y * cols + x.
//   - `owner[i]`  = player id that owns the territory cell, or -1 (empty).
//   - `trail[i]`  = player id whose active trail occupies the cell, or -1.
//   - Players move exactly one cell per tick. Tick rate sets the speed; the
//     renderer interpolates between `prevX/prevY` and `x/y` for smoothness.
//   - Leaving your territory lays a trail. Returning to your territory closes
//     the loop and captures everything enclosed by (territory + trail) via a
//     flood fill from the border.
//
// No polygon clipping, no triangulation, no per-frame mesh work. The whole
// map is just two typed arrays the renderer turns into one texture.

export const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export const OPPOSITE = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

// Clockwise / counter-clockwise turn tables (used by relative input + bots).
const TURN_RIGHT = { up: 'right', right: 'down', down: 'left', left: 'up' };
const TURN_LEFT = { up: 'left', left: 'down', down: 'right', right: 'up' };

export function turn(dir, side) {
  return side === 'left' ? TURN_LEFT[dir] : TURN_RIGHT[dir];
}

const DEFAULT_PALETTE = [
  [0x00, 0xe5, 0xff], // human  - neon cyan
  [0xff, 0x2b, 0xd6], // hot magenta
  [0xf7, 0xee, 0x12], // electric yellow
  [0x2d, 0xff, 0x9e], // neon spring
  [0x2f, 0x8b, 0xff], // electric blue
  [0xff, 0x7a, 0x18], // neon orange
  [0xb1, 0x5b, 0xff], // violet
  [0xff, 0x3b, 0x6b], // hot rose
  [0xa6, 0xff, 0x1a], // acid lime
  [0x14, 0xf0, 0xc8], // neon teal
  [0xff, 0x6f, 0xae], // neon pink
  [0x6a, 0x7b, 0xff], // indigo
];

const DEFAULT_CONFIG = {
  cols: 110,
  rows: 110,
  ticksPerSecond: 12,
  botCount: 8,
  startRadius: 1, // owned block is (2r+1) square => radius 1 = 3x3
  minBotTrail: 9,
  maxBotTrail: 24,
  seed: 1,
  idleDeathSeconds: 20, // camp safe on your own land this long (no trail/capture/kill) → die of inactivity (0 = off)
};

// ---- seeded RNG (mulberry32) -------------------------------------------------

export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- construction ------------------------------------------------------------

export function createGame(userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  // resolve the inactivity limit to ticks so it scales with the tick rate
  config.idleDeathTicks = config.idleDeathTicks != null
    ? config.idleDeathTicks
    : Math.round((config.idleDeathSeconds || 0) * config.ticksPerSecond);
  const { cols, rows } = config;
  const n = cols * rows;

  const game = {
    config,
    cols,
    rows,
    cellCount: n,
    tick: 0,
    over: false,
    deathReason: null,
    owner: new Int16Array(n).fill(-1),
    trail: new Int16Array(n).fill(-1),
    // bumped on every owner/trail change so the renderer rebuilds lazily
    version: 1,
    // bumped ONLY when territory (owner[]) changes — lets renderer skip trail-only ticks
    ownerVersion: 1,
    players: [],
    events: [],
    rng: makeRng(config.seed),
    // scratch buffers reused by capture() to avoid per-capture allocation
    _visited: new Uint8Array(n),
    _stamp: new Int32Array(n),
    _stampCounter: 0,
    _queue: new Int32Array(n),
  };

  spawnPlayers(game);
  return game;
}

function spawnPlayers(game) {
  const { cols, rows, config } = game;
  const total = 1 + config.botCount;
  const r = config.startRadius;
  const margin = r + 3;
  const minDist = Math.max(8, Math.floor(Math.min(cols, rows) / (total > 6 ? 6 : 4)));

  const centers = [];
  let guard = 0;
  while (centers.length < total && guard < total * 400) {
    guard += 1;
    const cx = margin + Math.floor(game.rng() * (cols - margin * 2));
    const cy = margin + Math.floor(game.rng() * (rows - margin * 2));
    let ok = true;
    for (const c of centers) {
      const dx = c.x - cx;
      const dy = c.y - cy;
      if (dx * dx + dy * dy < minDist * minDist) {
        ok = false;
        break;
      }
    }
    if (ok) centers.push({ x: cx, y: cy });
  }
  // Fallback if we could not place enough with spacing: deterministic grid.
  while (centers.length < total) {
    const k = centers.length;
    const gx = margin + ((k * 13) % Math.max(1, cols - margin * 2));
    const gy = margin + ((k * 29) % Math.max(1, rows - margin * 2));
    centers.push({ x: gx, y: gy });
  }

  const dirs = ['up', 'down', 'left', 'right'];
  for (let id = 0; id < total; id += 1) {
    const { x, y } = centers[id];
    const color = DEFAULT_PALETTE[id % DEFAULT_PALETTE.length];
    const player = {
      id,
      name: id === 0 ? 'You' : `Bot ${id}`,
      isHuman: id === 0,
      color,
      x,
      y,
      prevX: x,
      prevY: y,
      spawnX: x,
      spawnY: y,
      dir: dirs[Math.floor(game.rng() * 4)],
      nextDir: null,
      alive: true,
      area: 0,
      idleTicks: 0, // ticks spent camping (no trail/capture/kill) on own land; resets on activity
      trailCells: [],
      // bot bookkeeping
      maxTrail:
        config.minBotTrail +
        Math.floor(game.rng() * (config.maxBotTrail - config.minBotTrail + 1)),
      _reason: null,
      tx: x,
      ty: y,
    };
    game.players.push(player);

    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const gx = x + dx;
        const gy = y + dy;
        if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
        setOwner(game, gy * cols + gx, id);
      }
    }
  }
  game.version += 1;
}

// Bring a dead player back: find a low-occupancy spot, stamp a fresh home, reset
// movement state, and grant brief spawn invincibility. (Used for bots; the human
// ending the run is handled by the caller.)
export function respawnPlayer(game, id) {
  const p = game.players[id];
  if (!p) return null;
  const { cols, rows, config } = game;
  const r = config.startRadius;
  const margin = r + 3;

  // Farthest-point sampling: among many candidates, prefer a spot whose 3x3 home
  // lands on EMPTY land AND sits as far as possible from every other living player,
  // so respawns spread out across the arena instead of popping up next to someone.
  let best = null;
  let bestScore = -Infinity;
  for (let tries = 0; tries < 64; tries += 1) {
    const x = margin + Math.floor(game.rng() * (cols - margin * 2));
    const y = margin + Math.floor(game.rng() * (rows - margin * 2));
    let occupied = 0;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const gx = x + dx;
        const gy = y + dy;
        if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) { occupied += 5; continue; }
        if (game.owner[gy * cols + gx] >= 0) occupied += 1;
      }
    }
    // squared distance to the nearest OTHER living player (want it large)
    let nearest = Infinity;
    for (const q of game.players) {
      if (q.id === id || !q.alive) continue;
      const qdx = q.x - x;
      const qdy = q.y - y;
      const d2 = qdx * qdx + qdy * qdy;
      if (d2 < nearest) nearest = d2;
    }
    const spread = nearest === Infinity ? cols * rows : Math.sqrt(nearest);
    // free footprint dominates (heavy penalty); among free spots, the farthest wins.
    const score = spread - occupied * 1000;
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }

  const cx = best.x;
  const cy = best.y;
  p.alive = true;
  p.x = cx;
  p.y = cy;
  p.prevX = cx;
  p.prevY = cy;
  p.spawnX = cx;
  p.spawnY = cy;
  p.tx = cx;
  p.ty = cy;
  const dirs = ['up', 'down', 'left', 'right'];
  p.dir = dirs[Math.floor(game.rng() * 4)];
  p.nextDir = null;
  p.trailCells.length = 0;
  p._reason = null;
  p.idleTicks = 0;
  p.maxTrail =
    config.minBotTrail +
    Math.floor(game.rng() * (config.maxBotTrail - config.minBotTrail + 1));

  for (let dy = -r; dy <= r; dy += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      const gx = cx + dx;
      const gy = cy + dy;
      if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) continue;
      setOwner(game, gy * cols + gx, id);
    }
  }
  game.version += 1;
  return p;
}

// ---- low level cell mutation (keeps per-player area counts in sync) ----------

function setOwner(game, i, id) {
  const prev = game.owner[i];
  if (prev === id) return;
  if (prev >= 0) game.players[prev].area -= 1;
  game.owner[i] = id;
  if (id >= 0) game.players[id].area += 1;
  game.ownerVersion += 1;
}

// ---- public input ------------------------------------------------------------

export function setDirection(game, playerId, dir) {
  const p = game.players[playerId];
  if (!p || !p.alive || !DIRS[dir]) return;
  // queued; validated against the live heading at tick time
  p.nextDir = dir;
}

// ---- simulation --------------------------------------------------------------

export function tickGame(game) {
  game.events = [];
  if (game.over) return game.events;

  const { players, cols, rows } = game;

  // 1. Apply queued direction (never a 180° reversal) and compute targets.
  for (const p of players) {
    if (!p.alive) continue;
    if (p.nextDir && p.nextDir !== OPPOSITE[p.dir]) p.dir = p.nextDir;
    p.nextDir = null;
    p.prevX = p.x;
    p.prevY = p.y;
    const [dx, dy] = DIRS[p.dir];
    p.tx = p.x + dx;
    p.ty = p.y + dy;
    p._reason = null;
    p._killerId = null;
  }

  // 2. Resolve who dies this tick, from the grid state BEFORE anyone moves.
  const dead = new Set();

  // In-bounds movers (a player targeting a wall just stops; it can't collide).
  const movers = [];
  for (const p of players) {
    if (!p.alive) continue;
    if (p.tx < 0 || p.ty < 0 || p.tx >= cols || p.ty >= rows) continue;
    movers.push(p);
  }

  // 2a. COLLISIONS first. A wall-stuck player (its step would leave the grid)
  //     stays put and can be run over.
  const stuckAt = new Map();
  for (const p of players) {
    if (!p.alive) continue;
    const isMover = p.tx >= 0 && p.ty >= 0 && p.tx < cols && p.ty < rows;
    if (!isMover) stuckAt.set(p.y * cols + p.x, p);
  }
  // Group movers by the cell they move INTO.
  const byTarget = new Map();
  for (const p of movers) {
    const k = p.ty * cols + p.tx;
    const list = byTarget.get(k);
    if (list) list.push(p);
    else byTarget.set(k, [p]);
  }
  for (const [k, list] of byTarget) {
    const stuck = stuckAt.get(k);
    let survivor = null;
    if (list.length > 1) {
      // Head-on into one cell: the player whose TERRITORY that cell is wins (home
      // advantage); on neutral ground it's a 50/50 coin flip.
      const ownerId = game.owner[k];
      survivor = list.find((p) => p.id === ownerId) || list[Math.floor(game.rng() * list.length)];
      for (const q of list) if (q !== survivor) markDead(dead, q, 'collision', survivor.id);
    }
    // Running over a helpless (wall-stuck) player kills them — credit the runner.
    if (stuck) markDead(dead, stuck, 'collision', (survivor || list[0]).id);
  }
  // Swapping cells (adjacent, opposite headings): the player defending its OWN
  // territory wins; if both (or neither) are on home ground, a 50/50 coin flip.
  for (let a = 0; a < movers.length; a += 1) {
    for (let b = a + 1; b < movers.length; b += 1) {
      const A = movers[a];
      const B = movers[b];
      if (A.tx === B.x && A.ty === B.y && B.tx === A.x && B.ty === A.y) {
        if (dead.has(A) || dead.has(B)) continue;
        const aHome = game.owner[A.y * cols + A.x] === A.id;
        const bHome = game.owner[B.y * cols + B.x] === B.id;
        let victim;
        if (aHome && !bHome) victim = B;
        else if (bHome && !aHome) victim = A;
        else victim = game.rng() < 0.5 ? A : B;
        markDead(dead, victim, 'collision', (victim === A ? B : A).id);
      }
    }
  }

  // A player that LOST a collision doesn't also get to cut anyone — that's what
  // keeps a head-on a clean 50/50 (otherwise both sides cut each other's trail).
  // But WINNING a collision grants NO immunity to other rivals' trail cuts: if
  // someone crosses your trail this tick, you still go down.
  const collisionDead = new Set(dead);

  // 2b. TRAIL CUTS — stepping onto a trail kills the trail's owner (or yourself).
  for (const p of players) {
    if (!p.alive || collisionDead.has(p)) continue;
    if (p.tx < 0 || p.ty < 0 || p.tx >= cols || p.ty >= rows) continue; // stop at wall, don't die
    const i = p.ty * cols + p.tx;
    if (game.trail[i] === p.id) {
      // stepping onto your own trail is suicide (no killer)
      markDead(dead, p, 'self', null);
    } else if (game.trail[i] >= 0) {
      // stepping onto someone else's trail cuts THEM down — if you're out of your
      // territory leaving a trail, you are always vulnerable. `p` is the killer.
      const other = players[game.trail[i]];
      if (other && other.alive) markDead(dead, other, 'cut', p.id);
    }
  }

  // 3. Apply deaths.
  for (const p of dead) {
    killPlayer(game, p);
    game.events.push({ type: 'death', id: p.id, reason: p._reason, killerId: p._killerId ?? null });
    if (p.isHuman) {
      game.over = true;
      game.deathReason = p._reason;
    }
  }

  // 4. Survivors move, lay trail, and capture on loop closure.
  for (const p of movers) {
    // `|| !p.alive` matters: a player can be killed THIS tick by another player's
    // capture (enclosure / trail-sever below), which doesn't add them to `dead`.
    // Without this they'd take one more step and leave a stray trail cell.
    if (dead.has(p) || !p.alive) continue;
    p.x = p.tx;
    p.y = p.ty;
    const i = p.y * cols + p.x;
    if (game.owner[i] === p.id) {
      if (p.trailCells.length > 0) {
        const cells = captureTerritory(game, p);
        game.events.push({ type: 'capture', id: p.id, cells });
      }
    } else {
      game.trail[i] = p.id;
      p.trailCells.push(i);
      game.version += 1;
    }
  }

  // 5. Inactivity timer — a player camping SAFE on its own land (no open trail, no
  //    capture, no kill this tick) for `idleDeathTicks` ticks dies of inactivity.
  //    Leaving your territory (laying a trail), capturing, or killing keeps you active,
  //    so the only way this fires is genuine camping. Applies to humans and bots alike.
  const idleLimit = game.config.idleDeathTicks;
  if (idleLimit > 0) {
    const active = new Set();
    for (const e of game.events) {
      if (e.type === 'capture') active.add(e.id);
      else if (e.type === 'death' && e.killerId != null && e.killerId !== e.id) active.add(e.killerId);
    }
    for (const p of players) {
      if (!p.alive) { p.idleTicks = 0; continue; }
      if (p.trailCells.length > 0 || active.has(p.id)) { p.idleTicks = 0; continue; }
      p.idleTicks += 1;
      if (p.idleTicks >= idleLimit) {
        killPlayer(game, p);
        p._reason = 'idle';
        p._killerId = null;
        p.idleTicks = 0;
        game.events.push({ type: 'death', id: p.id, reason: 'idle', killerId: null });
        if (p.isHuman) { game.over = true; game.deathReason = 'idle'; }
      }
    }
  }

  game.tick += 1;
  return game.events;
}

function markDead(dead, player, reason, killerId = null) {
  dead.add(player);
  // first reason wins; keeps "self/wall" from being overwritten by "collision"
  if (!player._reason) { player._reason = reason; player._killerId = killerId; }
}

function killPlayer(game, p) {
  if (!p.alive) return;
  p.alive = false;
  for (const c of p.trailCells) {
    if (game.trail[c] === p.id) game.trail[c] = -1;
  }
  p.trailCells.length = 0;
  const { owner } = game;
  for (let i = 0; i < owner.length; i += 1) {
    if (owner[i] === p.id) setOwner(game, i, -1);
  }
  game.version += 1;
}

// Flood fill from the border treating the player's cells as walls; any cell
// that cannot be reached from outside is enclosed and gets captured.
function captureTerritory(game, p) {
  const { cols, rows, owner, trail, _visited: visited, _queue: queue } = game;
  const id = p.id;
  const round = ++game._stampCounter;
  const stamp = game._stamp;

  // Convert the trail itself to territory.
  for (const c of p.trailCells) {
    if (owner[c] !== id) {
      setOwner(game, c, id);
      stamp[c] = round;
    }
    trail[c] = -1;
  }
  p.trailCells.length = 0;

  // BFS over all non-owned cells starting from the grid border.
  visited.fill(0);
  let head = 0;
  let tail = 0;
  const pushCell = (i) => {
    if (owner[i] !== id && !visited[i]) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < cols; x += 1) {
    pushCell(x); // top row
    pushCell((rows - 1) * cols + x); // bottom row
  }
  for (let y = 0; y < rows; y += 1) {
    pushCell(y * cols); // left col
    pushCell(y * cols + cols - 1); // right col
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % cols;
    const y = (i - x) / cols;
    if (x > 0) pushCell(i - 1);
    if (x < cols - 1) pushCell(i + 1);
    if (y > 0) pushCell(i - cols);
    if (y < rows - 1) pushCell(i + cols);
  }

  // Anything not owned and not reachable from the border is enclosed.
  let captured = 0;
  for (let i = 0; i < owner.length; i += 1) {
    if (owner[i] !== id && !visited[i]) {
      setOwner(game, i, id);
      stamp[i] = round;
      captured += 1;
    }
  }

  // Any enemy trail caught inside the captured region is severed: clear those
  // cells (otherwise they linger as stray coloured dots on the new territory)
  // and cut down their owner — capturing over a rival's trail kills them.
  for (let i = 0; i < trail.length; i += 1) {
    if (stamp[i] !== round) continue;
    const tr = trail[i];
    if (tr < 0 || tr === id) continue;
    trail[i] = -1;
    const victim = game.players[tr];
    if (victim && victim.alive && victim !== p) {
      killPlayer(game, victim);
      victim._reason = 'cut';
      game.events.push({ type: 'death', id: victim.id, reason: 'cut', killerId: p.id });
      if (victim.isHuman) {
        game.over = true;
        game.deathReason = 'cut';
      }
    }
  }

  // Players caught inside the freshly captured region die.
  for (const q of game.players) {
    if (!q.alive || q === p) continue;
    if (stamp[q.y * cols + q.x] === round) {
      killPlayer(game, q);
      q._reason = 'enclosed';
      game.events.push({ type: 'death', id: q.id, reason: 'enclosed', killerId: p.id });
      if (q.isHuman) {
        game.over = true;
        game.deathReason = 'enclosed';
      }
    }
  }

  // Trim orphaned territory: each player keeps only the connected piece they are
  // standing on (disconnected fragments left behind by a split are removed).
  for (const q of game.players) {
    if (q.alive && q.area > 0) pruneTerritory(game, q);
  }

  game.version += 1;
  return captured;
}

// Keep only ONE connected component of a player's territory: the piece the player
// is standing on, or — if they're off their land — their largest blob. Any other
// disconnected fragment is removed. (Run after a capture that may have split a
// territory in two.)
function pruneTerritory(game, p) {
  const { cols, rows, owner, _visited: visited, _queue: queue } = game;
  const id = p.id;
  const n = owner.length;

  const flood = (start) => {
    let head = 0;
    let tail = 0;
    let count = 0;
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      count += 1;
      const x = i % cols;
      const y = (i - x) / cols;
      if (x > 0 && owner[i - 1] === id && !visited[i - 1]) { visited[i - 1] = 1; queue[tail++] = i - 1; }
      if (x < cols - 1 && owner[i + 1] === id && !visited[i + 1]) { visited[i + 1] = 1; queue[tail++] = i + 1; }
      if (y > 0 && owner[i - cols] === id && !visited[i - cols]) { visited[i - cols] = 1; queue[tail++] = i - cols; }
      if (y < rows - 1 && owner[i + cols] === id && !visited[i + cols]) { visited[i + cols] = 1; queue[tail++] = i + cols; }
    }
    return count;
  };

  visited.fill(0);
  const here = p.y * cols + p.x;

  if (owner[here] === id) {
    flood(here); // keep the piece the player is on
  } else {
    // Player is off their land — keep their largest blob, drop the rest.
    let best = -1;
    let bestCount = 0;
    for (let i = 0; i < n; i += 1) {
      if (owner[i] === id && !visited[i]) {
        const c = flood(i);
        if (c > bestCount) { bestCount = c; best = i; }
      }
    }
    if (best < 0) return;
    visited.fill(0);
    flood(best);
  }

  for (let i = 0; i < n; i += 1) {
    if (owner[i] === id && !visited[i]) setOwner(game, i, -1);
  }
}

// ---- read-only views ---------------------------------------------------------

export function getHumanPlayer(game) {
  return game.players[0];
}

export function aliveBotCount(game) {
  let count = 0;
  for (let i = 1; i < game.players.length; i += 1) {
    if (game.players[i].alive) count += 1;
  }
  return count;
}

export function territoryFraction(game, playerId) {
  const p = game.players[playerId];
  if (!p) return 0;
  return p.area / game.cellCount;
}
