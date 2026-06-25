import { describe, expect, it } from 'bun:test';

process.env.DB_PATH = ':memory:';
const econ = await import('../server/economy.mjs');
const { Arena } = await import('../server/arena.mjs');

function joinHuman(arena, name, userId) {
  const s = arena.createSession();
  s.userId = userId; s.mode = 'wager'; s.name = name;
  const ws = {
    readyState: 1, msgs: [],
    send(d) { this.msgs.push(typeof d === 'string' ? JSON.parse(d) : d); },
    close() {}, data: { session: s },
  };
  arena.onOpen(ws);
  arena.joinSlot(s, name);
  return { s, ws };
}

describe('domination = match over for everyone', () => {
  it('freezes the arena, ends the match for all, then opens a fresh paid match', () => {
    const arena = new Arena();
    const ua = econ.getOrCreateUser('dev', 'mo-winner', 'Winner');
    const ub = econ.getOrCreateUser('dev', 'mo-other', 'Other');
    const A = joinHuman(arena, 'Winner', ua.id);
    const B = joinHuman(arena, 'Other', ub.id);

    // A conquers the arena. Production order: rivals' 'conquered' deaths settle first
    // (credited to the conqueror), THEN the domination event fires.
    arena.onDeath({ type: 'death', id: B.s.slotId, reason: 'conquered', killerId: A.s.slotId });
    arena._onDomination(A.s.slotId);

    // the whole arena is frozen between matches…
    expect(arena.phase).toBe('intermission');
    // …the conqueror gets a victory screen with their stake returned…
    const vic = A.ws.msgs.filter((m) => m && m.type === 'victory').at(-1);
    expect(vic).toBeTruthy();
    expect(vic.returnedCents).toBe(20);
    // …and EVERYONE (incl. the other player) is told the match is over.
    expect(A.ws.msgs.some((m) => m && m.type === 'matchover' && m.winner === 'Winner')).toBe(true);
    expect(B.ws.msgs.some((m) => m && m.type === 'matchover')).toBe(true);

    // "play again" pressed during the freeze is queued, not run on the frozen board.
    arena.respawn(A.s);
    expect(A.s.queuedRespawn).toBe(true);
    expect(arena.lives[A.s.slotId]).toBeNull(); // life not reopened yet

    // drain the intermission → a fresh match opens.
    for (let i = 0; i < 12 * 3; i += 1) arena.step();
    expect(arena.phase).toBe('live');
    expect(arena.epoch).toBe(2);                       // a new provably-fair round
    // the queued respawn was honoured on the fresh board (a new staked life).
    expect(A.s.queuedRespawn).toBe(false);
    expect(arena.lives[A.s.slotId]).not.toBeNull();
    expect(arena.game.players[A.s.slotId].alive).toBe(true);

    // the ledger stays balanced through win-settle + re-stake.
    expect(econ.reconcile().ok).toBe(true);
  });
});
