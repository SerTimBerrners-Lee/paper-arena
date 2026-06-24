import { describe, expect, it } from 'bun:test';
import {
  newTelemetry, noteInput, noteDeath, noteRespawn, scoreTelemetry, SUSPECT_THRESHOLD,
} from '../server/antibot.mjs';

describe('antibot scoring', () => {
  it('flags a bot-like session (machine timing, instant respawns, no self-kills, raw socket)', () => {
    const t = newTelemetry();
    t.foreignOrigin = true;
    let now = 1000;
    for (let i = 0; i < 30; i += 1) { noteInput(t, now); now += 250; } // perfectly regular → cv≈0
    for (let i = 0; i < 5; i += 1) { noteDeath(t, 'cut', now); noteRespawn(t, now + 8); now += 500; } // 8ms respawns
    for (let i = 0; i < 5; i += 1) { noteDeath(t, 'collision', now); now += 10; }
    const { score, reasons } = scoreTelemetry(t);
    expect(score).toBeGreaterThanOrEqual(SUSPECT_THRESHOLD);
    expect(reasons).toContain('machine-regular-input');
    expect(reasons).toContain('instant-respawn');
    expect(reasons).toContain('never-self-kills');
    expect(reasons).toContain('foreign-origin');
  });

  it('does NOT flag a human-like session (jittery timing, slow respawns, self-deaths, real origin)', () => {
    const t = newTelemetry();
    t.foreignOrigin = false;
    const gaps = [220, 410, 180, 650, 300, 90, 540, 260, 730, 150, 480, 210, 360, 120, 600, 280, 440, 170, 520, 240, 380, 110, 560, 300, 200];
    let now = 1000;
    noteInput(t, now);
    for (const g of gaps) { now += g; noteInput(t, now); }
    for (let i = 0; i < 10; i += 1) {
      noteDeath(t, i % 3 === 0 ? 'self' : 'cut', now); // ~1/3 self-deaths
      noteRespawn(t, now + 350); // human reaction delay
      now += 2000;
    }
    const { score } = scoreTelemetry(t);
    expect(score).toBeLessThan(SUSPECT_THRESHOLD);
  });

  it('stays quiet until there is enough data (no early false positives)', () => {
    const t = newTelemetry();
    let now = 0;
    for (let i = 0; i < 5; i += 1) { noteInput(t, now); now += 250; } // regular but tiny sample
    const { score, reasons } = scoreTelemetry(t);
    expect(reasons).not.toContain('machine-regular-input');
    expect(score).toBe(0);
  });
});
