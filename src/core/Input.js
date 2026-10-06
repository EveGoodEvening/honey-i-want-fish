// Keyboard + mouse input mapped to named actions. See docs/DESIGN.md "Input".
//
// Polling API (call from update()):
//   input.isDown('attack')    held this frame
//   input.pressed('attack')   went down since last frame
//   input.released('attack')  went up since last frame
//   input.mouseDX / mouseDY   pixels moved since last frame (pointer-locked)
// Game calls input.endFrame() once per rendered frame after all updates.
// Mouse buttons press actions only in the states that read them: 'playing'
// and 'transition' (with pointer lock or ?freemouse — an unlocked click only
// re-acquires the lock) and 'intro' (a click skips it). On menu screens
// (title, pause, death, victory) a click belongs to the DOM menu. Mouse-ups
// always release.

const KEY_BINDINGS = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'up',
  KeyC: 'down',
  ShiftLeft: 'dodge',
  ShiftRight: 'dodge',
  KeyJ: 'attack',
  KeyK: 'heavy',
  KeyE: 'parry',
  KeyL: 'parry',
  KeyQ: 'lock',
  Tab: 'lock',
  Escape: 'pause',
  KeyP: 'pause',
  Enter: 'confirm',
};

const MOUSE_BINDINGS = {
  0: 'attack',
  1: 'lock',
  2: 'heavy',
};

// Game states that show a DOM menu instead of the game (Director owns the states):
// mouse buttons press nothing there (see _mouseActsInGame).
const MENU_STATES = new Set(['boot', 'title', 'paused', 'dead', 'victory']);

export const ACTIONS = [
  'forward', 'back', 'left', 'right', 'up', 'down',
  'dodge', 'attack', 'heavy', 'parry', 'lock', 'pause', 'confirm',
];

export class Input {
  constructor(game) {
    this.game = game;
    this.element = game.renderer.domElement;
    this.down = new Set();
    this.justPressed = new Set();
    this.justReleased = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.sensitivity = 1;
    this.pointerLocked = false;
    this.enabled = true;

    this._onKeyDown = (e) => {
      const action = KEY_BINDINGS[e.code];
      if (!action) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!e.repeat) this._press(action);
    };
    this._onKeyUp = (e) => {
      const action = KEY_BINDINGS[e.code];
      if (action) this._release(action);
    };
    this._onMouseDown = (e) => {
      const action = MOUSE_BINDINGS[e.button];
      if (action && this._mouseActsInGame()) this._press(action);
    };
    this._onMouseUp = (e) => {
      const action = MOUSE_BINDINGS[e.button];
      if (action) this._release(action);
    };
    this._onMouseMove = (e) => {
      if (!this.pointerLocked && !this.game.debug.freeMouse) return;
      this.mouseDX += e.movementX * this.sensitivity;
      this.mouseDY += e.movementY * this.sensitivity;
    };
    this._onPointerLockChange = () => {
      const locked = document.pointerLockElement === this.element;
      if (locked !== this.pointerLocked) {
        this.pointerLocked = locked;
        this.game.events.emit('input:pointerlock', { locked });
      }
    };
    this._onBlur = () => {
      for (const a of [...this.down]) this._release(a);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  // Whether a mouse button press reaches the game as an action.
  // - Menu screens ('title', 'paused', 'dead', 'victory', also 'boot'): never.
  //   The menu's click lands in the same frame as its mousedown (always under
  //   --step, at low fps in real play), so a pressed 'attack' would survive into
  //   the first frame after 继续 / 再来一次 / 重新开始本关 and slash.
  // - 'intro': always — a click skips the cinematic (Director reads 'attack').
  // - 'playing' / 'transition': only while pointer lock holds (or ?freemouse).
  //   Play can run unlocked: resuming with Esc can't re-lock (a key press isn't
  //   a user activation for requestPointerLock, and Chrome refuses a re-lock
  //   right after the user exited it). The click that recovers the view (UI's
  //   canvas click handler requests the lock) must not also slash / charge /
  //   lock on — including on the frame the wave card hands over to play.
  _mouseActsInGame() {
    const st = this.game.state;
    if (MENU_STATES.has(st)) return false;
    if (st === 'intro') return true;
    return this.pointerLocked || !!this.game.debug.freeMouse;
  }

  _press(action) {
    if (!this.down.has(action)) {
      this.down.add(action);
      this.justPressed.add(action);
    }
  }

  _release(action) {
    if (this.down.has(action)) {
      this.down.delete(action);
      this.justReleased.add(action);
    }
  }

  isDown(action) {
    return this.enabled && this.down.has(action);
  }

  pressed(action) {
    return this.enabled && this.justPressed.has(action);
  }

  released(action) {
    return this.enabled && this.justReleased.has(action);
  }

  /** -1..1 axis from two actions, e.g. axis('right','left'). */
  axis(positive, negative) {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  requestPointerLock() {
    try {
      const p = this.element.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* headless / unsupported: free-mouse fallback via ?freemouse=1 */
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ---- Test / scripting hooks (used by scripts/smoke.mjs via window.__game) ----
  simulate(action, isDown) {
    if (isDown) this._press(action);
    else this._release(action);
  }

  tap(action) {
    this._press(action);
    setTimeout(() => this._release(action), 60);
  }

  addMouse(dx, dy) {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  endFrame() {
    this.justPressed.clear();
    this.justReleased.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
