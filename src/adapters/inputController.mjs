// inputController.mjs
// Translates keyboard / touch / d-pad input into a single queued heading.
//
//   - Arrow keys & WASD set an ABSOLUTE direction (up/down/left/right).
//   - The on-screen d-pad buttons and horizontal swipes issue a RELATIVE turn
//     (left / right of the current heading), which fits one-thumb play.
//
// getCommand(currentDir) returns the resolved absolute direction (or null) and
// clears the pending input, so each tick consumes at most one decision.

import { turn } from '../core/gameCore.mjs';

const KEY_TO_DIR = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};

export class InputController {
  constructor({ canvas, document: doc = document } = {}) {
    this.canvas = canvas;
    this._pendingAbsolute = null; // 'up'|'down'|'left'|'right'
    this._pendingRelative = null; // 'left'|'right'
    this._swipeStart = null;
    this._cleanup = [];

    const onKey = (e) => {
      const dir = KEY_TO_DIR[e.code];
      if (!dir) return;
      this._pendingAbsolute = dir;
      this._pendingRelative = null;
      e.preventDefault();
    };
    doc.addEventListener('keydown', onKey, { passive: false });
    this._cleanup.push(() => doc.removeEventListener('keydown', onKey));

    // On-screen d-pad buttons (any element with [data-turn]).
    const turnButtons = doc.querySelectorAll('[data-turn]');
    turnButtons.forEach((btn) => {
      const side = btn.getAttribute('data-turn');
      const handler = (e) => {
        e.preventDefault();
        this._pendingRelative = side === 'left' ? 'left' : 'right';
        this._pendingAbsolute = null;
      };
      btn.addEventListener('pointerdown', handler);
      this._cleanup.push(() => btn.removeEventListener('pointerdown', handler));
    });

    // Touch swipe on the canvas.
    if (canvas) {
      const onStart = (e) => {
        const t = e.changedTouches ? e.changedTouches[0] : e;
        this._swipeStart = { x: t.clientX, y: t.clientY };
      };
      const onEnd = (e) => {
        if (!this._swipeStart) return;
        const t = e.changedTouches ? e.changedTouches[0] : e;
        const dx = t.clientX - this._swipeStart.x;
        const dy = t.clientY - this._swipeStart.y;
        this._swipeStart = null;
        if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
        if (Math.abs(dx) > Math.abs(dy)) {
          this._pendingAbsolute = dx > 0 ? 'right' : 'left';
        } else {
          this._pendingAbsolute = dy > 0 ? 'down' : 'up';
        }
        this._pendingRelative = null;
      };
      canvas.addEventListener('touchstart', onStart, { passive: true });
      canvas.addEventListener('touchend', onEnd, { passive: true });
      this._cleanup.push(() => canvas.removeEventListener('touchstart', onStart));
      this._cleanup.push(() => canvas.removeEventListener('touchend', onEnd));
    }
  }

  // Returns the absolute direction to apply this tick, or null.
  getCommand(currentDir) {
    let cmd = null;
    if (this._pendingAbsolute) {
      cmd = this._pendingAbsolute;
    } else if (this._pendingRelative && currentDir) {
      cmd = turn(currentDir, this._pendingRelative);
    }
    this._pendingAbsolute = null;
    this._pendingRelative = null;
    return cmd;
  }

  destroy() {
    for (const fn of this._cleanup) fn();
    this._cleanup = [];
  }
}
