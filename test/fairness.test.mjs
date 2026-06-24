import { describe, expect, it } from 'bun:test';
import { newRound, verify, sha256Hex } from '../server/fairness.mjs';

describe('provably-fair commit-reveal', () => {
  it('commit is sha256 of the secret seed, and verify accepts it', () => {
    const r = newRound();
    expect(r.commit).toBe(sha256Hex(r.serverSeed));
    expect(verify(r.serverSeed, r.commit)).toBe(true);
  });

  it('derives a positive 32-bit numeric seed for makeRng()', () => {
    const { numericSeed } = newRound();
    expect(Number.isInteger(numericSeed)).toBe(true);
    expect(numericSeed).toBeGreaterThan(0);
    expect(numericSeed).toBeLessThanOrEqual(0xffffffff);
  });

  it('verify rejects a tampered seed', () => {
    const r = newRound();
    expect(verify(`${r.serverSeed}0`, r.commit)).toBe(false);
    expect(verify(r.serverSeed, `${r.commit.slice(0, -1)}0`)).toBe(false);
  });

  it('draws an unpredictable fresh seed each round', () => {
    const a = newRound();
    const b = newRound();
    expect(a.serverSeed).not.toBe(b.serverSeed);
    expect(a.commit).not.toBe(b.commit);
  });
});
