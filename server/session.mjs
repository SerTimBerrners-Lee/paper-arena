// session.mjs — per-connection server state.
import { newTelemetry } from './antibot.mjs';

export class Session {
  constructor() {
    this.ws = null;
    this.slotId = -1;       // engine player slot this connection controls, or -1 (not joined)
    this.pendingDir = null; // latest queued direction, consumed next tick
    this.name = 'Player';
    this.userId = null;     // bound auth user (null for anonymous practice)
    this.mode = 'wager';    // 'wager' (staked) | 'practice' (free)
    this.tel = newTelemetry(); // anti-bot behavioural telemetry
  }
}
