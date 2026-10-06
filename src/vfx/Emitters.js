// Continuous emitters driven by world state rather than one-shot calls:
//  - wounds: thin blood tendrils streaming from where an enemy was cut,
//    attached to the enemy so they trail behind it as it swims
//  - wakes: occasional bubble streams from the fins/tails of fast sharks
//  - dodge: a burst + short stream of bubbles when the player dashes
//  - sediment: silt kicked up by bodies moving close to the seabed and a big
//    cloud when a dead fish lands on the bottom
import * as THREE from 'three';

const MAX_WOUNDS = 16;
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();

export class Emitters {
  constructor(vfx) {
    this.vfx = vfx;
    this.game = vfx.game;
    this.wounds = [];
    for (let i = 0; i < MAX_WOUNDS; i++) {
      this.wounds.push({ active: false, obj: null, owner: null, local: new THREE.Vector3(), t: 0, dur: 1, rate: 1, acc: 0, size: 1 });
    }
    this._nextWound = 0;
    this._dodgeT = 0;
    this._dodgeAcc = 0;
    this._wakeAcc = new WeakMap(); // enemy -> Float32Array accumulators per hurtbox
    this._landed = new WeakSet();
    this._sedAcc = new WeakMap();
  }

  /**
   * Attach a bleeding wound to `owner` (an Enemy or anything with object3d).
   * worldPoint is converted to the owner's local space so the wound moves
   * with it.
   */
  addWound(owner, worldPoint, { duration = 6, rate = 6, size = 1 } = {}) {
    const obj = owner?.object3d ?? owner;
    if (!obj?.isObject3D || !worldPoint) return;
    // reuse an existing wound very close to this point on the same owner
    let slot = null;
    for (let i = 0; i < MAX_WOUNDS; i++) {
      const w = this.wounds[i];
      if (!w.active || w.owner !== owner) continue;
      obj.updateWorldMatrix(true, false);
      _w.copy(w.local).applyMatrix4(obj.matrixWorld);
      if (_w.distanceToSquared(worldPoint) < 0.36) {
        slot = w;
        break;
      }
    }
    if (!slot) {
      slot = this.wounds[this._nextWound];
      this._nextWound = (this._nextWound + 1) % MAX_WOUNDS;
      obj.updateWorldMatrix(true, false);
      slot.local.copy(worldPoint);
      obj.worldToLocal(slot.local);
      slot.acc = 0;
    }
    const reuse = slot.active && slot.owner === owner;
    const remaining = reuse ? slot.dur - slot.t : 0;
    slot.rate = reuse ? Math.max(rate, slot.rate) : rate;
    slot.size = reuse ? Math.max(size, slot.size) : size;
    slot.dur = Math.max(remaining, duration);
    slot.t = 0;
    slot.active = true;
    slot.obj = obj;
    slot.owner = owner;
  }

  onDodge() {
    const p = this.game.player;
    if (!p) return;
    this._dodgeT = 0.38;
    const c = p.hurtbox?.center ?? p.position;
    this.vfx.spawnBubbles(c, 22, { speed: 1.6, size: 1.2, spread: 0.35 });
  }

  update(dt) {
    if (dt <= 0) return;
    const vfx = this.vfx;
    const game = this.game;

    // ---- wounds -----------------------------------------------------------
    for (let i = 0; i < MAX_WOUNDS; i++) {
      const w = this.wounds[i];
      if (!w.active) continue;
      w.t += dt;
      if (w.t >= w.dur || !w.obj.parent) {
        w.active = false;
        w.obj = null;
        w.owner = null;
        continue;
      }
      const k = 1 - w.t / w.dur;
      w.acc += w.rate * (0.25 + 0.75 * k) * dt;
      if (w.acc < 1) continue;
      w.obj.updateWorldMatrix(true, false);
      _w.copy(w.local).applyMatrix4(w.obj.matrixWorld);
      while (w.acc >= 1) {
        w.acc -= 1;
        vfx.spawnBloodTendril(_w, w.size * (0.6 + 0.4 * k));
      }
    }

    // ---- enemies: wakes, sediment, landing -------------------------------
    const enemies = game.enemies?.enemies;
    const env = game.env;
    if (enemies) {
      for (let e = 0; e < enemies.length; e++) {
        const en = enemies[e];
        if (!en?.position) continue;
        const speed = en.velocity ? en.velocity.length() : 0;
        const len = en.length ?? 5;
        const scale = Math.max(1, len / 6);
        const seabed = env?.getSeabedHeight ? env.getSeabedHeight(en.position.x, en.position.z) : -1e9;
        const h = en.position.y - seabed;

        if (en.alive && speed > 6.5 && en.hurtboxes) {
          let acc = this._wakeAcc.get(en);
          if (!acc || acc.length < en.hurtboxes.length) {
            acc = new Float32Array(Math.max(8, en.hurtboxes.length));
            this._wakeAcc.set(en, acc);
          }
          for (let i = 0; i < en.hurtboxes.length; i++) {
            const hb = en.hurtboxes[i];
            if (hb.part !== 'tail' && hb.part !== 'fin') continue;
            acc[i] += (speed - 6.5) * 1.6 * scale * vfx.budget * dt;
            while (acc[i] >= 1) {
              acc[i] -= 1;
              const r = (hb.radius ?? 0.3) * 0.6;
              vfx.bubbles.spawn(
                hb.center.x + (Math.random() - 0.5) * r,
                hb.center.y + (Math.random() - 0.5) * r,
                hb.center.z + (Math.random() - 0.5) * r,
                -en.velocity.x * 0.08 + (Math.random() - 0.5) * 0.4,
                -en.velocity.y * 0.08 + (Math.random() - 0.5) * 0.4,
                -en.velocity.z * 0.08 + (Math.random() - 0.5) * 0.4,
                (0.002 + Math.pow(Math.random(), 3) * 0.014) * Math.sqrt(scale),
                1.8 + Math.random() * 2.5,
                0.9,
              );
            }
          }
        }

        // silt stirred up by a body skimming the bottom
        if (speed > 3 && h < len * 0.3 + 1.2) {
          let acc = this._sedAcc.get(en) ?? 0;
          acc += (speed - 3) * 0.6 * scale * vfx.budget * dt * (1 - h / (len * 0.3 + 1.2));
          while (acc >= 1) {
            acc -= 1;
            _w.set(
              en.position.x - (en.forward?.x ?? 0) * len * 0.35 + (Math.random() - 0.5) * len * 0.3,
              seabed + 0.3,
              en.position.z - (en.forward?.z ?? 0) * len * 0.35 + (Math.random() - 0.5) * len * 0.3,
            );
            vfx.spawnSediment(_w, 0.35 * scale);
          }
          this._sedAcc.set(en, acc);
        }

        // a dead fish hitting the bottom raises a big cloud (once)
        if (!en.alive && !this._landed.has(en) && h < len * 0.18 + 0.8) {
          this._landed.add(en);
          _w.set(en.position.x, seabed + 0.2, en.position.z);
          vfx.spawnSediment(_w, 2.2 * scale);
          // a soft ring of displaced water on the sand — not for the 16 m
          // megalodon, whose 14 m ring cut across the frame as a straight line
          if (len * 0.9 <= 6) {
            _d.set(0, 1, 0);
            vfx.pressure.ring(_w, _d, len * 0.9, 1.6, 0.35, 0.1);
          }
          game.cameraRig?.addTrauma?.(0.15 * Math.min(2, scale));
        }
      }
    }

    // ---- player dodge stream ---------------------------------------------
    if (this._dodgeT > 0) {
      this._dodgeT -= dt;
      const p = game.player;
      const c = p?.hurtbox?.center ?? p?.position;
      if (c) {
        this._dodgeAcc += 70 * vfx.budget * dt;
        while (this._dodgeAcc >= 1) {
          this._dodgeAcc -= 1;
          vfx.bubbles.spawn(
            c.x + (Math.random() - 0.5) * 0.5,
            c.y + (Math.random() - 0.5) * 0.6,
            c.z + (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.6 - (p.velocity?.x ?? 0) * 0.05,
            (Math.random() - 0.2) * 0.6,
            (Math.random() - 0.5) * 0.6 - (p.velocity?.z ?? 0) * 0.05,
            0.002 + Math.pow(Math.random(), 3) * 0.012,
            1.5 + Math.random() * 2.5,
            0.9,
          );
        }
        const seabed = env?.getSeabedHeight ? env.getSeabedHeight(c.x, c.z) : -1e9;
        if (c.y - seabed < 1.6 && Math.random() < dt * 14) {
          _w.set(c.x, seabed + 0.25, c.z);
          vfx.spawnSediment(_w, 0.5);
        }
      }
    }
  }
}
