// FxState — time envelopes for PostFX one-shots (pulse types and flashes).
//
// Everything runs on *real* (unscaled) time so effects keep playing through
// hitstop and slow motion. Each frame `evaluate()` folds all active pulses
// into a flat set of channels that PostFX maps onto shader uniforms.
//
// Pulse types (see PostFX.pulse):
//   hit          player took a normal hit: short red edge pulse + chromatic punch
//   heavyHit     player took a heavy hit: stronger red, brief radial blur, shake
//   parry        white-cyan flash + radial shock-ring distortion
//   grab         red pulsing tunnel vision, held while the player is in the jaws
//   kill         brief desaturation + slow vignette swell
//   dodge        radial speed blur
//   roar         strong expanding distortion wave + image shake
//   perfectDodge (extra) cool desaturated speed blur for the slow-mo beat;
//                replaces (never adds to) the running dodge's blur
//                (peak radial blur 0.85)
//   strike       (extra) player landed a hit: tiny chromatic tick
//   crit         (extra) player landed a critical/heavy hit: punchier tick + blur
//
// Besides the pulses there is one held envelope, the attack wind-up
// ("telegraph tunnel", see telegraph()): it eases in over the enemy's
// telegraph on *game* time (it freezes with the enemy during hitstop/pause),
// holds until the attack is released, then lets go over WINDUP.release s of
// real time. Output: `windup` (0..~1.2, PostFX tightens the vignette with it)
// plus a little desaturation and chromatic aberration.
import { Vector2, Vector3 } from 'three';

const WINDUP = {
  release: 0.25, // s (real) to let go after the strike
  failsafe: 0.3, // s (game) after the telegraph's end without an attack
  desat: 0.1,
  ca: 0.0008,
};

export const PULSE_DURATION = {
  hit: 0.5,
  heavyHit: 0.8,
  parry: 0.7,
  grab: Infinity, // held; see grab handling
  kill: 2.4,
  dodge: 0.4,
  perfectDodge: 1.0,
  roar: 2.0,
  strike: 0.22,
  crit: 0.45,
};

// Rises linearly over `attack`, then falls with a quadratic ease to 0 at `dur`.
function env(t, attack, dur) {
  if (t < 0 || t >= dur) return 0;
  if (t < attack) return t / attack;
  const k = 1 - (t - attack) / (dur - attack);
  return k * k;
}

function easeOutCubic(x) {
  const k = 1 - Math.min(1, Math.max(0, x));
  return 1 - k * k * k;
}

class PulseSlot {
  constructor() {
    this.active = false;
    this.t = 0;
    this.strength = 1;
    this.center = new Vector2(0.5, 0.5);
  }
}

export class FxState {
  constructor() {
    this.slots = {};
    for (const k of Object.keys(PULSE_DURATION)) this.slots[k] = new PulseSlot();

    // grab is a held state rather than a one-shot
    this.grabLevel = 0;
    this.grabHeld = false;
    this.grabSince = 0;

    // attack wind-up envelope (held, see telegraph())
    this.windup = { active: false, releasing: false, source: null, t: 0, duration: 1, from: 0, level: 0, strength: 1 };

    // two flash slots: API flashes and internal (parry) flashes
    this.flashes = [
      { color: new Vector3(1, 1, 1), peak: 0, dur: 0.3, t: 1 },
      { color: new Vector3(1, 1, 1), peak: 0, dur: 0.3, t: 1 },
    ];

    // evaluated channels (read by PostFX)
    this.out = {
      ca: 0,
      radialBlur: 0,
      blurCenter: new Vector2(0.5, 0.5),
      shake: 0,
      shakeFreq: 30,
      redEdge: 0,
      desat: 0,
      vignette: 0,
      tunnel: 0,
      windup: 0,
      wobble: 0,
      exposure: 0,
      ring0: { center: new Vector2(0.5, 0.5), radius: 0, amp: 0, width: 0.08 },
      ring1: { center: new Vector2(0.5, 0.5), radius: 0, amp: 0, width: 0.16 },
      flashColor: new Vector3(1, 1, 1),
      flash: 0,
    };
  }

  /** Start (or restart) a pulse. `center` is an optional screen-space uv. */
  trigger(type, strength = 1, center = null) {
    const slot = this.slots[type];
    if (!slot) return false;
    if (type === 'grab') {
      this.grabHeld = true;
      this.grabSince = 0;
      slot.active = true;
      slot.t = 0;
      return true;
    }
    slot.active = true;
    slot.t = 0;
    slot.strength = strength;
    if (center) slot.center.copy(center);
    else slot.center.set(0.5, 0.5);
    // the perfect dodge *is* the running dodge, upgraded: it takes over
    if (type === 'perfectDodge') this.slots.dodge.active = false;
    return true;
  }

  releaseGrab() {
    this.grabHeld = false;
  }

  /**
   * Start the attack wind-up tunnel for `source` (an enemy): eases in over
   * `duration` seconds of game time. A second telegraph while one is held
   * takes over from the current level (no dip).
   */
  telegraph(source, duration, strength = 1) {
    const W = this.windup;
    const held = W.active && W.level > 0.01;
    W.strength = held ? Math.max(W.strength, strength) : strength;
    W.from = held ? W.level : 0;
    W.source = source ?? null;
    W.duration = Math.max(0.1, duration || 0.7);
    W.t = 0;
    W.active = true;
    W.releasing = false;
  }

  /** The attack fired (or the enemy died): let the tunnel go. Other sources are ignored. */
  releaseTelegraph(source = null) {
    const W = this.windup;
    if (!W.active || (source && W.source && source !== W.source)) return;
    W.releasing = true;
  }

  /** Full-screen tint. A weaker flash never cuts off a stronger one. */
  flash(color, intensity, duration, slotIndex = 0) {
    const f = this.flashes[slotIndex];
    const current = this._flashAmount(f);
    if (intensity < current) return;
    f.color.set(color.r, color.g, color.b);
    f.peak = intensity;
    f.dur = Math.max(0.03, duration);
    f.t = 0;
  }

  _flashAmount(f) {
    if (f.t >= f.dur || f.peak <= 0) return 0;
    const attack = Math.min(0.04, f.dur * 0.2);
    return f.peak * env(f.t, attack, f.dur);
  }

  clear() {
    for (const s of Object.values(this.slots)) s.active = false;
    for (const f of this.flashes) f.t = f.dur;
    this.grabHeld = false;
    this.grabLevel = 0;
    const W = this.windup;
    W.active = false;
    W.releasing = false;
    W.level = 0;
    W.source = null;
  }

  // Advance the wind-up envelope; returns level × strength.
  _evaluateWindup(dt, gameDt) {
    const W = this.windup;
    if (!W.active) return 0;
    if (!W.releasing) {
      W.t += gameDt;
      const u = Math.min(1, W.t / W.duration);
      W.level = W.from + (1 - W.from) * u * u * (3 - 2 * u);
      if (W.t > W.duration + WINDUP.failsafe) W.releasing = true;
    } else {
      W.level -= dt / WINDUP.release;
      if (W.level <= 0) {
        W.level = 0;
        W.active = false;
        W.source = null;
      }
    }
    return W.level * W.strength;
  }

  // Accumulate radial blur with an amount-weighted blur centre.
  _addBlur(amount, center) {
    if (amount <= 0) return;
    const o = this.out;
    const w = this._blurW;
    o.radialBlur += amount;
    o.blurCenter.x = (o.blurCenter.x * w + center.x * amount) / (w + amount);
    o.blurCenter.y = (o.blurCenter.y * w + center.y * amount) / (w + amount);
    this._blurW = w + amount;
  }

  /**
   * Advance by real dt and fold active pulses into `out`.
   * `grabStillHeld` lets PostFX confirm the grab from game state each frame.
   * `gameDt` (scaled game time, 0 while paused) drives the wind-up ramp;
   * defaults to `dt`.
   */
  evaluate(dt, grabStillHeld, gameDt = dt) {
    const o = this.out;
    o.ca = 0;
    o.radialBlur = 0;
    o.shake = 0;
    o.shakeFreq = 30;
    o.redEdge = 0;
    o.desat = 0;
    o.vignette = 0;
    o.tunnel = 0;
    o.windup = 0;
    o.wobble = 0;
    o.exposure = 0;
    o.ring0.amp = 0;
    o.ring1.amp = 0;
    o.blurCenter.set(0.5, 0.5);

    const S = this.slots;
    for (const k in S) {
      const s = S[k];
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= PULSE_DURATION[k]) s.active = false;
    }

    this._blurW = 0;

    // --- hit ---
    if (S.hit.active) {
      const t = S.hit.t;
      const e = env(t, 0.03, PULSE_DURATION.hit) * S.hit.strength;
      o.redEdge += 0.75 * e;
      o.ca += 0.007 * e;
      o.shake += 0.0035 * env(t, 0.0, 0.22) * S.hit.strength;
    }
    // --- heavyHit ---
    if (S.heavyHit.active) {
      const t = S.heavyHit.t;
      const st = S.heavyHit.strength;
      const e = env(t, 0.03, PULSE_DURATION.heavyHit) * st;
      o.redEdge += 1.05 * e;
      o.ca += 0.014 * e;
      o.vignette += 0.3 * e;
      o.desat += 0.18 * e;
      o.exposure -= 0.12 * e;
      o.shake += 0.009 * env(t, 0.0, 0.4) * st;
      this._addBlur(0.9 * env(t, 0.02, 0.32) * st, S.heavyHit.center);
    }
    // --- parry ---
    if (S.parry.active) {
      const t = S.parry.t;
      const st = S.parry.strength;
      const d = PULSE_DURATION.parry;
      o.ca += 0.005 * env(t, 0.0, 0.3) * st;
      o.exposure += 0.18 * env(t, 0.015, 0.28) * st;
      const r = o.ring0;
      r.center.copy(S.parry.center);
      r.radius = 0.02 + easeOutCubic(t / d) * 1.05;
      r.width = 0.05 + 0.1 * (t / d);
      const k = 1 - t / d;
      r.amp = 0.045 * k * k * st;
    }
    // --- grab (held) ---
    if (this.grabHeld || this.grabLevel > 0) {
      this.grabSince += dt;
      // Grace period: combat may call pulse('grab') a frame before its state is set.
      const held = this.grabHeld && (grabStillHeld || this.grabSince < 0.5);
      if (!held) this.grabHeld = false;
      const target = held ? 1 : 0;
      const rate = held ? 4 : 1.6;
      this.grabLevel += (target - this.grabLevel) * (1 - Math.exp(-dt * rate));
      if (!held && this.grabLevel < 0.005) {
        this.grabLevel = 0;
        S.grab.active = false;
      }
      const g = this.grabLevel;
      // 1.9 Hz panic throb
      const throb = 0.5 + 0.5 * Math.sin(this.grabSince * Math.PI * 2 * 1.9);
      o.tunnel += g;
      o.redEdge += g * (0.35 + 0.4 * throb * throb);
      o.ca += 0.004 * g * (0.5 + throb);
      o.wobble += 0.6 * g;
      o.desat += 0.22 * g;
      o.shake += 0.0018 * g;
    }
    // --- kill ---
    if (S.kill.active) {
      const t = S.kill.t;
      const st = S.kill.strength;
      o.desat += 0.7 * env(t, 0.05, 1.4) * st;
      o.vignette += 0.4 * env(t, 0.5, PULSE_DURATION.kill) * st;
      o.exposure -= 0.08 * env(t, 0.1, 1.6) * st;
      o.ca += 0.005 * env(t, 0.0, 0.35) * st;
    }
    // --- dodge / perfectDodge ---
    // One motion: the perfect dodge's speed blur and chromatic punch replace
    // the dodge's (the larger wins) instead of stacking on top of them.
    let dodgeBlur = 0;
    let dodgeCa = 0;
    let dodgeCenter = S.dodge.center;
    if (S.dodge.active) {
      const t = S.dodge.t;
      const e = env(t, 0.03, PULSE_DURATION.dodge) * S.dodge.strength;
      dodgeBlur = 0.55 * e;
      dodgeCa = 0.0035 * e;
    }
    if (S.perfectDodge.active) {
      const t = S.perfectDodge.t;
      const st = S.perfectDodge.strength;
      const blur = 0.85 * env(t, 0.02, 0.55) * st;
      if (blur >= dodgeBlur) {
        dodgeBlur = blur;
        dodgeCenter = S.perfectDodge.center;
      }
      dodgeCa = Math.max(dodgeCa, 0.007 * env(t, 0.02, 0.5) * st);
      o.desat += 0.4 * env(t, 0.05, PULSE_DURATION.perfectDodge) * st;
      o.vignette += 0.18 * env(t, 0.05, PULSE_DURATION.perfectDodge) * st;
    }
    this._addBlur(dodgeBlur, dodgeCenter);
    o.ca += dodgeCa;
    // --- roar ---
    if (S.roar.active) {
      const t = S.roar.t;
      const st = S.roar.strength;
      const d = PULSE_DURATION.roar;
      const r = o.ring1;
      r.center.copy(S.roar.center);
      r.radius = 0.04 + (t / d) * 1.9;
      r.width = 0.12 + 0.18 * (t / d);
      r.amp = 0.095 * Math.pow(1 - t / d, 1.2) * st;
      o.shake += 0.011 * env(t, 0.06, 1.5) * st;
      o.shakeFreq = 22;
      o.ca += 0.012 * env(t, 0.05, 1.3) * st;
      o.wobble += 2.2 * env(t, 0.08, d) * st;
      o.vignette += 0.28 * env(t, 0.1, d) * st;
      o.desat += 0.15 * env(t, 0.1, d) * st;
    }
    // --- attack wind-up (enemy telegraph) ---
    const wind = this._evaluateWindup(dt, gameDt);
    if (wind > 0) {
      o.windup = wind;
      o.desat += WINDUP.desat * wind;
      o.ca += WINDUP.ca * wind;
    }
    // --- strike / crit (player landed hits) ---
    if (S.strike.active) {
      const t = S.strike.t;
      o.ca += 0.004 * env(t, 0.01, PULSE_DURATION.strike) * S.strike.strength;
      o.shake += 0.0012 * env(t, 0.0, 0.12) * S.strike.strength;
    }
    if (S.crit.active) {
      const t = S.crit.t;
      const st = S.crit.strength;
      o.ca += 0.009 * env(t, 0.01, PULSE_DURATION.crit) * st;
      o.exposure += 0.08 * env(t, 0.01, 0.2) * st;
      this._addBlur(0.35 * env(t, 0.01, 0.22) * st, S.crit.center);
    }

    // --- flashes ---
    let fr = 0;
    let fg = 0;
    let fb = 0;
    let fa = 0;
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (f.t < f.dur) f.t += dt;
      const a = this._flashAmount(f);
      if (a <= 0) continue;
      fr += f.color.x * a;
      fg += f.color.y * a;
      fb += f.color.z * a;
      fa += a;
    }
    if (fa > 0) o.flashColor.set(fr / fa, fg / fa, fb / fa);
    o.flash = Math.min(1, fa);

    o.radialBlur = Math.min(1.2, o.radialBlur);
    o.redEdge = Math.min(1.2, o.redEdge);
    o.desat = Math.min(1, o.desat);
    return o;
  }
}
