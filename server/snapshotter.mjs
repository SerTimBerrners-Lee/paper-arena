// snapshotter.mjs — diffs the authoritative grid each tick into a compact delta.
import { encodeDelta, NO_TRAIL } from '../src/net/protocol.mjs';

export class Snapshotter {
  constructor(game) {
    this.po = Int16Array.from(game.owner); // previous owner snapshot
    this.pt = Int16Array.from(game.trail); // previous trail snapshot
  }

  // Reset the baseline to the current grid (used on waiting->active so the first
  // active delta is just that tick's changes, not everything since boot).
  resync(game) {
    this.po.set(game.owner);
    this.pt.set(game.trail);
  }

  build(game, status, metaDirty, events) {
    const { owner, trail } = game;
    const po = this.po;
    const pt = this.pt;
    const n = owner.length;
    const ownerChanges = [];
    const trailChanges = [];
    for (let i = 0; i < n; i += 1) if (owner[i] !== po[i]) { ownerChanges.push([i, owner[i]]); po[i] = owner[i]; }
    for (let i = 0; i < n; i += 1) if (trail[i] !== pt[i]) { trailChanges.push([i, trail[i]]); pt[i] = trail[i]; }

    const players = [];
    for (const p of game.players) {
      const head = p.trailCells.length ? p.trailCells[p.trailCells.length - 1] : NO_TRAIL;
      const rec = { id: p.id, alive: p.alive, isHuman: p.isHuman, x: p.x, y: p.y, dir: p.dir, headTrailCell: head, area: p.area };
      if (metaDirty.has(p.id)) rec.meta = { color: p.color, name: p.name };
      players.push(rec);
    }

    const evs = events.map((e) => (e.type === 'death'
      ? { type: 'death', id: e.id, reason: e.reason, killerId: e.killerId ?? null }
      : { type: 'capture', id: e.id, cells: e.cells }));

    return encodeDelta({ tick: game.tick, status, ownerChanges, trailChanges, players, events: evs });
  }
}
