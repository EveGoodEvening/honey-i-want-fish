// Bottom-left: 老公's health (with a delayed white "damage lag" segment) and
// stamina. Bars move with transform: scaleX only; values are written to the
// DOM only when they visibly change.
import { h, clamp01, damp, q3 } from '../dom.js';
import { PLAYER } from '../../core/config.js';

const LAG_HOLD = 0.65; // seconds the white segment waits before draining
const LOW_HP = 0.3;

const SHAKE = [
  { transform: 'translateX(0)' },
  { transform: 'translateX(-3px)' },
  { transform: 'translateX(2px)' },
  { transform: 'translateX(-1px)' },
  { transform: 'translateX(0)' },
];
const SHAKE_OPTS = { duration: 260, easing: 'ease-out' };
const FLASH = [{ opacity: 0.9 }, { opacity: 0 }];
const FLASH_OPTS = { duration: 420, easing: 'ease-out' };
const BLINK = [{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }];

export class PlayerBars {
  constructor(parent) {
    const el = (this.el = h('div', 'fish-player'));
    el.innerHTML = `
      <div class="fish-player__head">
        <span class="fish-player__name">老公</span>
        <span class="fish-player__num">100</span>
      </div>
      <div class="fish-barwrap fish-barwrap--hp">
        <div class="fish-bar fish-bar--hp"><i class="fish-bar__lag"></i><i class="fish-bar__fill"></i><i class="fish-bar__flash"></i></div>
      </div>
      <div class="fish-barwrap fish-barwrap--st">
        <div class="fish-bar fish-bar--st"><i class="fish-bar__fill"></i></div>
      </div>`;
    parent.appendChild(el);
    this.numEl = el.querySelector('.fish-player__num');
    this.hpWrap = el.querySelector('.fish-barwrap--hp');
    this.hpFill = el.querySelector('.fish-bar--hp .fish-bar__fill');
    this.hpLag = el.querySelector('.fish-bar--hp .fish-bar__lag');
    this.hpFlash = el.querySelector('.fish-bar--hp .fish-bar__flash');
    this.stWrap = el.querySelector('.fish-barwrap--st');
    this.stFill = el.querySelector('.fish-bar--st .fish-bar__fill');

    this.hpShown = 1;
    this.lag = 1;
    this.hold = 0;
    this.stShown = 1;
    this.stFullFor = 0;
    this._w = { hp: -1, lag: -1, st: -1, num: -1, low: null, stLow: null, stFull: null };
  }

  /** Damage feedback: jolt the bar and flash it. */
  onHit(heavy) {
    this.hold = LAG_HOLD;
    this.hpWrap.animate(SHAKE, heavy ? { duration: 380, easing: 'ease-out' } : SHAKE_OPTS);
    this.hpFlash.animate(FLASH, FLASH_OPTS);
  }

  /** Called on a failed dodge (not enough stamina) — the stamina bar blinks. */
  onStaminaDenied() {
    this.stWrap.animate(BLINK, { duration: 360 });
  }

  update(rdt, player) {
    if (!player) return;
    const w = this._w;
    const hp = clamp01((player.health ?? 0) / (player.maxHealth || PLAYER.maxHealth));

    // Fill: drops instantly, rises smoothly (heals read as a refill).
    if (hp < this.hpShown) this.hpShown = hp;
    else this.hpShown += (hp - this.hpShown) * damp(5, rdt);
    // Lag: waits, then drains toward the real value.
    if (hp >= this.lag) {
      this.lag = this.hpShown;
    } else if (this.hold > 0) {
      this.hold -= rdt;
    } else {
      this.lag += (hp - this.lag) * damp(3.2, rdt);
      if (this.lag - hp < 0.002) this.lag = hp;
    }

    const fill = q3(this.hpShown);
    if (fill !== w.hp) {
      w.hp = fill;
      this.hpFill.style.transform = `scaleX(${fill})`;
    }
    const lag = q3(Math.max(this.lag, this.hpShown));
    if (lag !== w.lag) {
      w.lag = lag;
      this.hpLag.style.transform = `scaleX(${lag})`;
    }
    const num = Math.ceil(player.health ?? 0);
    if (num !== w.num) {
      w.num = num;
      this.numEl.textContent = String(Math.max(0, num));
    }
    const low = hp > 0 && hp < LOW_HP;
    if (low !== w.low) {
      w.low = low;
      this.el.classList.toggle('is-low', low);
    }

    // Stamina.
    const st = clamp01((player.stamina ?? 0) / (player.maxStamina || PLAYER.maxStamina));
    this.stShown += (st - this.stShown) * damp(14, rdt);
    const stq = q3(this.stShown);
    if (stq !== w.st) {
      w.st = stq;
      this.stFill.style.transform = `scaleX(${stq})`;
    }
    const stLow = (player.stamina ?? 0) < PLAYER.dodgeCost;
    if (stLow !== w.stLow) {
      w.stLow = stLow;
      this.stWrap.classList.toggle('is-low', stLow);
    }
    this.stFullFor = st >= 0.999 ? this.stFullFor + rdt : 0;
    const stFull = this.stFullFor > 1.4;
    if (stFull !== w.stFull) {
      w.stFull = stFull;
      this.stWrap.classList.toggle('is-full', stFull);
    }
  }

  /** Snap displayed values (after a respawn / reset). */
  snap(player) {
    const hp = clamp01((player?.health ?? 0) / (player?.maxHealth || PLAYER.maxHealth));
    this.hpShown = this.lag = hp;
    this.hold = 0;
  }
}
