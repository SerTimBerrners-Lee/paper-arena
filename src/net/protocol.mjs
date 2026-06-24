// protocol.mjs
// SHARED wire protocol for the authoritative server <-> thin client.
// Pure JS (no DOM, no Bun, no PlayCanvas) so both the Vite client and the Bun
// server import this single source of truth and can never drift.
//
// Transport: WebSocket. Hot-path frames (keyframe/delta/input) are BINARY
// (ArrayBuffer, little-endian via DataView). Rare control frames are JSON text.
// The client distinguishes by `typeof event.data` ('string' => JSON control).

export const PROTO_VERSION = 1;

export const OP = {
  KEYFRAME: 0x01, // server -> client: full snapshot (join / resync)
  DELTA: 0x02,    // server -> client: per-tick changes
  INPUT: 0x10,    // client -> server: a direction
};

export const STATUS = { WAITING: 0, ACTIVE: 1 };
export const NO_TRAIL = 0xffff;     // sentinel: player has no active trail cell
export const NO_KILLER = 0xff;      // sentinel: death with no attributable killer

export const DIR_CODES = ['up', 'down', 'left', 'right'];
export const DIR_TO_CODE = { up: 0, down: 1, left: 2, right: 3 };
export const DEATH_REASONS = ['self', 'wall', 'cut', 'collision', 'enclosed'];

const TE = new TextEncoder();
const TD = new TextDecoder();

const dirCode = (d) => (DIR_TO_CODE[d] ?? 3);
const headOf = (p) => (p.trailCells && p.trailCells.length ? p.trailCells[p.trailCells.length - 1] : NO_TRAIL);

// ── tiny growable binary writer / reader (all little-endian) ──────────────────
class Writer {
  constructor(cap = 1024) {
    this.buf = new ArrayBuffer(cap);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.off = 0;
  }
  _ensure(n) {
    if (this.off + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < this.off + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.u8);
    this.buf = nb;
    this.dv = new DataView(nb);
    this.u8 = new Uint8Array(nb);
  }
  U8(v) { this._ensure(1); this.dv.setUint8(this.off, v); this.off += 1; }
  U16(v) { this._ensure(2); this.dv.setUint16(this.off, v, true); this.off += 2; }
  I16(v) { this._ensure(2); this.dv.setInt16(this.off, v, true); this.off += 2; }
  U32(v) { this._ensure(4); this.dv.setUint32(this.off, v, true); this.off += 4; }
  Bytes(arr) { this._ensure(arr.length); this.u8.set(arr, this.off); this.off += arr.length; }
  Str(s) { const b = TE.encode(s || ''); this.U16(b.length); this.Bytes(b); }
  done() { return this.buf.slice(0, this.off); }
}

class Reader {
  constructor(buf) {
    this.dv = new DataView(buf);
    this.u8 = new Uint8Array(buf);
    this.off = 0;
  }
  U8() { const v = this.dv.getUint8(this.off); this.off += 1; return v; }
  U16() { const v = this.dv.getUint16(this.off, true); this.off += 2; return v; }
  I16() { const v = this.dv.getInt16(this.off, true); this.off += 2; return v; }
  U32() { const v = this.dv.getUint32(this.off, true); this.off += 4; return v; }
  Bytes(n) { const v = this.u8.subarray(this.off, this.off + n); this.off += n; return v; }
  Str() { return TD.decode(this.Bytes(this.U16())); }
}

export function peekOp(buf) {
  return new DataView(buf).getUint8(0);
}

// ── KEYFRAME (full snapshot) ──────────────────────────────────────────────────
export function encodeKeyframe(game, youId, status) {
  const w = new Writer(64 * 1024);
  w.U8(OP.KEYFRAME);
  w.U16(PROTO_VERSION);
  w.U32(game.tick);
  w.U16(game.cols);
  w.U16(game.rows);
  w.U8(youId);
  w.U8(status);
  w.U8(game.players.length);
  for (const p of game.players) {
    w.U8(p.id);
    w.U8((p.alive ? 1 : 0) | (p.isHuman ? 2 : 0));
    w.U8(p.color[0]); w.U8(p.color[1]); w.U8(p.color[2]);
    w.U16(p.x); w.U16(p.y);
    w.U8(dirCode(p.dir));
    w.U16(p.area);
    w.U16(headOf(p));
    w.Str(p.name);
  }
  const n = game.cols * game.rows;
  for (let i = 0; i < n; i += 1) w.I16(game.owner[i]);
  for (let i = 0; i < n; i += 1) w.I16(game.trail[i]);
  return w.done();
}

export function decodeKeyframe(buf) {
  const r = new Reader(buf);
  r.U8(); // op
  const proto = r.U16();
  const tick = r.U32();
  const cols = r.U16();
  const rows = r.U16();
  const youId = r.U8();
  const status = r.U8();
  const count = r.U8();
  const players = [];
  for (let k = 0; k < count; k += 1) {
    const id = r.U8();
    const flags = r.U8();
    const color = [r.U8(), r.U8(), r.U8()];
    const x = r.U16();
    const y = r.U16();
    const dir = DIR_CODES[r.U8()];
    const area = r.U16();
    const headTrailCell = r.U16();
    const name = r.Str();
    players.push({ id, alive: !!(flags & 1), isHuman: !!(flags & 2), color, x, y, dir, area, headTrailCell, name });
  }
  const n = cols * rows;
  const owner = new Int16Array(n);
  for (let i = 0; i < n; i += 1) owner[i] = r.I16();
  const trail = new Int16Array(n);
  for (let i = 0; i < n; i += 1) trail[i] = r.I16();
  return { proto, tick, cols, rows, youId, status, players, owner, trail };
}

// ── DELTA (per-tick changes) ──────────────────────────────────────────────────
// payload = { tick, status, ownerChanges:[[idx,val]], trailChanges:[[idx,val]],
//             players:[{id,alive,isHuman,x,y,dir,headTrailCell,area, meta?:{color,name}}],
//             events:[{type:'death',id,reason,killerId} | {type:'capture',id,cells}] }
export function encodeDelta(p) {
  const w = new Writer(2048);
  w.U8(OP.DELTA);
  w.U32(p.tick);
  w.U8(p.status);
  w.U16(p.ownerChanges.length);
  for (const [i, v] of p.ownerChanges) { w.U16(i); w.I16(v); }
  w.U16(p.trailChanges.length);
  for (const [i, v] of p.trailChanges) { w.U16(i); w.I16(v); }
  w.U8(p.players.length);
  for (const pl of p.players) {
    w.U8(pl.id);
    w.U8((pl.alive ? 1 : 0) | (pl.isHuman ? 2 : 0) | (pl.meta ? 4 : 0));
    w.U16(pl.x); w.U16(pl.y);
    w.U8(dirCode(pl.dir));
    w.U16(pl.headTrailCell);
    w.U16(pl.area);
    if (pl.meta) {
      w.U8(pl.meta.color[0]); w.U8(pl.meta.color[1]); w.U8(pl.meta.color[2]);
      w.Str(pl.meta.name);
    }
  }
  w.U8(p.events.length);
  for (const e of p.events) {
    if (e.type === 'death') {
      w.U8(0); w.U8(e.id);
      w.U8(DEATH_REASONS.indexOf(e.reason) & 0xff);
      w.U8(e.killerId == null ? NO_KILLER : e.killerId);
    } else {
      w.U8(1); w.U8(e.id); w.U16(e.cells || 0);
    }
  }
  return w.done();
}

export function decodeDelta(buf) {
  const r = new Reader(buf);
  r.U8(); // op
  const tick = r.U32();
  const status = r.U8();
  const ownerChanges = [];
  const oc = r.U16();
  for (let k = 0; k < oc; k += 1) ownerChanges.push([r.U16(), r.I16()]);
  const trailChanges = [];
  const tc = r.U16();
  for (let k = 0; k < tc; k += 1) trailChanges.push([r.U16(), r.I16()]);
  const players = [];
  const pc = r.U8();
  for (let k = 0; k < pc; k += 1) {
    const id = r.U8();
    const flags = r.U8();
    const x = r.U16();
    const y = r.U16();
    const dir = DIR_CODES[r.U8()];
    const headTrailCell = r.U16();
    const area = r.U16();
    let meta = null;
    if (flags & 4) meta = { color: [r.U8(), r.U8(), r.U8()], name: r.Str() };
    players.push({ id, alive: !!(flags & 1), isHuman: !!(flags & 2), x, y, dir, headTrailCell, area, meta });
  }
  const events = [];
  const ec = r.U8();
  for (let k = 0; k < ec; k += 1) {
    const type = r.U8();
    const id = r.U8();
    if (type === 0) {
      const reason = DEATH_REASONS[r.U8()];
      const kb = r.U8();
      events.push({ type: 'death', id, reason, killerId: kb === NO_KILLER ? null : kb });
    } else {
      events.push({ type: 'capture', id, cells: r.U16() });
    }
  }
  return { tick, status, ownerChanges, trailChanges, players, events };
}

// ── INPUT (client -> server) ──────────────────────────────────────────────────
export function encodeInput(dir) {
  const w = new Writer(2);
  w.U8(OP.INPUT);
  w.U8(dirCode(dir));
  return w.done();
}

export function decodeInput(buf) {
  const r = new Reader(buf);
  r.U8(); // op
  return DIR_CODES[r.U8()];
}
