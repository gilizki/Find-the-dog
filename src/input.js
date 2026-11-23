// Keyboard input: held keys for continuous movement, a queue for one-shot actions.

export const HOLD_BINDINGS = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'forward', KeyW: 'forward',
  ArrowDown: 'back', KeyS: 'back',
};

export const ACTION_BINDINGS = {
  Space: 'bark',
  KeyR: 'restart',
  KeyH: 'reveal',
  KeyB: 'ambient',
  Escape: 'menu',
  KeyM: 'menu',
};

export class Input {
  constructor() {
    this.held = new Set();
    this.queue = [];
  }

  /** Returns true if the key is bound (so the caller can preventDefault). */
  keyDown(code, repeat = false) {
    if (HOLD_BINDINGS[code]) {
      this.held.add(HOLD_BINDINGS[code]);
      return true;
    }
    if (ACTION_BINDINGS[code]) {
      if (!repeat) this.queue.push(ACTION_BINDINGS[code]); // holding SPACE must not machine-gun barks
      return true;
    }
    return false;
  }

  keyUp(code) {
    if (HOLD_BINDINGS[code]) {
      this.held.delete(HOLD_BINDINGS[code]);
      return true;
    }
    return !!ACTION_BINDINGS[code];
  }

  /** turn: +1 = right (clockwise on screen), -1 = left. move: +1 forward, -1 back. */
  controls() {
    const h = this.held;
    return {
      turn: (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0),
      move: (h.has('forward') ? 1 : 0) - (h.has('back') ? 1 : 0),
    };
  }

  consumeActions() {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  clear() {
    this.held.clear();
    this.queue = [];
  }

  attach(target = window) {
    target.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.keyDown(e.code, e.repeat)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => {
      if (this.keyUp(e.code)) e.preventDefault();
    });
    target.addEventListener('blur', () => this.clear()); // avoid stuck keys when the window loses focus
  }
}
