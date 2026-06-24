import { describe, it, expect } from 'bun:test';
import { createGame, tickGame } from '../src/core/gameCore.mjs';

describe('domination win', () => {
  it('capturing >90% of the board kills everyone (conquered) + emits a win event', () => {
    const game = createGame({ cols: 8, rows: 8, botCount: 1, seed: 3 }); // dominationCells = floor(0.9*64) = 57
    const p0 = game.players[0];
    const bot = game.players[1];

    // Player 0 owns the whole board except one cell, which is its trail tip; stepping back
    // onto its land closes the loop → a capture that leaves it owning the whole arena.
    game.owner.fill(-1); game.trail.fill(-1);
    let area = 0;
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        if (x === 7 && y === 7) continue; // the trail tip stays unowned
        game.owner[y * 8 + x] = 0; area += 1;
      }
    }
    p0.area = area; // 63
    p0.x = p0.prevX = 7; p0.y = p0.prevY = 7; p0.dir = 'left'; p0.nextDir = null; p0.alive = true;
    p0.trailCells = [7 * 8 + 7]; game.trail[7 * 8 + 7] = 0;
    bot.x = bot.prevX = 4; bot.y = bot.prevY = 4; bot.alive = true; bot.nextDir = null;

    const events = tickGame(game);
    const dom = events.find((e) => e.type === 'domination');
    const botDeath = events.find((e) => e.type === 'death' && e.id === 1);

    expect(dom).toBeTruthy();
    expect(dom.id).toBe(0);
    expect(bot.alive).toBe(false);
    expect(botDeath && botDeath.reason).toBe('conquered');
    expect(p0.alive).toBe(true); // the conqueror is NOT killed — the arena settles their win
  });
});
