// Off-screen threat indicators: an arc + chevron on an ellipse near the
// screen edge pointing at living enemies outside the view (including behind
// the camera, which maps to the bottom edge). Crucial in 3D — the thing that
// kills you is usually the thing you can't see. Three levels:
//   idle   (circle / feint / recover …)  white, fades with distance; sharks
//          circling or feinting beyond IDLE_HIDE metres get no arc at all, so
//          you rarely see the whole threat
//   warm   (ai.state 'approach' / 'flank': committed)  steady amber, full opacity
//   hot    (telegraph / attack / enemy:strike — isHot())  pulsing red
// The boss always has an arc.
// "On screen" isn't just the centre: a 16 m megalodon often has its centre
// past the edge while its head fills the frame. An enemy is in view when its
// centre, its jaws (mouth, head spheres) or — unless it is striking — any
// trunk / tail sphere projects inside the margin. A striking shark whose tail
// alone is visible still gets its arc: the bite comes from the other end.
import { h } from '../dom.js';
import { projectPoint, makeProjection, viewport } from '../projection.js';

const POOL = 4;
const MARGIN = 0.94; // NDC: inside this the enemy counts as on screen
const NEAR = 6; // metres: full strength
const FAR = 70; // metres: faintest
const IDLE_HIDE = 28; // metres: circling / feinting sharks further away show nothing
const WARM_STATES = new Set(['approach', 'flank']);
const LURK_STATES = new Set(['circle', 'feint']);

export class ThreatIndicators {
  constructor(parent) {
    this.el = h('div', 'fish-threats');
    parent.appendChild(this.el);
    this.items = [];
    for (let i = 0; i < POOL; i++) {
      const el = h('div', 'fish-threat');
      el.innerHTML = `
        <div class="fish-threat__inner">
          <svg viewBox="-40 -40 80 80" aria-hidden="true">
            <path class="fish-threat__glow" d="M-4 -27 A 62 62 0 0 1 -4 27" />
            <path class="fish-threat__arc" d="M-4 -27 A 62 62 0 0 1 -4 27" />
            <path class="fish-threat__chev" d="M9 -8 L18 0 L9 8" />
          </svg>
        </div>`;
      this.el.appendChild(el);
      // `enemy` is the enemy shown this frame (read by tests; not a DOM write).
      this.items.push({ el, on: false, hot: null, warm: null, huge: null, x: NaN, y: NaN, ang: NaN, sc: NaN, op: -1, enemy: null });
    }
    this._p = makeProjection();
    this._q = makeProjection(); // scratch for the extra body points (keeps _p = centre)
  }

  /** Is any part of `e` other than its centre inside the margin (see header)? */
  _partInView(camera, e, hot) {
    const q = this._q;
    const mouth = e.getMouthPosition?.();
    if (mouth && projectPoint(camera, mouth, q, MARGIN).onScreen) return true;
    const hb = e.hurtboxes;
    if (!hb) return false;
    for (let i = 0; i < hb.length; i++) {
      const part = hb[i].part;
      if (part !== 'head' && (hot || (part !== 'body' && part !== 'tail'))) continue;
      if (projectPoint(camera, hb[i].center, q, MARGIN).onScreen) return true;
    }
    return false;
  }

  hideAll() {
    for (const it of this.items) this._set(it, false);
  }

  /** Screen position (CSS px) of the arc shown for `enemy` this frame, or null. */
  anchorFor(enemy, out) {
    if (!enemy) return null;
    for (const it of this.items) {
      if (it.on && it.enemy === enemy) {
        out.x = it.x;
        out.y = it.y;
        return out;
      }
    }
    return null;
  }

  _set(it, on) {
    if (!on) it.enemy = null;
    if (it.on !== on) {
      it.on = on;
      it.el.classList.toggle('is-on', on);
    }
  }

  /**
   * @param camera     THREE camera (matrices current)
   * @param enemies    Enemy[]
   * @param origin     Vector3 to measure distance from (player)
   * @param isHot      (enemy) => boolean, telegraphing / striking
   */
  update(camera, enemies, origin, isHot) {
    const w = viewport.w;
    const hgt = viewport.h;
    const cx = w * 0.5;
    const cy = hgt * 0.5;
    const rx = cx - Math.max(46, w * 0.045);
    const ry = cy - Math.max(46, hgt * 0.07);
    let n = 0;
    const list = enemies ?? [];
    for (let i = 0; i < list.length && n < POOL; i++) {
      const e = list[i];
      if (!e || e.alive === false || !e.position) continue;
      const p = projectPoint(camera, e.position, this._p, MARGIN);
      if (p.onScreen) continue;
      const hot = isHot(e);
      if (this._partInView(camera, e, hot)) continue;

      const dist = origin ? e.position.distanceTo(origin) : 30;
      const boss = !!e.isBoss;
      const ai = e.ai?.state ?? e.state;
      const warm = !hot && WARM_STATES.has(ai);
      // A shark lurking out in the murk stays unannounced (the boss never does).
      if (!hot && !warm && !boss && dist > IDLE_HIDE && LURK_STATES.has(ai)) continue;

      const it = this.items[n++];
      it.enemy = e;

      // Direction in screen space from camera-space x/y; things behind the
      // camera are pushed toward the bottom edge.
      let dx = p.camX;
      let dy = -p.camY;
      if (p.camZ > 0) dy += p.camZ * 0.6;
      let len = Math.hypot(dx, dy);
      if (len < 1e-4) {
        dx = 0;
        dy = 1;
        len = 1;
      }
      dx /= len;
      dy /= len;
      const t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
      const x = Math.round(cx + dx * t);
      const y = Math.round(cy + dy * t);
      const ang = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);

      const k = Math.min(1, Math.max(0, (FAR - dist) / (FAR - NEAR)));
      const op = hot || warm ? 1 : Math.round((0.2 + 0.8 * k * k) * 100) / 100;
      const sc = Math.round((0.85 + 0.35 * k) * 50) / 50;

      if (x !== it.x || y !== it.y || ang !== it.ang || sc !== it.sc) {
        it.x = x;
        it.y = y;
        it.ang = ang;
        it.sc = sc;
        it.el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${ang}deg) scale(${sc})`;
      }
      if (op !== it.op) {
        it.op = op;
        it.el.style.opacity = String(op);
      }
      if (hot !== it.hot) {
        it.hot = hot;
        it.el.classList.toggle('is-hot', hot);
      }
      if (warm !== it.warm) {
        it.warm = warm;
        it.el.classList.toggle('is-warm', warm);
      }
      const huge = (e.length ?? 0) >= 10;
      if (huge !== it.huge) {
        it.huge = huge;
        it.el.classList.toggle('is-huge', huge);
      }
      this._set(it, true);
    }
    for (let i = n; i < POOL; i++) this._set(this.items[i], false);
  }
}
