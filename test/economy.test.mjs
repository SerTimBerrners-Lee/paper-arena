import { describe, expect, it } from 'bun:test';

// Use an isolated in-memory DB — must be set before economy.mjs (→ db.mjs) loads.
process.env.DB_PATH = ':memory:';
const {
  getOrCreateUser, grant, createMatch, startLife, endLifeByDeath,
  settleBotKill, getWallet, getProfile, reconcile, WELCOME_GRANT_CENTS,
} = await import('../server/economy.mjs');

let seq = 0;
const mkUser = (name) => getOrCreateUser('dev', `subj-${name}-${seq++}`, name);

describe('economy ledger', () => {
  it('grants every new account the welcome balance and conserves cents', () => {
    const a = mkUser('alice');
    expect(getWallet(a.id).balanceCents).toBe(WELCOME_GRANT_CENTS);
    expect(reconcile().ok).toBe(true);
  });

  it('is idempotent on grants with the same ref', () => {
    const u = mkUser('grantee');
    grant(u.id, 100, 'promoX');
    grant(u.id, 100, 'promoX'); // replay — must NOT double-credit
    expect(getWallet(u.id).balanceCents).toBe(WELCOME_GRANT_CENTS + 100);
    expect(reconcile().ok).toBe(true);
  });

  it('freezes a stake on join and rejects an unaffordable one', () => {
    const u = mkUser('staker');
    const m = createMatch('wager', 20);
    const mp = startLife(u.id, m, 0, 20);
    expect(mp).toBeGreaterThan(0);
    const w = getWallet(u.id);
    expect(w.balanceCents).toBe(WELCOME_GRANT_CENTS - 20);
    expect(w.frozenCents).toBe(20);

    const broke = mkUser('broke');
    grant(broke.id, -WELCOME_GRANT_CENTS, 'noop'); // negative grant is ignored
    // drain the broke user by staking everything legitimately is messy; instead just
    // assert a stake larger than balance is refused:
    expect(startLife(broke.id, m, 1, WELCOME_GRANT_CENTS + 1)).toBe(null);
    expect(reconcile().ok).toBe(true);
  });

  it('pays the killer 75% and rakes 25% to the house (20 -> 15/5, no referrer)', () => {
    const victim = mkUser('victim');
    const killer = mkUser('killer');
    const m = createMatch('wager', 20);
    const vMp = startLife(victim.id, m, 2, 20);
    const kMp = startLife(killer.id, m, 3, 20);

    const before = getWallet(killer.id).balanceCents;
    const res = endLifeByDeath(vMp, { killerUserId: killer.id, killerMpId: kMp, reason: 'cut', victimKills: 0, victimArea: 9 });
    expect(res.payoutToKillerCents).toBe(15);
    expect(getWallet(killer.id).balanceCents).toBe(before + 15);
    expect(getWallet(victim.id).frozenCents).toBe(0); // stake released
    expect(getProfile(killer.id).stats.kills).toBe(1);
    expect(getProfile(killer.id).stats.totalEarnedCents).toBe(15);
    expect(getProfile(victim.id).stats.deaths).toBe(1);
    expect(reconcile().ok).toBe(true);
  });

  it('pays the referrer 15% and trims the house cut for a referred killer (15/3/2)', () => {
    const referrer = mkUser('refman');
    const code = getProfile(referrer.id).referralCode;
    const referred = getOrCreateUser('dev', `referred-${seq++}`, 'Referred', null, code);
    const victim = mkUser('refvictim');
    const m = createMatch('wager', 20);
    const vMp = startLife(victim.id, m, 4, 20);
    startLife(referred.id, m, 5, 20);
    const refBefore = getWallet(referrer.id).balanceCents;
    const killBefore = getWallet(referred.id).balanceCents;
    const res = endLifeByDeath(vMp, { killerUserId: referred.id });
    expect(res.payoutToKillerCents).toBe(15);
    expect(getWallet(referred.id).balanceCents).toBe(killBefore + 15);
    expect(getWallet(referrer.id).balanceCents).toBe(refBefore + 3); // 15% referral cut
    expect(getProfile(referrer.id).stats.referralEarnedCents).toBe(3);
    expect(getProfile(referrer.id).stats.referrals).toBe(1);
    expect(reconcile().ok).toBe(true);
  });

  it('settles a death only once (replayed death event = one charge)', () => {
    const victim = mkUser('v2');
    const killer = mkUser('k2');
    const m = createMatch('wager', 20);
    const vMp = startLife(victim.id, m, 4, 20);
    const kMp = startLife(killer.id, m, 5, 20);
    endLifeByDeath(vMp, { killerUserId: killer.id, killerMpId: kMp });
    const balAfterFirst = getWallet(killer.id).balanceCents;
    const second = endLifeByDeath(vMp, { killerUserId: killer.id, killerMpId: kMp });
    expect(second).toBe(null); // already settled
    expect(getWallet(killer.id).balanceCents).toBe(balAfterFirst);
    expect(reconcile().ok).toBe(true);
  });

  it('splits odd stakes without losing a cent (25 -> 18/7)', () => {
    const victim = mkUser('v3');
    const killer = mkUser('k3');
    const m = createMatch('wager', 25);
    const vMp = startLife(victim.id, m, 6, 25);
    startLife(killer.id, m, 7, 25);
    const before = getWallet(killer.id).balanceCents;
    const res = endLifeByDeath(vMp, { killerUserId: killer.id });
    expect(res.payoutToKillerCents).toBe(18); // floor(25*0.75)
    expect(getWallet(killer.id).balanceCents).toBe(before + 18); // house got 7
    expect(reconcile().ok).toBe(true);
  });

  it('forfeits the whole stake to the house when there is no killer', () => {
    const u = mkUser('lonewolf');
    const m = createMatch('wager', 20);
    const mp = startLife(u.id, m, 8, 20);
    const res = endLifeByDeath(mp, { killerUserId: null, reason: 'self' });
    expect(res.payoutToKillerCents).toBe(0);
    expect(getWallet(u.id).frozenCents).toBe(0);
    expect(getProfile(u.id).stats.netProfitCents).toBe(-20); // staked, got nothing back
    expect(reconcile().ok).toBe(true);
  });

  it('mints a 15¢ reward when a wager player kills a bot (bots count as paid)', () => {
    const k = mkUser('bothunter');
    const m = createMatch('wager', 20);
    const mp = startLife(k.id, m, 0, 20);
    const before = getWallet(k.id).balanceCents;
    const payout = settleBotKill(k.id, mp, 20, `${mp}:1`);
    expect(payout).toBe(15);
    expect(getWallet(k.id).balanceCents).toBe(before + 15);
    expect(getProfile(k.id).stats.kills).toBe(1);
    expect(settleBotKill(k.id, mp, 20, `${mp}:1`)).toBe(0); // idempotent on same ref
    expect(getWallet(k.id).balanceCents).toBe(before + 15);
    expect(reconcile().ok).toBe(true);
  });
});
