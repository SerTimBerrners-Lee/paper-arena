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

describe('arena kill crediting', () => {
  it('pays 18¢ for a human kill AND mints 18¢ for a bot kill (bots count as paid)', () => {
    const arena = new Arena();
    const ua = econ.getOrCreateUser('dev', 'arena-killer', 'Killer');
    const ub = econ.getOrCreateUser('dev', 'arena-victim', 'Victim');
    const A = joinHuman(arena, 'Killer', ua.id);
    const B = joinHuman(arena, 'Victim', ub.id);
    expect(A.s.slotId).toBeGreaterThanOrEqual(0);
    expect(B.s.slotId).toBeGreaterThanOrEqual(0);

    // A kills B (human victim, wager) — fabricate the engine death event.
    arena.onDeath({ type: 'death', id: B.s.slotId, reason: 'cut', killerId: A.s.slotId });
    const kill1 = A.ws.msgs.filter((m) => m && m.type === 'kill').at(-1);
    expect(kill1).toBeTruthy();
    expect(kill1.rewardCents).toBe(15); // 75% of 20¢
    expect(kill1.kills).toBe(1);
    const death = B.ws.msgs.find((m) => m && m.type === 'death');
    expect(death.lostCents).toBe(20);

    // A kills a BOT (a slot nobody joined) — bots count as if they paid, so this
    // mints 18¢ to A too (and advances the frag counter).
    const botSlot = [...Array(16).keys()].find((id) => id !== A.s.slotId && id !== B.s.slotId);
    const balBefore = econ.getWallet(ua.id).balanceCents;
    arena.onDeath({ type: 'death', id: botSlot, reason: 'cut', killerId: A.s.slotId });
    const kill2 = A.ws.msgs.filter((m) => m && m.type === 'kill').at(-1);
    expect(kill2.rewardCents).toBe(15);
    expect(kill2.kills).toBe(2);
    expect(econ.getWallet(ua.id).balanceCents).toBe(balBefore + 15);

    // A's OWN death screen reports the life's net result (earned − stake), not just the stake.
    const botSlot2 = [...Array(16).keys()].find((id) => id !== A.s.slotId && id !== B.s.slotId && id !== botSlot);
    arena.onDeath({ type: 'death', id: A.s.slotId, reason: 'collision', killerId: botSlot2 });
    const adeath = A.ws.msgs.filter((m) => m && m.type === 'death').at(-1);
    expect(adeath.earnedCents).toBe(30); // 2 kills × ◇0.15
    expect(adeath.netCents).toBe(10);    // 30 earned − 20 stake

    expect(econ.reconcile().ok).toBe(true);
  });
});
