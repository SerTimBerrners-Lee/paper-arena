import { describe, it, expect } from 'bun:test';
import { createGame, tickGame } from '../src/core/gameCore.mjs';

function paintOwned(game, id, cx, cy, half) {
  for (let y = cy - half; y <= cy + half; y += 1) {
    for (let x = cx - half; x <= cx + half; x += 1) {
      if (x >= 0 && y >= 0 && x < game.cols && y < game.rows) game.owner[y * game.cols + x] = id;
    }
  }
}

describe('inactivity death', () => {
  it('kills a player camping on its own land past the idle limit', () => {
    const game = createGame({ cols: 60, rows: 60, botCount: 0, idleDeathTicks: 5, seed: 7 });
    const p = game.players[0];
    // big home + park in the middle moving along owned land → never lays a trail
    game.owner.fill(-1);
    paintOwned(game, 0, 30, 30, 12);
    p.x = p.prevX = p.tx = 30; p.y = p.prevY = p.ty = 30; p.dir = 'right'; p.nextDir = null;
    p.alive = true; p.idleTicks = 0; p.trailCells.length = 0;

    let reason = null;
    for (let i = 0; i < 6; i += 1) {
      const d = tickGame(game).find((e) => e.type === 'death' && e.id === 0);
      if (d) reason = d.reason;
    }
    expect(p.alive).toBe(false);
    expect(reason).toBe('idle');
  });

  it('does NOT kill a player who keeps leaving territory (an open trail counts as active)', () => {
    const game = createGame({ cols: 60, rows: 60, botCount: 0, idleDeathTicks: 5, seed: 7 });
    const p = game.players[0];
    game.owner.fill(-1); // owns nothing → moving always lays a trail → always "active"
    p.x = p.prevX = p.tx = 30; p.y = p.prevY = p.ty = 30; p.dir = 'right'; p.nextDir = null;
    p.alive = true; p.idleTicks = 0; p.trailCells.length = 0;

    for (let i = 0; i < 20; i += 1) tickGame(game);
    expect(p.alive).toBe(true);
    expect(p.idleTicks).toBe(0);
  });

  it('clears a wall-jammed bot after the stuck grace (frees its stray trail)', () => {
    const game = createGame({ cols: 60, rows: 60, botCount: 1, botStuckTicks: 3, seed: 7 });
    const bot = game.players[1];
    bot.x = bot.prevX = 0; bot.y = bot.prevY = 30; bot.dir = 'left'; bot.nextDir = null; // target is off-grid → can't move
    bot.alive = true; bot._stuckTicks = 0;
    let reason = null;
    for (let i = 0; i < 4; i += 1) {
      const d = tickGame(game).find((e) => e.type === 'death' && e.id === 1);
      if (d) reason = d.reason;
    }
    expect(bot.alive).toBe(false);
    expect(reason).toBe('wall');
  });
});
