// Keyboard + mouse navigable list of menu items.
//
// Keyboard goes through game.input (W/S/↑/↓ move, A/D/←/→ adjust, Enter
// activates, Esc → onBack). DOM focus is never given to the buttons
// (mousedown is prevented) so a native Enter-click can't double-fire, and the
// mousedown stops at the button: Input reads mouse buttons from window in the
// bubble phase, so a click on 继续 / 再来一次 would otherwise also press
// 'attack' and land a slash on the frame play resumes.
// A menu ignores input for `armDelay` seconds after opening so the key /
// click that opened it can't immediately trigger an item. Arming runs on the
// wall clock (like the CSS reveals the delays are matched to), not game time.

const now = () => performance.now() / 1000;

export class Menu {
  constructor(game, { armDelay = 0.25, onBack = null } = {}) {
    this.game = game;
    this.items = [];
    this.index = 0;
    this.active = false;
    this.armDelay = armDelay;
    this.onBack = onBack;
    this._openedAt = 0;
  }

  /**
   * @param {HTMLElement} el
   * @param {(event: MouseEvent|null) => void} activate
   * @param {{ left?: Function, right?: Function }} [opts]
   */
  add(el, activate, opts = {}) {
    const item = { el, activate, left: opts.left ?? null, right: opts.right ?? null, index: this.items.length };
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener('mouseenter', () => {
      if (this.active) this.focus(item.index);
    });
    el.addEventListener('click', (e) => {
      if (!this.isArmed()) return;
      this.focus(item.index, true);
      this._activate(item, e);
    });
    this.items.push(item);
    return item;
  }

  isArmed() {
    return this.active && now() - this._openedAt >= this.armDelay;
  }

  open(index = 0) {
    this.active = true;
    this._openedAt = now();
    this.focus(index, true);
  }

  close() {
    this.active = false;
  }

  /** Temporarily stop reading keys (a sub-panel is on top) without resetting focus. */
  suspend(on) {
    this.active = !on;
    // Re-arm shortly after the sub-panel closes so its closing key is not reused.
    if (!on) this._openedAt = Math.max(this._openedAt, now() - this.armDelay + 0.15);
  }

  focus(i, silent = false) {
    if (!this.items.length) return;
    const changed = i !== this.index;
    this.index = i;
    for (let k = 0; k < this.items.length; k++) this.items[k].el.classList.toggle('is-focus', k === i);
    if (changed && !silent) this.game.audio?.play?.('uiHover');
  }

  _activate(item, event) {
    this.game.audio?.play?.('uiClick');
    item.activate(event);
  }

  update() {
    if (!this.isArmed() || !this.items.length) return;
    const input = this.game.input;
    const n = this.items.length;
    if (input.pressed('forward')) this.focus((this.index - 1 + n) % n);
    else if (input.pressed('back')) this.focus((this.index + 1) % n);
    const item = this.items[this.index];
    if (input.pressed('left')) item.left?.();
    if (input.pressed('right')) item.right?.();
    if (input.pressed('confirm')) this._activate(item, null);
    else if (this.onBack && input.pressed('pause')) this.onBack();
  }
}
