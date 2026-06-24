import { describe, it, expect } from 'bun:test';
import { createGame, tickGame } from '../src/core/gameCore.mjs';
import {
  encodeKeyframe, decodeKeyframe, encodeDelta, decodeDelta, encodeInput, decodeInput,
} from '../src/net/protocol.mjs';

describe('protocol', () => {
  it('keyframe round-trips owner/trail/players', () => {
    const g = createGame({ cols: 20, rows: 20, botCount: 3, startRadius: 1, seed: 5 });
    tickGame(g);
    const kf = decodeKeyframe(encodeKeyframe(g, 2, 1));
    expect(kf.cols).toBe(20);
    expect(kf.rows).toBe(20);
    expect(kf.youId).toBe(2);
    expect(kf.status).toBe(1);
    expect(kf.players.length).toBe(g.players.length);
    for (let i = 0; i < g.cellCount; i += 1) {
      expect(kf.owner[i]).toBe(g.owner[i]);
      expect(kf.trail[i]).toBe(g.trail[i]);
    }
    expect(kf.players[1].color).toEqual(g.players[1].color);
    expect(kf.players[1].name).toBe(g.players[1].name);
  });

  it('delta round-trips changes + events', () => {
    const d = encodeDelta({
      tick: 7,
      status: 1,
      ownerChanges: [[3, 1], [9, -1]],
      trailChanges: [[5, 2]],
      players: [
        { id: 0, alive: true, isHuman: true, x: 4, y: 5, dir: 'right', headTrailCell: 5, area: 9, meta: { color: [1, 2, 3], name: 'Ann' } },
        { id: 1, alive: false, isHuman: false, x: 0, y: 0, dir: 'up', headTrailCell: 0xffff, area: 0 },
      ],
      events: [
        { type: 'death', id: 1, reason: 'cut', killerId: 0 },
        { type: 'capture', id: 0, cells: 12 },
      ],
    });
    const out = decodeDelta(d);
    expect(out.tick).toBe(7);
    expect(out.status).toBe(1);
    expect(out.ownerChanges).toEqual([[3, 1], [9, -1]]);
    expect(out.trailChanges).toEqual([[5, 2]]);
    expect(out.players[0].meta).toEqual({ color: [1, 2, 3], name: 'Ann' });
    expect(out.players[1].headTrailCell).toBe(0xffff);
    expect(out.events[0]).toEqual({ type: 'death', id: 1, reason: 'cut', killerId: 0 });
    expect(out.events[1]).toEqual({ type: 'capture', id: 0, cells: 12 });
  });

  it('input round-trips', () => {
    expect(decodeInput(encodeInput('left'))).toBe('left');
    expect(decodeInput(encodeInput('up'))).toBe('up');
  });
});
