// netClient.mjs — CLIENT-side networking + authoritative-state mirror.
// Opens the WebSocket (bound to a JWT + mode), keeps a "mirror" game object the
// renderer/hud read, applies keyframes/deltas, interpolates, and surfaces the
// economy control messages (wallet/kill/death/cashout) as events.
import {
  peekOp, OP, decodeKeyframe, decodeDelta, encodeInput, NO_TRAIL,
} from './protocol.mjs';

const TICK_MS = 1000 / 12;

function apiHost() {
  const env = (import.meta && import.meta.env) || {};
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  if (env.VITE_WS_URL) return env.VITE_WS_URL;
  if (env.DEV) return `${proto}://${location.hostname}:3801/ws`; // Vite dev: straight to Bun
  return `${proto}://${location.host}/ws`;                       // prod: same origin
}

export class NetClient {
  constructor(name, opts = {}) {
    this.name = name;
    this.token = opts.token || null;
    this.mode = opts.mode || 'wager';
    this.ws = null;
    this._intentDir = null;
    this._lastDeltaTime = 0;
    this._closedByUs = false;
    this._cb = { keyframe: [], status: [], respawn: [], wallet: [], kill: [], death: [], cashout: [], error: [], scoreboard: [], idle: [] };
    this.mirror = {
      cols: 0, rows: 0, cellCount: 0,
      owner: new Int16Array(0), trail: new Int16Array(0),
      version: 0, over: false, deathReason: null,
      players: [], config: { ticksPerSecond: 12 }, youId: 0, status: 'connecting',
    };
  }

  on(ev, fn) { (this._cb[ev] || (this._cb[ev] = [])).push(fn); return this; }
  _emit(ev, ...a) { for (const fn of (this._cb[ev] || [])) fn(...a); }

  _wsUrl() {
    const q = new URLSearchParams();
    q.set('mode', this.mode);
    if (this.token) q.set('token', this.token);
    return `${apiHost()}?${q.toString()}`;
  }

  connect() {
    this._closedByUs = false;
    const ws = new WebSocket(this._wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', name: this.name })));
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.mirror.status = 'disconnected';
      if (!this._closedByUs) setTimeout(() => this.connect(), 1000);
    });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  }

  disconnect() { this._closedByUs = true; try { this.ws && this.ws.close(); } catch {} this.ws = null; }

  sendInput(dir) {
    this._intentDir = dir;
    if (this.ws && this.ws.readyState === 1) this.ws.send(encodeInput(dir));
  }
  sendRespawn() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'respawn' })); }
  sendResync() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'resync' })); }

  getIntentDir() {
    const me = this.mirror.players[this.mirror.youId];
    return this._intentDir || (me && me.dir) || 'right';
  }

  // Interpolation fraction within the current tick (renderer eases prev→cur over one tick).
  getAlpha() {
    if (!this._lastDeltaTime) return 1;
    const dt = performance.now() - this._lastDeltaTime;
    return dt < 0 ? 0 : dt > TICK_MS ? 1 : dt / TICK_MS;
  }

  _onMessage(data) {
    if (typeof data === 'string') { this._onControl(data); return; }
    const op = peekOp(data);
    if (op === OP.KEYFRAME) this._applyKeyframe(decodeKeyframe(data));
    else if (op === OP.DELTA) this._applyDelta(decodeDelta(data)); // apply immediately — no playout buffer (latency)
  }

  _onControl(text) {
    let m; try { m = JSON.parse(text); } catch { return; }
    switch (m.type) {
      case 'status': this.mirror.status = m.status; this._emit('status', m.status, m.humans, m.needed); break;
      case 'wallet': this._emit('wallet', m); break;
      case 'kill': this._emit('kill', m); break;
      case 'death': this.mirror.over = true; this.mirror.deathReason = m.reason; this._emit('death', m); break;
      case 'scoreboard': this._emit('scoreboard', m.rows); break;
      case 'idle': this._emit('idle', m.seconds); break;
      case 'error': this._emit('error', m.code); break;
      default: break;
    }
  }

  _applyKeyframe(kf) {
    const M = this.mirror;
    M.cols = kf.cols; M.rows = kf.rows; M.cellCount = kf.cols * kf.rows;
    M.owner = kf.owner; M.trail = kf.trail;
    M.youId = kf.youId;
    M.status = kf.status === 1 ? 'active' : 'waiting';
    M.over = false; M.deathReason = null;
    M.players = kf.players.map((p) => ({
      id: p.id, name: p.name, isHuman: p.isHuman, color: p.color,
      x: p.x, y: p.y, prevX: p.x, prevY: p.y, dir: p.dir, alive: p.alive, area: p.area,
      trailCells: p.headTrailCell === NO_TRAIL ? [] : [p.headTrailCell],
    }));
    M.version += 1;
    this._lastDeltaTime = performance.now();
    this._intentDir = null;
    this._emit('keyframe');
    this._emit('status', M.status, 0, 0);
  }

  _applyDelta(d) {
    const M = this.mirror;
    M.status = d.status === 1 ? 'active' : 'waiting';
    for (const [i, v] of d.ownerChanges) M.owner[i] = v;
    for (const [i, v] of d.trailChanges) M.trail[i] = v;
    let meRespawned = false;
    for (const pd of d.players) {
      const p = M.players[pd.id];
      if (!p) continue;
      const wasAlive = p.alive;
      p.prevX = p.x; p.prevY = p.y;
      p.x = pd.x; p.y = pd.y; p.dir = pd.dir; p.alive = pd.alive; p.isHuman = pd.isHuman; p.area = pd.area;
      p.trailCells = pd.headTrailCell === NO_TRAIL ? [] : [pd.headTrailCell];
      if (pd.meta) { p.color = pd.meta.color; p.name = pd.meta.name; }
      if (pd.id === M.youId && !wasAlive && pd.alive) meRespawned = true; // our slot flipped dead->alive
      // Teleport snap: the engine moves exactly 1 cell/tick, so a jump >1 cell or a
      // dead->alive flip is a respawn relocation. Snap prev=cur so the renderer does
      // NOT interpolate a fast "slide" across the whole map (the death/respawn skating).
      if (Math.abs(p.x - p.prevX) > 1 || Math.abs(p.y - p.prevY) > 1 || (!wasAlive && p.alive)) {
        p.prevX = p.x; p.prevY = p.y;
      }
    }
    const me = M.players[M.youId];
    if (me) this._intentDir = me.dir; // reconcile relative-turn intent to authoritative
    // Respawn only on a genuine dead->alive flip of OUR slot. Without this, the jitter buffer
    // replaying pre-death deltas (where we still look alive) after the real-time death control
    // message already set over=true would falsely fire respawn and hide the death screen.
    if (meRespawned) { M.over = false; M.deathReason = null; this._emit('respawn'); }
    M.version += 1;
    this._lastDeltaTime = performance.now();
  }
}
