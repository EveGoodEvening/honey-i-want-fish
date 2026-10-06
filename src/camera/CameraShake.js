// Trauma-based camera shake, sustained rumbles, FOV kicks and the gentle
// underwater sway. Runs on real (unscaled) time so a hitstop freeze-frame
// still shakes — that is what makes hits feel heavy.
import { noise1, noise2 } from './noise.js';

const MAX_KICKS = 6;

export class CameraShake {
  constructor() {
    this.trauma = 0;
    this.t = 0;
    this.decay = 1.25; // trauma per second
    this.floor = 0; // externally driven minimum (e.g. while grabbed)
    this.rumble = 0; // sustained, slowly fading trauma (roars, megalodon pass)
    this.rumbleTime = 0;
    this.rumbleDur = 1;
    this.kicks = [];
    for (let i = 0; i < MAX_KICKS; i++) this.kicks.push({ delta: 0, t: 0, dur: 1, attack: 0.08, active: false });

    // outputs (read after update)
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.fov = 0;
  }

  addTrauma(amount) {
    if (!(amount > 0)) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  addRumble(amount, duration) {
    if (amount >= this.currentRumble()) {
      this.rumble = Math.min(1, amount);
      this.rumbleTime = 0;
      this.rumbleDur = Math.max(0.1, duration);
    }
  }

  currentRumble() {
    if (this.rumbleTime >= this.rumbleDur) return 0;
    const k = this.rumbleTime / this.rumbleDur;
    return this.rumble * (1 - k * k);
  }

  /** FOV punch: reaches `delta` degrees after `attack` s, eases back over `duration`. */
  kickFov(delta, duration = 0.4, attack = 0.08) {
    if (!delta || !(duration > 0)) return;
    let slot = null;
    for (let i = 0; i < MAX_KICKS; i++) {
      const k = this.kicks[i];
      if (!k.active) {
        slot = k;
        break;
      }
      // reuse the one closest to finishing
      if (!slot || k.t / k.dur > slot.t / slot.dur) slot = k;
    }
    slot.delta = delta;
    slot.t = 0;
    slot.dur = duration;
    slot.attack = Math.min(attack, duration * 0.5);
    slot.active = true;
  }

  /**
   * @param {number} dt real seconds
   * @param {number} swayAmount 0..1 idle sway strength
   */
  update(dt, swayAmount = 1) {
    this.t += dt;
    const t = this.t;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    this.rumbleTime += dt;
    const tr = Math.max(this.trauma, this.floor, this.currentRumble());
    const s = tr * tr;
    // violent shakes are also faster
    const f = 11 + 14 * tr;
    const tt = t * f;
    this.yaw = noise1(tt, 1) * 0.045 * s;
    this.pitch = noise1(tt, 2) * 0.04 * s;
    this.roll = noise1(tt, 3) * 0.075 * s;
    this.x = noise1(tt, 4) * 0.14 * s;
    this.y = noise1(tt, 5) * 0.12 * s;
    this.z = noise1(tt, 6) * 0.08 * s;

    // underwater sway: slow, layered, never fully still
    const sw = swayAmount;
    this.x += noise2(t * 0.21, 11) * 0.05 * sw;
    this.y += noise2(t * 0.17, 12) * 0.06 * sw;
    this.roll += noise2(t * 0.13, 13) * 0.013 * sw;
    this.pitch += noise2(t * 0.19, 14) * 0.006 * sw;
    this.yaw += noise2(t * 0.15, 15) * 0.005 * sw;

    let fov = 0;
    for (let i = 0; i < MAX_KICKS; i++) {
      const k = this.kicks[i];
      if (!k.active) continue;
      k.t += dt;
      if (k.t >= k.dur) {
        k.active = false;
        continue;
      }
      let env;
      if (k.t < k.attack) {
        const a = k.t / k.attack;
        env = a * a * (3 - 2 * a);
      } else {
        const r = (k.t - k.attack) / (k.dur - k.attack);
        env = 1 - r * r * (3 - 2 * r);
      }
      fov += k.delta * env;
    }
    this.fov = Math.max(-18, Math.min(22, fov));
  }

  reset() {
    this.trauma = 0;
    this.rumble = 0;
    this.floor = 0;
    for (let i = 0; i < MAX_KICKS; i++) this.kicks[i].active = false;
  }
}
