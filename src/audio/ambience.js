// Ambience: the sea itself. Always on after unlock (level depends on state).
//   bed     stereo-decorrelated brown-noise rumble with slow swells, a faint
//           mid "wash" (water presence) and a deep beating pressure tone
//           (saturated so its harmonics carry on small speakers) that grows
//           with danger — the oppressive weight of the water
//   events  random far wreck creaks/groans, distant whale-like moans, deep
//           booms, bubble trickles around the listener and the player's own
//           breath-bubble exhales (rate rises with danger / exertion)
// Event positions are chosen relative to the listener; sounds go through the
// shared VoicePool so they obey the voice cap.
import { SmoothParam, rand, clamp, lerp, getBuffer, driveCurve } from './dsp.js';

export class Ambience {
  constructor(ctx, mixer, pool) {
    this.ctx = ctx;
    this.pool = pool;
    this.nodes = [];
    const now = ctx.currentTime;
    const gain = (v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      this.nodes.push(g);
      return g;
    };
    const filter = (type, f, q) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      this.nodes.push(b);
      return b;
    };
    const osc = (type, f) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.start(now);
      this.nodes.push(o);
      return o;
    };
    const loop = (key, rate) => {
      const s = ctx.createBufferSource();
      s.buffer = getBuffer(ctx, key);
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(now, Math.random() * (s.buffer.duration - 0.1));
      this.nodes.push(s);
      return s;
    };

    this.out = gain(0);
    this.out.connect(mixer.water);
    this.level = new SmoothParam(this.out.gain, 0, 0.004);

    // Rumble: two independent brown-noise loops → L/R.
    const merger = ctx.createChannelMerger(2);
    this.nodes.push(merger);
    loop('brown', 0.5).connect(merger, 0, 0);
    loop('brown', 0.53).connect(merger, 0, 1);
    const rlp = filter('lowpass', 115, 0.5);
    const rlp2 = filter('lowpass', 130, 0.7);
    const rumble = gain(0.085);
    merger.connect(rlp).connect(rlp2).connect(rumble).connect(this.out);
    // Swells: two slow incommensurate LFOs on the rumble level (depth < level,
    // so the gain never swings through zero).
    osc('sine', 0.047).connect(gain(0.045)).connect(rumble.gain);
    osc('sine', 0.083).connect(gain(0.025)).connect(rumble.gain);

    // Wash: the faint mid-band hiss of moving water.
    const wbp = filter('bandpass', 420, 0.55);
    const wash = gain(0.065);
    loop('pink', 1).connect(wbp).connect(wash).connect(this.out);
    osc('sine', 0.11).connect(gain(0.025)).connect(wash.gain);

    // Pressure: two beating low tones (2.5 Hz throb), louder as danger rises.
    // A bare 30-50 Hz sine is inaudible on laptop/phone speakers and only eats
    // headroom, so the pair is driven through an asymmetric (DC-biased) tanh
    // shaper: its 2nd/3rd harmonics (96-152 Hz) carry the weight, the beat
    // survives as a throb in the harmonics, and the high-pass strips the DC.
    const drive = gain(0.42); // (±2 + 0.35 bias) × 0.42 stays inside the curve's ±1 domain
    osc('sine', 48).connect(drive);
    osc('sine', 50.5).connect(drive);
    const bias = ctx.createConstantSource ? ctx.createConstantSource() : null;
    if (bias) {
      bias.offset.value = 0.35;
      bias.start(now);
      this.nodes.push(bias);
      bias.connect(drive);
    }
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(2);
    this.nodes.push(shaper);
    const subHP = filter('highpass', 55, 0.7); // also tilts the balance toward the harmonics
    const subLP = filter('lowpass', 210, 0.7);
    const sub = gain(0);
    drive.connect(shaper).connect(subHP).connect(subLP).connect(sub).connect(this.out);
    this.subLevel = new SmoothParam(sub.gain, 0, 0.003);

    // Random-event timers (seconds of real time until next).
    this.t = { creak: rand(4, 9), moan: rand(25, 50), boom: rand(18, 35), bubbles: rand(1.5, 4), exhale: rand(2, 4) };
  }

  /**
   * p: { level 0..1 target, danger 0..1, breathing bool, exertion 0..1,
   *      lx, ly, lz listener position, wreck: {x,y,z} | null }
   */
  update(now, dt, p) {
    this.level.set(clamp(p.level, 0, 1.5), now, 1.2);
    this.subLevel.set(0.015 + 0.07 * (p.danger ?? 0), now, 1.5);
    if (!(p.level > 0.05)) return;
    const t = this.t;
    t.creak -= dt;
    t.moan -= dt;
    t.boom -= dt;
    t.bubbles -= dt;
    t.exhale -= dt;
    const quiet = 1 - 0.6 * (p.danger ?? 0); // events thin out when the fight is on

    if (t.creak <= 0) {
      t.creak = rand(9, 22) / quiet;
      if (p.wreck) this.pool.play('creak', { position: [p.wreck.x + rand(-6, 6), p.wreck.y + rand(0, 4), p.wreck.z + rand(-6, 6)] });
      else this._far('creak', p, 30, 60, -38);
    }
    if (t.moan <= 0) {
      t.moan = rand(45, 100);
      this._far('whaleMoan', p, 70, 110, null);
    }
    if (t.boom <= 0) {
      t.boom = rand(25, 60) / quiet;
      this._far('deepBoom', p, 60, 100, -60);
    }
    if (t.bubbles <= 0) {
      t.bubbles = rand(2.5, 7);
      const a = rand(0, Math.PI * 2);
      const r = rand(3, 16);
      this.pool.play('bubbles', { position: [p.lx + Math.cos(a) * r, p.ly + rand(-4, 2), p.lz + Math.sin(a) * r], big: Math.random() < 0.2 });
    }
    if (p.breathing && t.exhale <= 0) {
      const drive = Math.max(p.danger ?? 0, p.exertion ?? 0);
      t.exhale = lerp(5.4, 2.4, drive) * rand(0.85, 1.15);
      this.pool.play('exhale', { intensity: 0.3 + 0.7 * drive });
    }
  }

  _far(name, p, rMin, rMax, y) {
    const a = rand(0, Math.PI * 2);
    const r = rand(rMin, rMax);
    this.pool.play(name, { position: [p.lx + Math.cos(a) * r, y ?? p.ly + rand(-15, 5), p.lz + Math.sin(a) * r] });
  }

  dispose() {
    for (const n of this.nodes) {
      try {
        n.stop?.();
      } catch {
        /* not a source */
      }
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.nodes.length = 0;
  }
}
