// Lock-on reticle projected onto cameraRig.lockTarget. A thin rotated
// diamond of corner brackets; turns red and tightens when the target
// telegraphs an attack, and snaps tight and white-hot for a moment when the
// attack is about to connect (strike(), on enemy:strike — the parry cue).
import { h } from '../dom.js';
import { projectPoint, makeProjection, enemyAimPoint } from '../projection.js';

const ACQUIRE = [
  { transform: 'scale(1.9) rotate(45deg)', opacity: 0 },
  { transform: 'scale(0.92) rotate(-4deg)', opacity: 1, offset: 0.7 },
  { transform: 'scale(1) rotate(0deg)', opacity: 1 },
];
const ACQUIRE_OPTS = { duration: 300, easing: 'cubic-bezier(.2,.7,.2,1)' };

export class LockReticle {
  constructor(parent) {
    const el = (this.el = h('div', 'fish-reticle'));
    el.innerHTML = `
      <div class="fish-reticle__inner">
        <svg viewBox="-50 -50 100 100" aria-hidden="true">
          <g class="fish-reticle__brackets">
            <path d="M0 -40 L-12 -28 M0 -40 L12 -28" />
            <path d="M40 0 L28 -12 M40 0 L28 12" />
            <path d="M0 40 L-12 28 M0 40 L12 28" />
            <path d="M-40 0 L-28 -12 M-40 0 L-28 12" />
          </g>
          <circle class="fish-reticle__dot" r="2.2" />
        </svg>
      </div>`;
    parent.appendChild(el);
    this.inner = el.querySelector('.fish-reticle__inner');
    this._p = makeProjection();
    this._target = null;
    this._on = false;
    this._hot = false;
    this._x = -1;
    this._y = -1;
    this._big = false;
    this._strikeT = 0;
    this._strike = false;
  }

  /** Flash the strike state for `seconds` (real time). */
  strike(seconds = 0.2) {
    this._strikeT = Math.max(this._strikeT, seconds);
  }

  /**
   * Where the reticle is drawn on `enemy` (CSS px; `r` = its half-size in --u
   * units), or null when it isn't shown on that enemy this frame.
   */
  anchorFor(enemy, out) {
    if (!enemy || !this._on || this._target !== enemy) return null;
    out.x = this._x;
    out.y = this._y;
    out.r = this._big ? 38 : 26;
    return out;
  }

  update(camera, target, hot, rdt = 0) {
    const valid = target && target.alive !== false && target.position;
    let on = false;
    if (valid) {
      const p = projectPoint(camera, enemyAimPoint(target), this._p, 1.05);
      on = p.onScreen;
      if (on) {
        const x = Math.round(p.x * 2) / 2;
        const y = Math.round(p.y * 2) / 2;
        if (x !== this._x || y !== this._y) {
          this._x = x;
          this._y = y;
          this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }
      }
    }
    if (valid && target !== this._target) {
      this._target = target;
      const big = (target.length ?? 0) >= 10;
      if (big !== this._big) {
        this._big = big;
        this.el.classList.toggle('is-big', big);
      }
      this.inner.animate(ACQUIRE, ACQUIRE_OPTS);
    } else if (!valid) {
      this._target = null;
    }
    if (on !== this._on) {
      this._on = on;
      this.el.classList.toggle('is-on', on);
    }
    hot = on && hot;
    if (hot !== this._hot) {
      this._hot = hot;
      this.el.classList.toggle('is-hot', hot);
    }
    if (this._strikeT > 0) this._strikeT = Math.max(0, this._strikeT - rdt);
    const strike = on && this._strikeT > 0;
    if (strike !== this._strike) {
      this._strike = strike;
      this.el.classList.toggle('is-strike', strike);
    }
  }
}
