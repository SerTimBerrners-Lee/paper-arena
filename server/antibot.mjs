// antibot.mjs — Phase-1 heuristic bot-likelihood scoring (0..1) from per-session
// behavioural telemetry the authoritative server already sees. ADVISORY ONLY:
// crossing the threshold records a flag for review; it never auto-bans (the score
// is heuristic, so a money decision must gate on the cashout/withdrawal side).
// Pure functions, no I/O — unit-testable and deterministic.

export const SUSPECT_THRESHOLD = 0.6;
const HUMAN_REACTION_MS = 120; // a human tap can't realistically be faster than this

export function newTelemetry() {
  return {
    inputs: 0, lastInputTs: 0,
    intCount: 0, intSum: 0, intSqSum: 0, intMin: Infinity, // input inter-arrival stats (ms)
    deaths: 0, selfDeaths: 0,
    respawns: 0, fastRespawns: 0,
    lastDeathTs: 0,
    foreignOrigin: false,
    flagged: false,
  };
}

// record one INPUT (movement) message arrival
export function noteInput(tel, now) {
  if (tel.lastInputTs) {
    const d = now - tel.lastInputTs;
    if (d >= 0 && d < 10000) {
      tel.intCount += 1; tel.intSum += d; tel.intSqSum += d * d;
      if (d < tel.intMin) tel.intMin = d;
    }
  }
  tel.lastInputTs = now;
  tel.inputs += 1;
}

export function noteDeath(tel, reason, now) {
  tel.deaths += 1;
  if (reason === 'self') tel.selfDeaths += 1;
  if (now != null) tel.lastDeathTs = now;
}

export function noteRespawn(tel, now) {
  tel.respawns += 1;
  if (tel.lastDeathTs && now - tel.lastDeathTs < HUMAN_REACTION_MS) tel.fastRespawns += 1;
}

// Combine the signals into a 0..1 score with human-readable reasons. Each signal
// needs a minimum sample size so we don't flag on noise early in a session.
export function scoreTelemetry(tel) {
  const reasons = [];
  let score = 0;

  if (tel.intCount >= 20) {
    const mean = tel.intSum / tel.intCount;
    const variance = Math.max(0, tel.intSqSum / tel.intCount - mean * mean);
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1; // coefficient of variation
    if (cv < 0.12) { score += 0.4; reasons.push('machine-regular-input'); }
    else if (cv < 0.28) { score += 0.2; reasons.push('low-input-jitter'); }
  }
  if (tel.respawns >= 3 && tel.fastRespawns / tel.respawns > 0.7) { score += 0.3; reasons.push('instant-respawn'); }
  if (tel.deaths >= 8 && tel.selfDeaths / tel.deaths < 0.05) { score += 0.2; reasons.push('never-self-kills'); }
  if (tel.foreignOrigin) { score += 0.3; reasons.push('foreign-origin'); }

  return { score: Math.min(1, score), reasons };
}
