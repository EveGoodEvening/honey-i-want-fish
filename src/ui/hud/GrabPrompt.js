// Grab QTE prompt: 「狂按 左键/J —— 刺它的眼！」 with a progress ring driven by
// grab:progress {value}, a draining time line (combat.grab.timeLeft when
// available) and a pulse on every stab press. While the game is paused the
// prompt fades out (it would sit on the pause menu's hint) and freezes; resume
// brings it back as it was.
import { h, clamp01, damp } from '../dom.js';

const R = 46;
const C = 2 * Math.PI * R;
const BUMP = [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }];
const BUMP_OPTS = { duration: 160, easing: 'ease-out' };
const RESULT_HOLD = 0.9; // seconds the 「挣脱」 confirmation stays
// The stab is the 'attack' action: left mouse button or J.
const PROMPT = '狂按 左键/J —— 刺它的眼！';

export class GrabPrompt {
  constructor(parent, game) {
    this.game = game;
    const el = (this.el = h('div', 'fish-grab'));
    el.innerHTML = `
      <div class="fish-grab__halo"></div>
      <div class="fish-grab__ring">
        <svg viewBox="-60 -60 120 120" aria-hidden="true">
          <circle class="fish-grab__track" r="${R}" />
          <circle class="fish-grab__prog" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${C.toFixed(2)}" />
        </svg>
        <div class="fish-grab__key">左键</div>
      </div>
      <div class="fish-grab__text">${PROMPT}</div>
      <div class="fish-grab__time"><i></i></div>`;
    parent.appendChild(el);
    this.ringEl = el.querySelector('.fish-grab__ring');
    this.progEl = el.querySelector('.fish-grab__prog');
    this.textEl = el.querySelector('.fish-grab__text');
    this.timeEl = el.querySelector('.fish-grab__time i');

    this.active = false;
    this.value = 0;
    this.shown = 0;
    this._maxTime = 0;
    this._result = 0; // >0 while showing the success line
    this._orphan = 0; // seconds combat.grab has been null while we're active
    this._sawGrab = false;
    this._paused = false;
    this._w = { prog: -1, time: -1 };
  }

  start() {
    this.active = true;
    this.value = 0;
    this.shown = 0;
    this._maxTime = 0;
    this._result = 0;
    this._orphan = 0;
    this._sawGrab = false;
    this._w.time = 1;
    this.timeEl.style.transform = 'scaleX(1)';
    this.el.classList.remove('has-time');
    this.textEl.textContent = PROMPT;
    this.el.classList.remove('is-success');
    this.el.classList.add('is-on');
  }

  progress(value) {
    if (!this.active) this.start();
    this.value = clamp01(+value || 0);
  }

  /**
   * Success holds the 「挣脱！」 line; a failed escape (the timeout bite) and an
   * `interrupted` end (retry, state change, shark gone — no outcome) just close.
   */
  end(success, interrupted = false) {
    if (!this.active) return;
    this.active = false;
    if (success && !interrupted) {
      this.value = 1;
      this._result = RESULT_HOLD;
      this.textEl.textContent = '挣脱！';
      this.el.classList.add('is-success');
    } else {
      this.hide();
    }
  }

  hide() {
    this.active = false;
    this._result = 0;
    this.el.classList.remove('is-on');
  }

  /**
   * @param rdt     real seconds
   * @param playing combat states ('playing' or 'paused'); anything else closes the prompt
   * @param paused  'paused': fade out and freeze (no countdown, no stab pulses)
   */
  update(rdt, playing, paused = false) {
    if (paused !== this._paused) {
      this._paused = paused;
      this.el.classList.toggle('is-paused', paused);
    }
    if (!this.active && this._result <= 0) return;
    if (!playing) {
      this.hide();
      return;
    }
    if (paused) return;
    if (this._result > 0) {
      this._result -= rdt;
      if (this._result <= 0) this.hide();
    }
    const g = this.game;
    if (this.active) {
      if (g.input.pressed('attack')) this.ringEl.animate(BUMP, BUMP_OPTS);
      // Safety: if combat.grab was set during this grab and is now gone
      // without a grab:end, close the prompt anyway.
      const combat = g.combat;
      if (combat?.grab) {
        this._sawGrab = true;
        this._orphan = 0;
      } else if (this._sawGrab) {
        this._orphan += rdt;
        if (this._orphan > 0.6) this.hide();
      }
      const tl = combat?.grab?.timeLeft;
      if (typeof tl === 'number') {
        if (this._maxTime === 0) this.el.classList.add('has-time');
        if (tl > this._maxTime) this._maxTime = tl;
        const k = this._maxTime > 0 ? Math.round(clamp01(tl / this._maxTime) * 500) / 500 : 1;
        if (k !== this._w.time) {
          this._w.time = k;
          this.timeEl.style.transform = `scaleX(${k})`;
        }
      }
    }
    this.shown += (this.value - this.shown) * damp(18, rdt);
    const off = Math.round(C * (1 - this.shown) * 10) / 10;
    if (off !== this._w.prog) {
      this._w.prog = off;
      this.progEl.style.strokeDashoffset = String(off);
    }
  }
}
