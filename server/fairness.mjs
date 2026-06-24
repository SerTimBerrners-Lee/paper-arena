// fairness.mjs — provably-fair commit-reveal for the arena's house RNG.
//
// Every epoch the arena draws a fresh SECRET serverSeed, publishes sha256(serverSeed)
// as a COMMIT, and seeds the deterministic game RNG from it. When the epoch ends the
// seed is REVEALED, so anyone can verify sha256(revealedSeed) === the commit that was
// published for that epoch — proving the house could not have chosen the seed after
// seeing the action (e.g. to bias a head-on coin-flip). The current commit and recent
// reveals are auditable over HTTP at /fairness.
import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

// A fresh secret seed, its public commitment, and a 32-bit numeric seed for makeRng().
export function newRound() {
  const serverSeed = randomBytes(16).toString('hex');
  const commit = sha256Hex(serverSeed);
  const numericSeed = (parseInt(serverSeed.slice(0, 8), 16) >>> 0) || 1;
  return { serverSeed, commit, numericSeed };
}

// Verify a revealed seed against a previously published commit.
export function verify(serverSeed, commit) {
  return sha256Hex(serverSeed) === commit;
}
