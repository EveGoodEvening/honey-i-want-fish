// First-time guidance for the parry cue: 「现在 —— E 格挡」 flashes beside the
// striker when its attack is about to connect (enemy:strike). HUD decides when
// (the first two cues of wave 0 in a page session); this places it: next to
// the lock reticle when the striker is locked and on screen, else inward of
// its off-screen threat arc, else beside its head, and follows that anchor
// while it shows. A parry, a hit or leaving play hurries / hides it.
import { h } from '../dom.js';
import { viewport, projectPoint, makeProjection, enemyAimPoint } from '../projection.js';

const POP = [
  { opacity: 0, transform: 'scale(1.3)', filter: 'blur(4px)' },
  { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)', offset: 0.06 },
  { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)', offset: 0.74 },
  { opacity: 0, transform: 'scale(1)', filter: 'blur(2px)' },
];
// ≈1 s readable: the cue leads contact by only ~0.3 s, so the words mostly
// teach the link "this flash + sound = press E" for the next one.
const POP_OPTS = { duration: 1300, easing: 'ease-out' };
const HURRY = 4;

/** CSS px per --u (see ui.css). */
const unit = () => Math.max(0.62, Math.min(viewport.w / 1280, viewport.h / 720));

export class StrikeHint {
  constructor(parent) {
    const el = (this.el = h('div', 'fish-strikehint'));
    el.innerHTML = `
      <div class="fish-strikehint__in">
        <div class="fish-strikehint__pop"><b>现在</b><i></i><kbd>E</kbd><span>格挡</span></div>
      </div>`;
    parent.appendChild(el);
    this.pop = el.querySelector('.fish-strikehint__pop');
    this.enemy = null;
    this.anim = null;
    this._a = { x: 0, y: 0, r: 0 };
    this._p = makeProjection();
    this._w = { on: false, side: '', x: NaN, y: NaN };
  }

  get active() {
    return !!this.anim;
  }

  /** Flash the hint for `enemy`'s strike. */
  show(enemy) {
    this.enemy = enemy ?? null;
    this.anim?.cancel();
    this.anim = this.pop.animate(POP, POP_OPTS);
    this._w.x = NaN; // place it before the first paint
  }

  /** The strike resolved (parried / landed): let the words go quickly. */
  hurry() {
    if (this.anim?.playState === 'running') this.anim.updatePlaybackRate(HURRY);
  }

  hide() {
    this.anim?.cancel();
    this.anim = null;
    this.enemy = null;
    this._setOn(false);
  }

  _setOn(on) {
    if (on !== this._w.on) {
      this._w.on = on;
      this.el.classList.toggle('is-on', on);
    }
  }

  /**
   * @param camera   THREE camera (matrices current)
   * @param reticle  LockReticle (already updated this frame)
   * @param threats  ThreatIndicators (already updated this frame)
   * @param playing  game state is 'playing'
   */
  update(camera, reticle, threats, playing) {
    if (!this.anim) return;
    if (!playing || this.anim.playState === 'finished') {
      this.hide();
      return;
    }
    const w = viewport.w;
    const hgt = viewport.h;
    const u = unit();
    const a = this._a;
    const e = this.enemy;
    let x;
    let y;
    let side; // where the words sit relative to (x, y): 'r' right of it, 'l' left, 'm' centred
    if (reticle.anchorFor(e, a)) {
      // Beside the reticle, on the roomier side.
      side = a.x > w * 0.62 ? 'l' : 'r';
      x = a.x + (side === 'r' ? 1 : -1) * (a.r + 12) * u;
      y = a.y;
    } else if (threats.anchorFor(e, a)) {
      // The arc hugs the screen edge: step in toward the centre.
      let dx = w * 0.5 - a.x;
      let dy = hgt * 0.5 - a.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      x = a.x + dx * 54 * u;
      y = a.y + dy * 54 * u;
      side = dx < -0.45 ? 'l' : dx > 0.45 ? 'r' : 'm';
    } else if (e?.alive !== false && e?.position && projectPoint(camera, enemyAimPoint(e), this._p, 0.9).onScreen) {
      side = this._p.x > w * 0.62 ? 'l' : 'r';
      x = this._p.x + (side === 'r' ? 40 : -40) * u;
      y = this._p.y;
    } else {
      side = 'm';
      x = w * 0.5;
      y = hgt * 0.42;
    }
    // Clear of the letterbox-height top band and the bottom HUD rows.
    y = Math.min(Math.max(y, 70 * u), hgt - 140 * u);
    x = Math.round(x * 2) / 2;
    y = Math.round(y * 2) / 2;
    const ww = this._w;
    if (side !== ww.side) {
      ww.side = side;
      this.el.dataset.side = side;
    }
    if (x !== ww.x || y !== ww.y) {
      ww.x = x;
      ww.y = y;
      this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    this._setOn(true);
  }
}
