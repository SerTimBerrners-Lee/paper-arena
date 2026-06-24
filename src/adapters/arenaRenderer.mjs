// arenaRenderer.mjs
// Cyberpunk 2.5D renderer for the grid Paper.io core.
//
// Strategy — single layer, allocation-light, zero per-frame meshing:
//   • The ENTIRE arena (territory + trails + empty field + a glowing TRON grid)
//     is painted into ONE NEAREST texture sized (cols*SS) x (rows*SS), repainted
//     only when game.version changes. No earcut, no mesh rebuilds, no GC churn.
//   • That texture sits on a single flat UNLIT quad at y=0 (pure, saturated neon).
//   • Players are small lit + emissive 3-D cubes; the camera's slight tilt gives
//     them depth, and bloom makes them glow.
//   • Camera: orthographic, FIXED north-up orientation (never rotates with the
//     player), slight tilt, smooth follow.
//   • Post FX via pc.CameraFrame: bloom (neon glow), vignette, chromatic
//     aberration (fringing) and a little colour grading — the cyberpunk look.

import * as pc from 'playcanvas';
import { DIRS } from '../core/gameCore.mjs';

// ── tunables (tweak the feel here) ───────────────────────────────────────────
const SS        = 6;     // texture pixels per cell (>=2). higher = thinner/crisper grid lines
const ZOOM      = 12;    // ortho half-height in CELLS — smaller = more zoomed in
const ZOOM_MAX  = 19;    // max half-height — caps zoom-out on tall/portrait phones
const MIN_HALF_W = 8.5;  // keep at least this many cells visible to each side (mobile)
const TILT_DEG  = 24;    // camera tilt from vertical (0 = pure top-down, bigger = more 3D lean)
const CAM_LERP  = 0.16;  // camera follow smoothing (0..1)

const TOKEN_W     = 0.86; // player cube footprint (cells)
const TOKEN_H     = 0.62; // bot height
const TOKEN_H_YOU = 0.88; // human height

// post-processing (cyberpunk)
const BLOOM     = 0.028;  // bloom intensity 0..0.1 — neon glow strength
const FRINGE    = 3.5;    // chromatic aberration 0..100
const VIGNETTE  = 0.55;   // vignette intensity 0..1
const SATURATE  = 1.18;   // colour grading saturation

// retro-neon palette (RGB 0..255)
const VOID       = [4, 5, 12];     // beyond the arena / camera clear colour
const FIELD      = [8, 9, 20];     // empty playable cell (near-black blue)
const FIELD_LINE = [16, 52, 70];   // glowing cyan TRON grid line on empty field

// theme palettes — light theme swaps field/void/grid and softens vignette & bloom
const PAL = {
  dark:  { VOID, FIELD, FIELD_LINE, vig: VIGNETTE, vigColor: [0, 0, 0], bloom: BLOOM },
  light: { VOID: [225, 231, 243], FIELD: [236, 240, 249], FIELD_LINE: [176, 196, 214], vig: 0.3, vigColor: [120, 138, 165], bloom: 0.016 },
};
const themeName = () => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

// ── tiny helpers ─────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lighten = ([r, g, b], t) => [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t];
const scale = ([r, g, b], t) => [r * t, g * t, b * t];
const col01 = ([r, g, b]) => new pc.Color(r / 255, g / 255, b / 255);

// ── ArenaRenderer ────────────────────────────────────────────────────────────
export class ArenaRenderer {
  constructor(app, game) {
    this.app = app;
    this.game = game;
    this._pal = PAL[themeName()];
    this._mats = [];
    this._tokens = new Map(); // id -> { root, body, marker, h }
    this._lastVersion = -1;
    this._frame = null;
    this._heads = new Set(); // each player's newest trail cell — drawn UNDER the cube, never ahead
    this._youId = game.youId ?? 0; // slot the camera follows (the local player)

    const h = game.players[this._youId] || game.players[0];
    this._camLook = new pc.Vec3(h.x + 0.5, 0, h.y + 0.5);

    this._root = new pc.Entity('Arena');
    app.root.addChild(this._root);

    this._setupScene();
    this._buildTexture();
    this._rebuildColorTables();
    this._buildTokens();
    this._paint(true);
    this._placeCamera();
    this._setupPostFX();
  }

  // ── scene: lights, void floor, walls, camera ───────────────────────────────
  _setupScene() {
    const { app, game } = this;
    const { cols, rows } = game;

    app.scene.ambientLight = col01([40, 46, 72]);

    const key = new pc.Entity('Key');
    key.addComponent('light', {
      type: 'directional',
      color: new pc.Color(0.7, 0.85, 1.0),
      intensity: 1.1,
      castShadows: false,
    });
    key.setEulerAngles(52, 26, 0);
    this._root.addChild(key);

    const rim = new pc.Entity('Rim');
    rim.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1.0, 0.3, 0.8),
      intensity: 0.35,
    });
    rim.setEulerAngles(28, -140, 0);
    this._root.addChild(rim);

    // dark floor a touch below the arena, so the edges read as a surface
    const floor = new pc.Entity('Void');
    this._floorMat = this._unlit(this._pal.VOID);
    floor.addComponent('render', { type: 'box', material: this._floorMat });
    floor.setLocalScale(cols + 120, 0.1, rows + 120);
    floor.setLocalPosition(cols / 2, -0.14, rows / 2);
    this._root.addChild(floor);

    // raised walls around the arena (dark with a faint neon rim under bloom)
    const wallMat = this._lit([20, 24, 44], [10, 30, 52]);
    const W = 0.6;
    const HH = 1.1;
    for (const [sx, sy, sz, x, y, z] of [
      [cols + 2 * W, HH, W, cols / 2, HH / 2 - 0.05, -W / 2],
      [cols + 2 * W, HH, W, cols / 2, HH / 2 - 0.05, rows + W / 2],
      [W, HH, rows, -W / 2, HH / 2 - 0.05, rows / 2],
      [W, HH, rows, cols + W / 2, HH / 2 - 0.05, rows / 2],
    ]) {
      const w = new pc.Entity('Wall');
      w.addComponent('render', { type: 'box', material: wallMat });
      w.setLocalScale(sx, sy, sz);
      w.setLocalPosition(x, y, z);
      this._root.addChild(w);
    }

    this.camera = new pc.Entity('Camera');
    this.camera.addComponent('camera', {
      projection: pc.PROJECTION_ORTHOGRAPHIC,
      orthoHeight: ZOOM,
      nearClip: 0.1,
      farClip: 2000,
      clearColor: col01(this._pal.VOID),
    });
    this._root.addChild(this.camera);
  }

  // ── cyberpunk post-processing (bloom / vignette / fringing / grading) ───────
  _setupPostFX() {
    try {
      if (!pc.CameraFrame) return;
      const cf = new pc.CameraFrame(this.app, this.camera.camera);
      if (pc.TONEMAP_LINEAR !== undefined) cf.rendering.toneMapping = pc.TONEMAP_LINEAR;
      cf.rendering.samples = 4; // MSAA for crisp cube/wall edges

      this._cf = cf;
      cf.bloom.intensity = this._pal.bloom;
      cf.bloom.blurLevel = 16;

      cf.vignette.intensity = this._pal.vig;
      cf.vignette.inner = 0.4;
      cf.vignette.outer = 1.35;
      cf.vignette.curvature = 0.6;
      cf.vignette.color = col01(this._pal.vigColor);

      cf.fringing.intensity = FRINGE;

      cf.grading.enabled = true;
      cf.grading.saturation = SATURATE;
      cf.grading.contrast = 1.06;
      cf.grading.brightness = 1.02;
      cf.grading.tint = new pc.Color(1.0, 0.95, 1.0);

      cf.enabled = true;
      cf.update();
      this._frame = cf;
    } catch (e) {
      // HDR/post unsupported on this device — game still renders, just no glow.
      console.warn('[arena] post FX disabled:', e);
    }
  }

  // ── the single arena texture + its quad ────────────────────────────────────
  _buildTexture() {
    const { app, game } = this;
    const device = app.graphicsDevice;
    const { cols, rows } = game;
    const W = cols * SS;
    const H = rows * SS;
    this._texW = W;
    this._texH = H;

    const FMT = pc.PIXELFORMAT_RGBA8 ?? pc.PIXELFORMAT_R8_G8_B8_A8;
    this._tex = new pc.Texture(device, {
      name: 'arena',
      width: W,
      height: H,
      format: FMT,
      mipmaps: false,
      minFilter: pc.FILTER_NEAREST,
      magFilter: pc.FILTER_NEAREST,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });

    // unlit material → raw, saturated texture colours (bloom does the glowing)
    const m = new pc.StandardMaterial();
    m.useLighting = false;
    m.useSkybox = false;
    m.diffuse = new pc.Color(0, 0, 0);
    m.emissive = new pc.Color(1, 1, 1);
    m.emissiveMap = this._tex;
    m.cull = pc.CULLFACE_NONE;
    m.update();
    this._mats.push(m);

    // custom quad: world (x,z) in [0,cols] x [0,rows]; uv (0,0)->(1,1) so texel
    // (gx,gy) maps exactly onto grid cell (gx,gy). No flip ambiguity.
    const geo = new pc.Geometry();
    geo.positions = [0, 0, 0, cols, 0, 0, cols, 0, rows, 0, 0, rows];
    geo.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    geo.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    geo.indices = [0, 1, 2, 0, 2, 3];
    const mesh = pc.Mesh.fromGeometry(device, geo);

    const mi = new pc.MeshInstance(mesh, m);
    mi.castShadow = false;
    this._plane = new pc.Entity('Field');
    this._plane.addComponent('render', { meshInstances: [mi] });
    this._root.addChild(this._plane);
  }

  // ── per-player colour lookup (built once, reused every paint) ───────────────
  _rebuildColorTables() {
    this._terrFill = [];
    this._terrLine = [];
    this._trailFill = [];
    this._trailLine = [];
    for (const p of this.game.players) {
      const c = p.color;
      this._terrFill[p.id] = scale(c, 0.82); // territory: rich but not max (trail pops over it)
      this._terrLine[p.id] = scale(c, 0.5); // darker grid line on territory
      this._trailFill[p.id] = lighten(c, 0.55); // trail glows brightest
      this._trailLine[p.id] = lighten(c, 0.3);
    }
  }

  // ── player cubes ────────────────────────────────────────────────────────────
  _buildTokens() {
    for (const [, e] of this._tokens) e.root.destroy();
    this._tokens.clear();

    for (const p of this.game.players) {
      const isYou = p.isHuman;
      const h = isYou ? TOKEN_H_YOU : TOKEN_H;

      const root = new pc.Entity(`Tok-${p.id}`);
      this._root.addChild(root);

      const body = new pc.Entity('body');
      body.addComponent('render', {
        type: 'box',
        material: this._token(lighten(p.color, isYou ? 0.12 : 0.04), 0.55),
      });
      body.setLocalScale(TOKEN_W, h, TOKEN_W);
      body.setLocalPosition(0, h / 2, 0);
      root.addChild(body);

      // glowing white nub showing heading
      const marker = new pc.Entity('mk');
      marker.addComponent('render', { type: 'box', material: this._token([245, 248, 255], 0.6) });
      marker.setLocalScale(0.22, h * 0.5, 0.36);
      marker.setLocalPosition(TOKEN_W * 0.5, h * 0.6, 0);
      root.addChild(marker);

      this._tokens.set(p.id, { root, body, marker, h });
    }
  }

  // ── public API ──────────────────────────────────────────────────────────────
  render(alpha) {
    this._paint(false);
    this._updateTokens(alpha);
    this._updateCamera(alpha);
  }

  setFollow(id) {
    this._youId = id;
    const p = this.game.players[id];
    if (p) this._camLook.set(p.x + 0.5, 0, p.y + 0.5);
  }

  reset(game) {
    this.game = game;
    // re-apply theme palette (the player may have toggled dark/light between games)
    this._pal = PAL[themeName()];
    if (this.camera) this.camera.camera.clearColor = col01(this._pal.VOID);
    if (this._floorMat) { this._floorMat.emissive = col01(this._pal.VOID); this._floorMat.update(); }
    if (this._cf) {
      this._cf.bloom.intensity = this._pal.bloom;
      this._cf.vignette.intensity = this._pal.vig;
      this._cf.vignette.color = col01(this._pal.vigColor);
    }
    const dimsChanged = game.cols * SS !== this._texW || game.rows * SS !== this._texH;
    if (dimsChanged) {
      if (this._plane) this._plane.destroy();
      if (this._tex) this._tex.destroy();
      this._buildTexture();
    }
    this._rebuildColorTables();
    this._buildTokens();
    this._lastVersion = -1;
    if (game.youId != null) this._youId = game.youId;
    const h = game.players[this._youId] || game.players[0];
    this._camLook.set(h.x + 0.5, 0, h.y + 0.5);
    this._paint(true);
    this._placeCamera();
  }

  destroy() {
    if (this._frame) this._frame.destroy?.();
    for (const [, e] of this._tokens) e.root.destroy();
    this._tokens.clear();
    if (this._plane) this._plane.destroy();
    if (this._tex) this._tex.destroy();
    if (this._root) this._root.destroy();
    for (const m of this._mats) m.destroy?.();
    this._mats = [];
  }

  // ── repaint the arena texture from owner[]/trail[] ─────────────────────────
  _paint(force) {
    const { game } = this;
    if (!force && game.version === this._lastVersion) return;
    this._lastVersion = game.version;

    const { cols, rows, owner, trail, players } = game;
    const W = this._texW;

    // The newest trail cell of each player is the one its cube is moving ONTO.
    // Skip it so the trail only ever shows BEHIND the cube, never ahead of it.
    const heads = this._heads;
    heads.clear();
    for (const p of players) {
      if (p.alive && p.trailCells.length) heads.add(p.trailCells[p.trailCells.length - 1]);
    }

    const buf = this._tex.lock();

    for (let gy = 0; gy < rows; gy += 1) {
      const rowBase = gy * cols;
      const by = gy * SS;
      for (let gx = 0; gx < cols; gx += 1) {
        const i = rowBase + gx;
        let fill;
        let line;
        const t = trail[i];
        if (t >= 0 && !heads.has(i)) {
          fill = this._trailFill[t];
          line = this._trailLine[t];
        } else {
          const o = owner[i];
          if (o >= 0) {
            fill = this._terrFill[o];
            line = this._terrLine[o];
          } else {
            fill = this._pal.FIELD;
            line = this._pal.FIELD_LINE;
          }
        }
        const fr = fill[0];
        const fg = fill[1];
        const fb = fill[2];
        const lr = line[0];
        const lg = line[1];
        const lb = line[2];
        const bx = gx * SS;
        for (let dy = 0; dy < SS; dy += 1) {
          const edgeRow = dy === 0;
          let p = ((by + dy) * W + bx) * 4;
          for (let dx = 0; dx < SS; dx += 1) {
            if (edgeRow || dx === 0) {
              buf[p] = lr;
              buf[p + 1] = lg;
              buf[p + 2] = lb;
            } else {
              buf[p] = fr;
              buf[p + 1] = fg;
              buf[p + 2] = fb;
            }
            buf[p + 3] = 255;
            p += 4;
          }
        }
      }
    }

    this._tex.unlock();
  }

  // ── interpolated player cubes ──────────────────────────────────────────────
  _updateTokens(alpha) {
    const a = this.game.over ? 1 : clamp(alpha, 0, 1);
    for (const p of this.game.players) {
      const e = this._tokens.get(p.id);
      if (!e) continue;
      e.root.enabled = p.alive;
      if (!p.alive) continue;
      const vx = p.prevX + (p.x - p.prevX) * a + 0.5;
      const vz = p.prevY + (p.y - p.prevY) * a + 0.5;
      e.root.setLocalPosition(vx, 0, vz);
      const d = DIRS[p.dir] || [1, 0];
      const deg = -Math.atan2(d[1], d[0]) * 180 / Math.PI;
      e.root.setLocalEulerAngles(0, deg, 0);
    }
  }

  // ── camera follow (fixed orientation, slight tilt) ─────────────────────────
  _updateCamera(alpha) {
    const human = this.game.players[this._youId];
    const a = clamp(alpha, 0, 1);
    let tx = this._camLook.x;
    let tz = this._camLook.z;
    if (human && human.alive) {
      tx = human.prevX + (human.x - human.prevX) * a + 0.5;
      tz = human.prevY + (human.y - human.prevY) * a + 0.5;
    }
    this._camLook.x += (tx - this._camLook.x) * CAM_LERP;
    this._camLook.z += (tz - this._camLook.z) * CAM_LERP;
    this._placeCamera();
  }

  _placeCamera() {
    // Adapt zoom to the viewport aspect so phones (portrait) still see enough to
    // the sides, while desktop keeps the ZOOM framing.
    const gd = this.app.graphicsDevice;
    const aspect = gd.width && gd.height ? gd.width / gd.height : 1.6;
    this.camera.camera.orthoHeight = Math.min(ZOOM_MAX, Math.max(ZOOM, MIN_HALF_W / aspect));

    const tilt = (TILT_DEG * Math.PI) / 180;
    const dist = 400; // ortho: distance only affects clipping, not scale
    const oy = Math.cos(tilt) * dist;
    const oz = Math.sin(tilt) * dist;
    const lx = this._camLook.x;
    const lz = this._camLook.z;
    this.camera.setPosition(lx, oy, lz + oz);
    this.camera.lookAt(lx, 0, lz, 0, 1, 0);
  }

  // ── material factories (tracked for cleanup) ───────────────────────────────
  _lit(rgb, emissiveRgb) {
    const m = new pc.StandardMaterial();
    m.diffuse = col01(rgb);
    if (emissiveRgb) m.emissive = col01(emissiveRgb);
    m.gloss = 0.3;
    m.metalness = 0;
    m.useSkybox = false;
    m.update();
    this._mats.push(m);
    return m;
  }

  _token(rgb, emissiveScale) {
    const m = new pc.StandardMaterial();
    m.diffuse = col01(rgb);
    m.emissive = col01(scale(rgb, emissiveScale));
    m.gloss = 0.45;
    m.metalness = 0.1;
    m.useSkybox = false;
    m.update();
    this._mats.push(m);
    return m;
  }

  _unlit(rgb) {
    const m = new pc.StandardMaterial();
    m.useLighting = false;
    m.useSkybox = false;
    m.diffuse = new pc.Color(0, 0, 0);
    m.emissive = col01(rgb);
    m.update();
    this._mats.push(m);
    return m;
  }
}
