// VoicePool: plays registered sounds (src/audio/sfx.js) as Voices, with
//   - a global voice cap + per-sound instance caps (priority-based stealing),
//   - per-sound minimum retrigger intervals (dedupes event storms),
//   - 3D positioning: PannerNode (HRTF or equal-power) + a distance/behind
//     low-pass (far sounds and sounds behind the listener get duller; the
//     dulling distance scales with the sound's reference distance, so huge
//     far sources — whale song, deep booms, the megalodon — keep their body),
//   - `follow` targets (e.g. an enemy) whose position is tracked every update,
//   - leak-free cleanup: every node of a finished voice is disconnected.
// Works on any BaseAudioContext (live or offline).
import { Voice, clamp } from './dsp.js';
import { SOUNDS } from './sfx.js';

export class VoicePool {
  constructor(ctx, mixer, { maxVoices = 40, hrtf = true, label = 'sfx' } = {}) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.maxVoices = maxVoices;
    this.hrtf = hrtf;
    this.label = label;
    this.voices = [];
    this.lastPlayed = new Map();
    // Listener state (copied in by the engine each frame).
    this.lx = 0;
    this.ly = 0;
    this.lz = 0;
    this.fx = 0;
    this.fy = 0;
    this.fz = -1;
    this.stats = { played: 0, stolen: 0, dropped: 0, disposed: 0 };
  }

  setListener(px, py, pz, fx, fy, fz) {
    this.lx = px;
    this.ly = py;
    this.lz = pz;
    this.fx = fx;
    this.fy = fy;
    this.fz = fz;
  }

  count(name) {
    let n = 0;
    for (const v of this.voices) if (!v.ended && v.name === name) n++;
    return n;
  }

  /**
   * Play a registered sound. Returns the Voice (with `.ctl` for looping
   * sounds, `.release(fade)` to stop) or null if unknown / dropped.
   * opts: position (Vector3 | [x,y,z]), follow (object with .position, or a
   * Vector3), gain, when (ctx time) | delay (s), ref (panner refDistance),
   * rolloff (panner rolloffFactor), plus sound-specific options (pitch,
   * intensity, combo, size, …).
   */
  play(name, opts = {}) {
    const def = SOUNDS[name];
    if (!def) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = Math.max(now, Number.isFinite(opts.when) ? opts.when : now + (Number.isFinite(opts.delay) ? opts.delay : 0));

    if (def.minInterval > 0) {
      const last = this.lastPlayed.get(name);
      if (last !== undefined && Math.abs(t0 - last) < def.minInterval) return null;
    }

    const priority = opts.priority ?? def.priority;
    // Per-sound cap: steal the oldest instance of this sound.
    if (def.max > 0) {
      let n = 0;
      let oldest = null;
      for (const v of this.voices) {
        if (v.ended || v.released || v.name !== name || v.end <= now) continue;
        n++;
        if (!oldest || v.t0 < oldest.t0) oldest = v;
      }
      if (n >= def.max && oldest) this._steal(oldest);
    }
    // Global cap: steal the lowest-priority (then oldest) voice.
    if (this._active(now) >= this.maxVoices) {
      let victim = null;
      for (const v of this.voices) {
        if (v.ended || v.released || (!v.loop && v.end <= now)) continue;
        if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.t0 < victim.t0)) victim = v;
      }
      if (!victim || victim.priority > priority) {
        this.stats.dropped++;
        return null;
      }
      this._steal(victim);
    }

    const bus = this.mixer.buses[def.bus] ?? this.mixer.water;
    let dest = bus;
    let panner = null;
    let distLP = null;
    const followTarget = opts.follow ? (opts.follow.position ?? opts.follow) : null;
    const pos = followTarget ?? opts.position ?? null;
    if (def.positional && pos) {
      panner = ctx.createPanner();
      // HRTF only where localisation matters (sharks, impacts); far ambient
      // one-shots use the cheap equal-power model.
      panner.panningModel = this.hrtf && def.hrtf ? 'HRTF' : 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = Number.isFinite(opts.ref) ? opts.ref : def.ref;
      panner.maxDistance = 400;
      panner.rolloffFactor = Number.isFinite(opts.rolloff) ? opts.rolloff : def.rolloff;
      distLP = ctx.createBiquadFilter();
      distLP.type = 'lowpass';
      distLP.Q.value = 0.5;
      distLP.connect(panner);
      panner.connect(bus);
      dest = distLP;
    }

    const v = new Voice(ctx, name, dest, t0);
    v.priority = priority;
    v.reverbSend = this.mixer.reverbIn;
    v.level = clamp((def.gain ?? 1) * (Number.isFinite(opts.gain) ? opts.gain : 1), 0, 4);
    v.out.gain.value = v.level;
    if (panner) {
      v.nodes.push(distLP, panner);
      v.panner = panner;
      v.distLP = distLP;
      // e-folding distance of the distance low-pass: 18 m for ordinary sounds,
      // proportionally longer for sounds with a reference distance > 10 m.
      v.lpReach = 18 * Math.max(1, panner.refDistance / 10);
      v.follow = followTarget;
      this._position(v, pos, true);
    }
    try {
      def.fn(v, opts, this);
      const send = (def.send ?? 0) + (opts.send ?? 0);
      if (send > 0) v.send(send);
    } catch (err) {
      v.dispose();
      console.warn(`[audio] sound "${name}" failed`, err);
      return null;
    }
    if (!v.loop && v.end <= t0) {
      v.dispose();
      return null;
    }
    this.voices.push(v);
    this.lastPlayed.set(name, t0);
    this.stats.played++;
    return v;
  }

  /** Voices currently sounding (excludes finished ones awaiting cleanup). */
  activeCount() {
    return this._active(this.ctx.currentTime);
  }

  _active(now) {
    let n = 0;
    for (const v of this.voices) if (!v.ended && !v.released && (v.loop || v.end > now)) n++;
    return n;
  }

  _steal(v) {
    this.stats.stolen++;
    v.release(0.04);
  }

  // Panner position + distance/behind low-pass. Reads x/y/z or [0..2].
  _position(v, p, immediate) {
    const x = p.x ?? p[0];
    const y = p.y ?? p[1];
    const z = p.z ?? p[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const pn = v.panner;
    if (pn.positionX) {
      pn.positionX.value = x;
      pn.positionY.value = y;
      pn.positionZ.value = z;
    } else {
      pn.setPosition(x, y, z);
    }
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dz = z - this.lz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
    const facing = (dx * this.fx + dy * this.fy + dz * this.fz) / d; // 1 ahead, -1 behind
    const behind = clamp(-facing, 0, 1);
    const cutoff = clamp(16000 * Math.exp(-d / (v.lpReach || 18)), 220, 16000) * (1 - 0.55 * behind);
    if (immediate) v.distLP.frequency.value = cutoff;
    else v.distLP.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.05);
  }

  /** Per-frame: follow targets, dispose finished voices. */
  update(now) {
    const list = this.voices;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.ended || (!v.loop && v.end + 0.05 < now)) {
        v.dispose();
        this.stats.disposed++;
        continue;
      }
      if (v.follow && v.panner) this._position(v, v.follow, false);
      list[w++] = v;
    }
    list.length = w;
  }

  stopAll(fade = 0.1) {
    for (const v of this.voices) v.release(fade);
  }

  disposeAll() {
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
  }
}
