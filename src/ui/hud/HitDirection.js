// Damage-direction arcs: a red arc around the view centre pointing toward
// where a hit came from (player:hit sourcePosition). Re-aimed every frame as
// the camera turns, fades out over ~1.2 s.
import * as THREE from 'three';
import { h } from '../dom.js';
import { compassAngle } from '../projection.js';

const POOL = 4;
const LIFE = 1.25;
const LIFE_HEAVY = 1.7;

export class HitDirection {
  constructor(parent) {
    this.el = h('div', 'fish-hitdirs');
    parent.appendChild(this.el);
    this.items = [];
    for (let i = 0; i < POOL; i++) {
      const el = h('div', 'fish-hitdir', '<i></i><b></b>');
      this.el.appendChild(el);
      this.items.push({ el, src: new THREE.Vector3(), t: 0, life: 1, ang: NaN, op: -1, heavy: null });
    }
  }

  add(sourcePosition, heavy = false) {
    if (!sourcePosition) return;
    // Reuse the slot closest to expiring.
    let slot = this.items[0];
    for (const it of this.items) if (it.t < slot.t) slot = it;
    slot.src.copy(sourcePosition);
    slot.life = slot.t = heavy ? LIFE_HEAVY : LIFE;
    if (heavy !== slot.heavy) {
      slot.heavy = heavy;
      slot.el.classList.toggle('is-heavy', heavy);
    }
  }

  clear() {
    for (const it of this.items) {
      it.t = 0;
      if (it.op !== 0) {
        it.op = 0;
        it.el.style.opacity = '0';
      }
    }
  }

  update(rdt, camera) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.t <= 0) continue;
      it.t = Math.max(0, it.t - rdt);
      const k = it.t / it.life;
      // Quick attack, long ease-out.
      const op = Math.round(Math.min(1, k * 1.6) * k * 100) / 100;
      if (op !== it.op) {
        it.op = op;
        it.el.style.opacity = String(op);
      }
      const ang = Math.round((compassAngle(camera, it.src) * 180) / Math.PI);
      if (ang !== it.ang) {
        it.ang = ang;
        it.el.style.transform = `rotate(${ang}deg)`;
      }
    }
  }
}
