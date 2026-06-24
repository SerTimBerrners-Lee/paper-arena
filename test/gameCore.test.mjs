import { describe, expect, it } from 'bun:test';
import {
  createGame,
  setDirection,
  tickGame,
  territoryFraction,
} from '../src/core/gameCore.mjs';

// Build an 11x11 game with an empty grid so we can script exact scenarios.
function blankGame(botCount = 0) {
  const g = createGame({ cols: 11, rows: 11, botCount, startRadius: 1, seed: 7 });
  g.owner.fill(-1);
  g.trail.fill(-1);
  for (const p of g.players) {
    p.area = 0;
    p.trailCells.length = 0;
    p.alive = true;
    p.invincibleTicks = 0;
  }
  g.over = false;
  g.deathReason = null;
  return g;
}

const I = (x, y) => y * 11 + x;

function place(p, x, y, dir) {
  p.x = x;
  p.y = y;
  p.prevX = x;
  p.prevY = y;
  p.dir = dir;
  p.nextDir = null;
}

function step(g, dir) {
  if (dir) setDirection(g, 0, dir);
  return tickGame(g);
}

describe('createGame', () => {
  it('spawns one human plus the requested bots, each with a 3x3 home', () => {
    const g = createGame({ cols: 30, rows: 30, botCount: 2, startRadius: 1, seed: 5 });
    expect(g.players.length).toBe(3);
    expect(g.players[0].isHuman).toBe(true);
    for (const p of g.players) expect(p.area).toBe(9);

    let owned = 0;
    for (let i = 0; i < g.owner.length; i += 1) if (g.owner[i] >= 0) owned += 1;
    expect(owned).toBe(27);
    expect(territoryFraction(g, 0)).toBeCloseTo(9 / 900, 6);
  });
});

describe('movement', () => {
  it('lays a trail when leaving owned territory', () => {
    const g = blankGame(0);
    g.owner[I(5, 5)] = 0;
    place(g.players[0], 5, 5, 'right');

    step(g, 'right');
    expect(g.players[0].x).toBe(6);
    expect(g.trail[I(6, 5)]).toBe(0);
    expect(g.players[0].trailCells).toContain(I(6, 5));
  });

  it('ignores a 180-degree reversal', () => {
    const g = blankGame(0);
    place(g.players[0], 5, 5, 'right');
    step(g, 'left'); // opposite of current heading -> ignored
    expect(g.players[0].x).toBe(6);
    expect(g.players[0].dir).toBe('right');
  });
});

describe('capture', () => {
  it('fills the cells enclosed by a closed loop', () => {
    const g = blankGame(0);
    for (let y = 0; y < 11; y += 1) g.owner[I(0, y)] = 0; // left wall of land
    place(g.players[0], 0, 3, 'right');

    step(g, 'right'); // (1,3)
    step(g, 'right'); // (2,3)
    step(g, 'down'); //  (2,4)
    step(g, 'down'); //  (2,5)
    step(g, 'down'); //  (2,6)
    step(g, 'left'); //  (1,6)
    step(g, 'left'); //  (0,6) -> closes the loop

    expect(g.players[0].alive).toBe(true);
    expect(g.players[0].trailCells.length).toBe(0);
    // pocket between the trail and the wall is captured
    expect(g.owner[I(1, 4)]).toBe(0);
    expect(g.owner[I(1, 5)]).toBe(0);
    // the trail itself becomes territory
    expect(g.owner[I(2, 5)]).toBe(0);
    expect(g.trail[I(2, 5)]).toBe(-1);
  });

  it('kills a rival enclosed by a new capture', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    for (let y = 0; y < 11; y += 1) g.owner[I(0, y)] = 0;

    // Pre-load the human trail so a single tick closes the loop.
    const trailCells = [I(1, 3), I(2, 3), I(2, 4), I(2, 5), I(2, 6), I(1, 6)];
    for (const c of trailCells) {
      g.trail[c] = 0;
      human.trailCells.push(c);
    }
    place(human, 1, 6, 'left');
    place(bot, 1, 5, 'up'); // sitting inside the pocket

    tickGame(g); // human moves to (0,6) and captures

    expect(human.alive).toBe(true);
    expect(bot.alive).toBe(false);
    expect(g.over).toBe(false); // human is fine
  });

  it('leaves no stray cell when an enclosed rival dies', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    for (let y = 0; y < 11; y += 1) g.owner[I(0, y)] = 0;

    const trailCells = [I(1, 3), I(2, 3), I(2, 4), I(2, 5), I(2, 6), I(1, 6)];
    for (const c of trailCells) {
      g.trail[c] = 0;
      human.trailCells.push(c);
    }
    place(human, 1, 6, 'left');
    place(bot, 1, 5, 'up'); // enclosed; previously took one extra step and left a dot

    tickGame(g); // human captures the pocket, bot dies enclosed

    expect(bot.alive).toBe(false);
    let leftover = 0;
    for (let i = 0; i < g.owner.length; i += 1) {
      if (g.owner[i] === bot.id || g.trail[i] === bot.id) leftover += 1;
    }
    expect(leftover).toBe(0);
  });

  it('removes a disconnected territory fragment when a capture happens', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;

    // Bot owns two disconnected blobs: one it stands on, one orphaned far away.
    for (const c of [I(3, 3), I(4, 3), I(3, 4)]) g.owner[c] = 1;
    for (const c of [I(8, 8), I(9, 8)]) g.owner[c] = 1;
    bot.area = 5;
    place(bot, 3, 3, 'down'); // stays on its own land

    // Minimal human capture so the prune pass runs this tick.
    g.owner[I(0, 0)] = 0;
    human.area = 1;
    g.trail[I(0, 1)] = 0;
    human.trailCells.push(I(0, 1));
    place(human, 0, 1, 'up');

    tickGame(g);

    expect(g.owner[I(3, 3)]).toBe(1); // bot keeps the side it is on
    expect(g.owner[I(8, 8)]).toBe(-1); // orphaned fragment is gone
    expect(g.owner[I(9, 8)]).toBe(-1);
  });
});

describe('death', () => {
  it('dies when stepping onto its own trail', () => {
    const g = blankGame(0);
    g.owner[I(5, 5)] = 0;
    place(g.players[0], 5, 5, 'right');
    step(g, 'right'); // (6,5)
    step(g, 'right'); // (7,5)
    step(g, 'down'); //  (7,6)
    step(g, 'left'); //  (6,6)
    const events = step(g, 'up'); // (6,5) is own trail

    expect(g.players[0].alive).toBe(false);
    expect(g.over).toBe(true);
    expect(g.deathReason).toBe('self');
    expect(events.some((e) => e.type === 'death' && e.reason === 'self')).toBe(true);
  });

  it('stops at the wall without dying', () => {
    const g = blankGame(0);
    place(g.players[0], 1, 5, 'left');
    step(g, 'left'); // (0,5)
    step(g, 'left'); // would go off the grid — stays at (0,5)
    expect(g.players[0].alive).toBe(true);
    expect(g.players[0].x).toBe(0);
    expect(g.players[0].y).toBe(5);
    expect(g.over).toBe(false);
  });

  it('cuts down a rival whose trail you cross', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    g.trail[I(6, 5)] = 1;
    bot.trailCells.push(I(6, 5));
    place(bot, 1, 1, 'right'); // harmless move elsewhere
    place(human, 6, 4, 'down'); // steps onto the bot's trail at (6,5)

    const events = tickGame(g);

    expect(bot.alive).toBe(false);
    expect(human.alive).toBe(true);
    expect(
      events.some((e) => e.type === 'death' && e.id === 1 && e.reason === 'cut'),
    ).toBe(true);
  });

  it('resolves an adjacent head-on as a coin flip (exactly one dies, not both)', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    // both are out laying a trail, adjacent and heading straight into each other
    g.trail[I(4, 5)] = 0;
    g.trail[I(5, 5)] = 0;
    human.trailCells.push(I(4, 5), I(5, 5));
    g.trail[I(7, 5)] = 1;
    g.trail[I(6, 5)] = 1;
    bot.trailCells.push(I(7, 5), I(6, 5));
    place(human, 5, 5, 'right'); // -> (6,5)
    place(bot, 6, 5, 'left'); //    -> (5,5)  (they swap cells)

    tickGame(g);

    const survivors = [human, bot].filter((pl) => pl.alive).length;
    expect(survivors).toBe(1); // coin flip — exactly one survives, not both dead
  });

  it('runs over a wall-stuck player (they die, the mover lives)', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    place(bot, 0, 5, 'left'); // jammed against the left wall -> can't move, stays put
    place(human, 1, 5, 'left'); // drives straight into the stuck bot's cell (0,5)

    tickGame(g);

    expect(bot.alive).toBe(false);
    expect(human.alive).toBe(true);
    expect(human.x).toBe(0);
    expect(human.y).toBe(5);
  });

  it('a rival cutting your trail still kills you even if you won a collision this tick', () => {
    const g = blankGame(2);
    const [human, botA, botB] = g.players;
    // human is out, trail running left toward the wall
    g.owner[I(3, 5)] = 0;
    g.trail[I(2, 5)] = 0;
    g.trail[I(1, 5)] = 0;
    human.trailCells.push(I(2, 5), I(1, 5));
    place(human, 1, 5, 'left'); // -> (0,5): runs over botA (a collision the human "wins")
    place(botA, 0, 5, 'left'); // wall-stuck at (0,5)
    place(botB, 2, 4, 'down'); // -> (2,5): crosses the human's trail

    tickGame(g);

    expect(botA.alive).toBe(false); // run over by the human
    expect(human.alive).toBe(false); // but botB cut the human's trail — no free pass
  });

  it('cuts a freshly (re)spawned rival the moment it leaves home with a trail', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    bot.invincibleTicks = 18; // pretend it just respawned — must NOT shield its trail
    g.trail[I(6, 5)] = 1;
    bot.trailCells.push(I(6, 5));
    place(bot, 1, 1, 'right'); // harmless move elsewhere
    place(human, 6, 4, 'down'); // steps onto the bot's fresh trail at (6,5)

    tickGame(g);

    expect(bot.alive).toBe(false);
    expect(human.alive).toBe(true);
  });
});

describe('kill attribution (killerId)', () => {
  it('credits the cutter when crossing a rival trail', () => {
    const g = blankGame(1);
    const [, bot] = g.players;
    g.trail[I(6, 5)] = 1;
    bot.trailCells.push(I(6, 5));
    place(bot, 1, 1, 'right');
    place(g.players[0], 6, 4, 'down'); // human (id 0) cuts the bot's trail
    const events = tickGame(g);
    const d = events.find((e) => e.type === 'death' && e.id === 1);
    expect(d.reason).toBe('cut');
    expect(d.killerId).toBe(0);
  });

  it('reports no killer on a self-trail death', () => {
    const g = blankGame(0);
    g.owner[I(5, 5)] = 0;
    g.trail[I(6, 5)] = 0;
    g.players[0].trailCells.push(I(6, 5));
    place(g.players[0], 5, 5, 'right'); // steps onto own trail at (6,5)
    const events = tickGame(g);
    const d = events.find((e) => e.type === 'death' && e.id === 0);
    expect(d.reason).toBe('self');
    expect(d.killerId).toBe(null);
  });

  it('credits the surviving side of a head-on', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    g.trail[I(4, 5)] = 0; g.trail[I(5, 5)] = 0;
    human.trailCells.push(I(4, 5), I(5, 5));
    g.trail[I(7, 5)] = 1; g.trail[I(6, 5)] = 1;
    bot.trailCells.push(I(7, 5), I(6, 5));
    place(human, 5, 5, 'right'); // -> (6,5)
    place(bot, 6, 5, 'left'); //   -> (5,5)  (swap)
    const events = tickGame(g);
    const d = events.find((e) => e.type === 'death' && e.reason === 'collision');
    const survivorId = human.alive ? 0 : 1; // whoever the coin flip spared
    expect(d.killerId).toBe(survivorId);
  });

  it('credits the runner who overruns a wall-stuck rival', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    place(bot, 0, 5, 'left'); // wall-stuck
    place(human, 1, 5, 'left'); // drives into (0,5)
    const events = tickGame(g);
    const d = events.find((e) => e.type === 'death' && e.id === 1);
    expect(d.killerId).toBe(0);
  });

  it('credits the capturer when a rival is enclosed', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    for (let y = 0; y < 11; y += 1) g.owner[I(0, y)] = 0;
    const trailCells = [I(1, 3), I(2, 3), I(2, 4), I(2, 5), I(2, 6), I(1, 6)];
    for (const c of trailCells) { g.trail[c] = 0; human.trailCells.push(c); }
    place(human, 1, 6, 'left');
    place(bot, 1, 5, 'up'); // sitting inside the pocket
    const events = tickGame(g);
    const d = events.find((e) => e.type === 'death' && e.id === 1);
    expect(d.reason).toBe('enclosed');
    expect(d.killerId).toBe(0);
  });
});

describe('home advantage in head-on collisions', () => {
  it('survives a head-on fought on your own territory (shared target cell)', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    g.owner[I(6, 5)] = 0; // the contested cell is the human's land
    place(human, 5, 5, 'right'); // -> (6,5)
    place(bot, 7, 5, 'left'); //    -> (6,5): head-on into the human's cell
    const events = tickGame(g);
    expect(human.alive).toBe(true);
    expect(bot.alive).toBe(false);
    expect(events.some((e) => e.type === 'death' && e.id === 1 && e.killerId === 0)).toBe(true);
  });

  it('defending your own land wins a swap collision', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    g.owner[I(5, 5)] = 0; // human stands on its own territory
    place(human, 5, 5, 'right'); // -> (6,5)
    place(bot, 6, 5, 'left'); //    -> (5,5): swap, bot invades the human's land
    tickGame(g);
    expect(human.alive).toBe(true); // home defender wins
    expect(bot.alive).toBe(false);
  });

  it('still resolves a neutral-ground head-on as a coin flip (one dies)', () => {
    const g = blankGame(1);
    const [human, bot] = g.players;
    place(human, 5, 5, 'right'); // -> (6,5)
    place(bot, 6, 5, 'left'); //    -> (5,5): swap on neutral ground
    tickGame(g);
    expect([human, bot].filter((p) => p.alive).length).toBe(1);
  });
});
