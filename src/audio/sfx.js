// Sound library: every sound the game can play, as a builder that schedules
// WebAudio nodes on a Voice (see dsp.js). Builders receive (voice, opts) and
// must schedule everything relative to `voice.t0`; they never touch the game,
// so they render identically on a live AudioContext or an OfflineAudioContext.
//
// Sound design rule of thumb: everything in the water lives between ~30 Hz
// and ~1.5 kHz (the water bus low-passes the rest away), so the character
// comes from thuds, pressure, bubbles and filtered-noise motion. Highs only
// matter for the dry 'ui' bus (menus + the phone call above water).
//
// Registry fields (defaults in `sound()` below):
//   bus        'water' | 'cue' (water whose low-pass stops at CUE_FLOOR, mixer.js)
//              | 'music' | 'ui' | 'body'
//   priority   0..10, higher survives voice stealing
//   max        max simultaneous instances (oldest stolen)
//   minInterval  seconds; retriggers closer than this are dropped
//   positional uses opts.position / opts.follow when given
//   ref, rolloff  PannerNode distance model parameters
//   send       extra reverb send (on top of the bus send)
//   hrtf       false = always equal-power panning (cheap; far ambience)
//   loop       sustained sound: returns voice.ctl.set(value, time), stop with voice.release()
//   internal   music-engine instrument, not part of the public play() list
import { SmoothParam, mtof, clamp, rand, variantKey, getPulseWave } from './dsp.js';

export const SOUNDS = Object.create(null);

function sound(name, spec, fn) {
  SOUNDS[name] = {
    bus: 'water',
    priority: 5,
    max: 4,
    minInterval: 0,
    positional: true,
    ref: 5,
    rolloff: 1,
    send: 0,
    gain: 1,
    loop: false,
    internal: false,
    hrtf: true,
    ...spec,
    fn,
  };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Pitched body thump: sine (or other) with an exponential pitch drop. */
function thud(v, t, f0, f1, dur, peak, { type = 'sine', drop = 0.35, a = 0.003, dest = v.out } = {}) {
  const o = v.osc(type, f0, t, t + a + dur + 0.05);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + a + dur * drop);
  const g = v.gain();
  v.perc(g.gain, t, a, dur, peak);
  o.connect(g).connect(dest);
  return o;
}

/** Filtered noise burst with optional filter sweep. */
function noiseShot(v, t, { kind = 'white', type = 'bandpass', f0 = 1000, f1 = f0, q = 1, a = 0.002, dur = 0.1, peak = 0.5, rate = 1, sweep = 1, dest = v.out } = {}) {
  const src = v.noise(kind, t, t + a + dur + 0.04, rate);
  const f = v.filter(type, f0, q);
  if (f1 !== f0) {
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + a + dur * sweep);
  }
  const g = v.gain();
  v.perc(g.gain, t, a, dur, peak);
  src.connect(f).connect(g).connect(dest);
  return { src, f, g };
}

/** Moving-water whoosh: noise through a filter sweeping up to an apex and back. */
function whoosh(v, t, { dur = 0.3, f0 = 300, f1 = 1500, f2 = 400, q = 1, peak = 0.5, kind = 'pink', apex = 0.4, type = 'bandpass', rate = 1, dest = v.out } = {}) {
  const src = v.noise(kind, t, t + dur + 0.05, rate);
  const f = v.filter(type, f0, q);
  f.frequency.setValueAtTime(f0, t);
  f.frequency.exponentialRampToValueAtTime(f1, t + dur * apex);
  f.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = v.gain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + dur * apex);
  g.gain.exponentialRampToValueAtTime(peak * 1e-3, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
  src.connect(f).connect(g).connect(dest);
  return { src, f, g };
}

/** Pre-synthesised bubble texture ('trickle' | 'burst' | 'exhale' | 'glug'). */
function bubbles(v, t, family, { peak = 0.4, rate = 1, dest = v.out } = {}) {
  const { src } = v.sample(variantKey(family), t, rate);
  const g = v.gain(peak);
  src.connect(g).connect(dest);
  return src;
}

/** Bone / cartilage crunch sample. */
function crunch(v, t, { peak = 0.4, rate = 1, lp = 2400, dest = v.out } = {}) {
  const { src } = v.sample(variantKey('crunch'), t, rate);
  const f = v.filter('lowpass', lp, 0.7);
  const g = v.gain(peak);
  src.connect(f).connect(g).connect(dest);
}

/** LFO: oscillator → depth gain → target AudioParam. */
function lfo(v, t, stop, freq, depth, param, type = 'sine') {
  const o = v.osc(type, freq, t, stop);
  const g = v.gain(depth);
  o.connect(g).connect(param);
  return o;
}

/** Inharmonic struck-metal partials, each a slightly detuned pair (beating). */
function partials(v, t, { f0, ratios, decays, gains, beat = 1.5, dest = v.out }) {
  for (let i = 0; i < ratios.length; i++) {
    const f = f0 * ratios[i];
    for (const s of [-0.5, 0.5]) {
      const o = v.osc('sine', f + s * beat * (1 + i * 0.6), t, t + decays[i] + 0.05);
      const g = v.gain();
      v.perc(g.gain, t, 0.0015, decays[i], gains[i] * 0.5);
      o.connect(g).connect(dest);
    }
  }
}

/** Muffled vocal grunt: glottal saw + breath noise through two formants. */
function grunt(v, t, { f0 = 115, f1 = 86, dur = 0.3, peak = 0.3, formants = [[560, 5], [1000, 7]], dest = v.out } = {}) {
  const end = t + dur + 0.12;
  const o = v.osc('sawtooth', f0, t, end);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.linearRampToValueAtTime(f1, t + dur);
  lfo(v, t, end, 23, 3, o.frequency, 'triangle'); // rough, strained
  const n = v.noise('pink', t, end);
  const ng = v.gain(0.4);
  const mix = v.gain(1);
  o.connect(mix);
  n.connect(ng).connect(mix);
  const env = v.gain();
  v.adsr(env.gain, t, 0.015, 0.06, 0.65, dur * 0.5, dur * 0.4, peak);
  for (const [f, q] of formants) {
    const bp = v.filter('bandpass', f, q);
    mix.connect(bp).connect(env);
  }
  env.connect(dest);
}

/** FM moan with a glide path [[time, freq], …] — whales. */
function fmMoan(v, t, { path, ratio = 0.5, index = [0, 60, 20], dur, peak, a = 0.8, r = 1.6, dest = v.out }) {
  const end = t + Math.max(dur, a + 0.3 + r) + 0.1;
  const car = v.osc('sine', path[0][1], t, end);
  const mod = v.osc('sine', path[0][1] * ratio, t, end);
  car.frequency.setValueAtTime(path[0][1], t);
  mod.frequency.setValueAtTime(path[0][1] * ratio, t);
  for (let i = 1; i < path.length; i++) {
    car.frequency.exponentialRampToValueAtTime(path[i][1], t + path[i][0]);
    mod.frequency.exponentialRampToValueAtTime(path[i][1] * ratio, t + path[i][0]);
  }
  const mg = v.gain(index[0]);
  mg.gain.setValueAtTime(index[0], t);
  mg.gain.linearRampToValueAtTime(index[1], t + dur * 0.4);
  mg.gain.linearRampToValueAtTime(index[2], t + dur);
  mod.connect(mg).connect(car.frequency);
  lfo(v, t, end, 4.1, path[0][1] * 0.012, car.frequency);
  const env = v.gain();
  v.adsr(env.gain, t, a, 0.3, 0.85, Math.max(0, dur - a - 0.3 - r), r, peak);
  car.connect(env).connect(dest);
}

// ---------------------------------------------------------------------------
// Instruments (shared by the score in music.js and the musical stingers)
// ---------------------------------------------------------------------------

/** Low cello-like pluck / staccato bow for the ostinato. */
function instPluck(v, t, { midi = 38, vel = 0.6, bright = 0.4, len } = {}) {
  const f = mtof(midi);
  const dur = len ?? 0.3 + 0.28 * (1 - bright);
  const end = t + dur + 0.08;
  const mix = v.gain(1);
  v.osc('sawtooth', f, t, end, -6).connect(mix);
  v.osc('sawtooth', f, t, end, 7).connect(mix);
  const sub = v.osc('sine', f / 2, t, end);
  const sg = v.gain(0.2); // sub-octave weight; the body (≥ 100 Hz) carries the line
  sub.connect(sg).connect(mix);
  const lp = v.filter('lowpass', 300, 4 + bright * 5);
  const c0 = 240 + 2400 * bright * (0.5 + 0.5 * vel);
  lp.frequency.setValueAtTime(c0, t);
  lp.frequency.exponentialRampToValueAtTime(100 + 80 * bright, t + dur * 0.75);
  const body = v.filter('peaking', 230, 1.2, 4);
  const g = v.gain();
  v.perc(g.gain, t, 0.005, dur, 0.16 * vel);
  mix.connect(lp).connect(body).connect(g).connect(v.out);
  noiseShot(v, t, { kind: 'pink', type: 'bandpass', f0: 1700, q: 1.5, a: 0.001, dur: 0.03, peak: 0.05 * vel * (0.4 + bright) });
}

/** Taiko / war drum: membrane modes + skin slap + air thump. */
function instTaiko(v, t, { vel = 0.8, size = 1 } = {}) {
  thud(v, t, 104 / size, Math.max(42, 46 / size), 0.8 * size, 0.32 * vel, { drop: 0.22, a: 0.002 });
  thud(v, t, 168 / size, 118 / size, 0.3 * size, 0.27 * vel, { drop: 0.3 });
  noiseShot(v, t, { kind: 'white', type: 'bandpass', f0: 900, f1: 480, q: 0.9, a: 0.001, dur: 0.07, peak: 0.26 * vel });
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 230, q: 0.7, a: 0.002, dur: 0.5 * size, peak: 0.26 * vel });
}

/** Low brass-like chord: detuned saws, filter opens with the swell, slight growl. */
function instBrass(v, t, { midis, dur = 3, vel = 0.8, a = null, r = null } = {}) {
  const att = a ?? dur * 0.45;
  const rel = r ?? dur * 0.4;
  const hold = Math.max(0, dur - att - rel - 0.1);
  const end = t + dur + 0.2;
  const lp = v.filter('lowpass', 150, 1.4);
  lp.frequency.setValueAtTime(140, t);
  lp.frequency.exponentialRampToValueAtTime(280 + 1500 * vel, t + att);
  lp.frequency.exponentialRampToValueAtTime(150, t + att + 0.1 + hold + rel);
  const growl = v.shaper(1.8);
  const env = v.gain();
  v.adsr(env.gain, t, att, 0.1, 0.9, hold, rel, 0.15 * vel);
  for (const m of midis) {
    const f = mtof(m);
    for (const d of [-9, 0, 8]) v.osc('sawtooth', f, t, end, d + rand(-2, 2)).connect(lp);
  }
  lp.connect(growl).connect(env).connect(v.out);
}

/** Dissonant string cluster: crescendo with accelerating tremolo, cut at the hit. */
function instCluster(v, t, { root = 50, dur = 1, vel = 0.7 } = {}) {
  const end = t + dur + 0.4;
  const lp = v.filter('lowpass', 300, 0.9);
  lp.frequency.setValueAtTime(300, t);
  lp.frequency.exponentialRampToValueAtTime(2600, t + dur);
  const trem = v.gain(0.55);
  const tl = lfo(v, t, end, 4, 0.45, trem.gain);
  tl.frequency.setValueAtTime(4, t);
  tl.frequency.exponentialRampToValueAtTime(15, t + dur);
  const env = v.gain();
  v.swell(env.gain, t, dur, 0.07 * vel, 0.3);
  for (const iv of [0, 1, 5, 6, 11, 13]) {
    const f = mtof(root + iv);
    v.osc('sawtooth', f, t, end, rand(-12, 12)).connect(lp);
    v.osc('triangle', f, t, end, rand(-8, 8)).connect(lp);
  }
  lp.connect(trem).connect(env).connect(v.out);
}

/** Solo cello-ish bowed note with delayed vibrato. */
function instCello(v, t, { midi = 50, dur = 1, vel = 0.7 } = {}) {
  const f = mtof(midi);
  const end = t + dur + 0.8;
  const vib = v.gain(0);
  vib.gain.setValueAtTime(0, t);
  vib.gain.linearRampToValueAtTime(f * 0.006, t + Math.min(0.5, dur));
  const vo = v.osc('sine', 5.2, t, end);
  vo.connect(vib);
  const lp = v.filter('lowpass', 1300, 0.9);
  const body = v.filter('peaking', 300, 1, 3);
  for (const d of [-5, 5]) {
    const o = v.osc('sawtooth', f, t, end, d);
    vib.connect(o.frequency);
    o.connect(lp);
  }
  const bow = v.noise('pink', t, end);
  const bbp = v.filter('bandpass', Math.min(4000, f * 5), 2);
  const bg = v.gain(0.12);
  bow.connect(bbp).connect(bg).connect(lp);
  const env = v.gain();
  v.adsr(env.gain, t, 0.14, 0.2, 0.8, Math.max(0, dur - 0.34), 0.6, 0.09 * vel);
  lp.connect(body).connect(env).connect(v.out);
}

/** Inharmonic bell (hum, prime, tierce, quint, nominal…). */
function instBell(v, t, { midi = 74, vel = 0.5, dur = 3.5 } = {}) {
  const f = mtof(midi);
  const k = dur / 3.5;
  partials(v, t, {
    f0: f,
    ratios: [0.5, 1, 1.19, 1.5, 2, 2.51, 3.01],
    decays: [3.5 * k, 2.6 * k, 2 * k, 1.6 * k, 1.3 * k, 0.9 * k, 0.6 * k],
    gains: [0.4, 0.6, 0.35, 0.25, 0.3, 0.14, 0.1].map((g) => g * 0.12 * vel),
    beat: 0.8,
  });
}

/** Soft string pad chord. */
function instPad(v, t, { midis, dur = 4, vel = 0.5, a = 1, r = 2, bright = 0.5 } = {}) {
  const end = t + Math.max(dur, a + 0.3 + r) + 0.1;
  const lp = v.filter('lowpass', 500 + 1500 * bright, 0.7);
  const env = v.gain();
  v.adsr(env.gain, t, a, 0.3, 0.85, Math.max(0, dur - a - 0.3 - r), r, 0.06 * vel);
  for (const m of midis) {
    const f = mtof(m);
    v.osc('triangle', f, t, end, rand(-4, 4)).connect(lp);
    const s = v.osc('sawtooth', f, t, end, rand(4, 9));
    const sg = v.gain(0.45);
    s.connect(sg).connect(lp);
  }
  lp.connect(env).connect(v.out);
}

/**
 * Lub-dub. `bpm` tightens the lub→dub gap as the heart races. The 40-66 Hz
 * thud is the weight; a short chest-wall knock (~120-150 Hz) and the
 * band-passed flutter carry the beat on small speakers.
 */
function instHeart(v, t, { vel = 0.6, bpm = 70 } = {}) {
  const gap = clamp(0.3 * Math.sqrt(60 / bpm), 0.17, 0.32);
  const beat = (tt, amp, f0, f1) => {
    thud(v, tt, f0, f1, 0.17, 0.42 * amp, { drop: 0.6, a: 0.006 });
    thud(v, tt, f0 * 2.5, f0 * 1.9, 0.07, 0.45 * amp, { drop: 0.5, a: 0.004 });
    noiseShot(v, tt, { kind: 'brown', type: 'bandpass', f0: 125, q: 1.1, a: 0.008, dur: 0.13, peak: 0.85 * amp });
  };
  beat(t, vel, 58, 39);
  beat(t + gap, vel * 0.72, 66, 45);
}

// ---------------------------------------------------------------------------
// Music-engine instruments (internal)
// ---------------------------------------------------------------------------

const M = { bus: 'music', positional: false, internal: true, max: 0, priority: 5 };
sound('m_pluck', { ...M, max: 6 }, (v, o) => instPluck(v, v.t0, o));
sound('m_taiko', { ...M, max: 6, send: 0.35 }, (v, o) => instTaiko(v, v.t0, o));
sound('m_brass', { ...M, max: 3, send: 0.25 }, (v, o) => instBrass(v, v.t0, o));
sound('m_cluster', { ...M, max: 2 }, (v, o) => instCluster(v, v.t0, o));
sound('m_cello', { ...M, max: 4, send: 0.2 }, (v, o) => instCello(v, v.t0, o));
sound('m_bell', { ...M, max: 3, send: 0.4 }, (v, o) => instBell(v, v.t0, o));
sound('m_pad', { ...M, max: 3 }, (v, o) => instPad(v, v.t0, o));

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

// Light knife slash: water-muffled noise sweep + displacement whomp. Combo 3 is heavier.
sound('slash', { priority: 6, max: 3, minInterval: 0.03, positional: false }, (v, o) => {
  const t = v.t0;
  const combo = clamp(o.combo ?? 1, 1, 4);
  const P = (o.pitch ?? 1) * (1 + (combo - 1) * 0.07) * rand(0.94, 1.06);
  const big = combo >= 3;
  const dur = (big ? 0.27 : 0.21) * rand(0.92, 1.08);
  whoosh(v, t, { dur, f0: 320 * P, f1: 1500 * P, f2: 420 * P, q: 1.3, peak: big ? 0.85 : 0.72, apex: 0.35 });
  whoosh(v, t + 0.01, { dur: dur * 0.95, f0: 110 * P, f1: 380 * P, f2: 100 * P, q: 0.8, kind: 'brown', type: 'lowpass', peak: big ? 0.32 : 0.22, apex: 0.4 });
  noiseShot(v, t + dur * 0.25, { kind: 'white', f0: 2600 * P, f1: 4200 * P, q: 3, a: 0.02, dur: 0.09, peak: 0.07 });
});

// Heavy thrust release: longer, deeper push of water. (The low whoosh + thud are
// the loudest transient of a calm fight: trimmed so it stays under the limiter.)
sound('slashHeavy', { priority: 7, max: 2, minInterval: 0.05, positional: false }, (v, o) => {
  const t = v.t0;
  const P = (o.pitch ?? 1) * rand(0.95, 1.04);
  whoosh(v, t, { dur: 0.42, f0: 200 * P, f1: 1100 * P, f2: 260 * P, q: 1.1, peak: 0.5, apex: 0.3 });
  whoosh(v, t, { dur: 0.48, f0: 80, f1: 320, f2: 70, q: 0.7, kind: 'brown', type: 'lowpass', peak: 0.49, apex: 0.3 });
  thud(v, t + 0.03, 95, 42, 0.3, 0.31);
  noiseShot(v, t + 0.08, { kind: 'white', f0: 2200, f1: 3600, q: 4, a: 0.03, dur: 0.12, peak: 0.06 });
});

// Charging thrust: rising whine + tremble + pressure. Loop; ctl.set(level 0..1).
sound('heavyCharge', { priority: 7, max: 1, positional: false, loop: true }, (v) => {
  const t = v.t0;
  const o1 = v.osc('triangle', 170, t, null);
  const o2 = v.osc('sawtooth', 171.5, t, null, 14);
  const lp = v.filter('lowpass', 700, 2.2);
  const g = v.gain(0);
  const o2g = v.gain(0.3);
  o1.connect(lp);
  o2.connect(o2g).connect(lp);
  lp.connect(g).connect(v.out);
  const n = v.noise('pink', t, null);
  const bp = v.filter('bandpass', 420, 3);
  const am = v.gain(0.6);
  const trem = lfo(v, t, null, 8, 0.4, am.gain);
  const ng = v.gain(0);
  n.connect(bp).connect(am).connect(ng).connect(v.out);
  const sub = v.osc('sine', 46, t, null);
  const sg = v.gain(0);
  sub.connect(sg).connect(v.out);
  const P = {
    f1: new SmoothParam(o1.frequency, 170, 0.01),
    f2: new SmoothParam(o2.frequency, 171.5, 0.01),
    lp: new SmoothParam(lp.frequency, 700, 0.01),
    bp: new SmoothParam(bp.frequency, 420, 0.01),
    g: new SmoothParam(g.gain, 0, 0.003),
    ng: new SmoothParam(ng.gain, 0, 0.003),
    sg: new SmoothParam(sg.gain, 0, 0.003),
    tr: new SmoothParam(trem.frequency, 8, 0.02),
  };
  v.ctl = {
    set(level, time) {
      const k = clamp(level, 0, 1);
      P.f1.set(170 * (1 + 2.3 * k), time, 0.08);
      P.f2.set(171.5 * (1 + 2.3 * k), time, 0.08);
      P.lp.set(600 + 2600 * k, time, 0.08);
      P.bp.set(380 + 1300 * k, time, 0.08);
      P.g.set(0.05 + 0.11 * k, time, 0.08);
      P.ng.set(0.08 + 0.13 * k, time, 0.08);
      P.sg.set(0.05 + 0.08 * k, time, 0.1);
      P.tr.set(8 + 12 * k, time, 0.1);
    },
  };
  v.ctl.set(0, t);
});

// Glint when the heavy charge is full (level 3).
sound('chargeReady', { priority: 6, max: 1, positional: false, send: 0.3, minInterval: 0.2 }, (v) => {
  const t = v.t0;
  partials(v, t, { f0: 1180, ratios: [1, 2.76, 5.4], decays: [0.45, 0.25, 0.12], gains: [0.15, 0.08, 0.03] });
  noiseShot(v, t, { kind: 'white', f0: 3200, q: 2, a: 0.002, dur: 0.08, peak: 0.05 });
});

// Soft tick as the heavy charge passes level 1 / 2 ({tier}): the same metal,
// lower and quieter, so the three steps climb toward the full glint.
sound('chargeTier', { priority: 5, max: 1, positional: false, send: 0.2, minInterval: 0.15 }, (v, o) => {
  const t = v.t0;
  const tier = clamp(Math.round(o.tier ?? 1), 1, 2);
  const f0 = tier === 1 ? 700 : 885;
  partials(v, t, { f0, ratios: [1, 2.76], decays: [0.2, 0.1], gains: [0.05 + 0.025 * tier, 0.025] });
});

sound('dodge', { priority: 6, max: 2, minInterval: 0.05, positional: false }, (v) => {
  const t = v.t0;
  whoosh(v, t, { dur: 0.38, f0: 180, f1: 760, f2: 220, q: 0.8, peak: 0.45, apex: 0.32 });
  whoosh(v, t, { dur: 0.42, f0: 100, f1: 380, f2: 90, q: 0.7, kind: 'brown', type: 'lowpass', peak: 0.35, apex: 0.3 });
  bubbles(v, t + 0.04, 'burst', { peak: 0.32, rate: rand(1.15, 1.35) });
});

// Time-slows "whoom" after a perfect dodge.
sound('perfectDodge', { priority: 8, max: 1, positional: false, send: 0.5, minInterval: 0.2 }, (v) => {
  const t = v.t0;
  const n = v.noise('pink', t, t + 0.45);
  const bp = v.filter('bandpass', 420, 1.4);
  bp.frequency.setValueAtTime(420, t);
  bp.frequency.exponentialRampToValueAtTime(1300, t + 0.32);
  const g = v.gain();
  v.swell(g.gain, t, 0.32, 0.3, 0.05);
  n.connect(bp).connect(g).connect(v.out);
  thud(v, t + 0.3, 95, 30, 1.1, 0.42, { drop: 0.9, a: 0.02 });
  for (const f of [660, 663.5, 990]) {
    const o = v.osc('sine', f, t + 0.3, t + 2);
    const og = v.gain();
    v.adsr(og.gain, t + 0.3, 0.03, 0.1, 0.7, 0.25, 1.1, 0.045);
    o.connect(og).connect(v.out);
  }
  bubbles(v, t + 0.3, 'burst', { peak: 0.32, rate: 0.62 });
});

// Parry press (player:parry {attempt}): the knife snapping up into the block — a
// short bright swish rising through the water.
sound('parryRaise', { priority: 4, max: 1, minInterval: 0.1, positional: false }, (v) => {
  whoosh(v, v.t0, { dur: 0.15, f0: 500, f1: 1700, f2: 700, q: 1.4, peak: 0.42, apex: 0.4 });
});

// Parry window closed on nothing (player:parry {whiff}): the braced block falls
// through the water — the knife drags down and away (the mirror of parryRaise's
// rising swish: dull, falling), the arm's weight goes with it, and 老公 lets out a
// short low breath (a few bubbles trail off). opts.fatigue = Player's spam fatigue
// after this miss (1 = a lone miss … 3 = mashing): repeated misses drag lower and
// heavier and the breath turns into a strained, voiced grunt. Levels: a lone miss
// sits a few dB under the strike cue (it must not mask the next "parry now"), a
// mashing one about level with it.
sound('parryMiss', { priority: 5, max: 1, minInterval: 0.1, positional: false }, (v, o) => {
  const t = v.t0;
  const k = clamp(((o.fatigue ?? 1) - 1) / 2, 0, 1);
  const D = (1 - 0.3 * k) * rand(0.96, 1.04); // duller as the misses pile up
  const L = 1 + 0.6 * k; // louder (+4 dB at full fatigue; ≈ +3 dB heard, the duller half carries less)
  // the drag: a broad band of water noise falling away
  whoosh(v, t, { dur: 0.26, f0: 700 * D, f1: 520 * D, f2: 170 * D, q: 0.8, peak: 0.62 * L, apex: 0.16 });
  // the arm's weight going with it (kept light: a thump here reads as a hit)
  whoosh(v, t + 0.01, { dur: 0.28, f0: 240 * D, f1: 190 * D, f2: 70, q: 0.7, kind: 'brown', type: 'lowpass', peak: 0.08 * L, apex: 0.2 });
  thud(v, t + 0.04, 92 * D, 52, 0.18, 0.06 * L, { drop: 0.6, a: 0.02 });
  // the breath: unvoiced "hff" (pink noise through two low formants), voiced as he tires
  const bt = t + 0.07;
  const bd = 0.22 + 0.08 * k;
  const end = bt + bd + 0.1;
  const env = v.gain();
  v.adsr(env.gain, bt, 0.025, 0.05, 0.7, bd * 0.4, bd * 0.5, 0.85 * L);
  const n = v.noise('pink', bt, end);
  const ng = v.gain(1 - 0.3 * k);
  const mix = v.gain(1);
  n.connect(ng).connect(mix);
  if (k > 0.05) {
    const f0 = rand(98, 106);
    const o2 = v.osc('sawtooth', f0, bt, end);
    o2.frequency.setValueAtTime(f0, bt);
    o2.frequency.linearRampToValueAtTime(80, bt + bd);
    const og = v.gain(0.3 * k);
    o2.connect(og).connect(mix);
  }
  for (const [f, q] of [[420 * D, 4], [760 * D, 5]]) mix.connect(v.filter('bandpass', f, q)).connect(env);
  env.connect(v.out);
  bubbles(v, t + 0.1, 'exhale', { peak: 0.07 + 0.06 * k, rate: rand(1.25, 1.45) });
});

// Knife on tooth/jaw: inharmonic clang, muffled, big reverb.
sound('parry', { priority: 9, max: 2, minInterval: 0.08, ref: 6, send: 0.55 }, (v) => {
  const t = v.t0;
  const f0 = 410 * rand(0.97, 1.03);
  partials(v, t, {
    f0,
    ratios: [1, 2.76, 5.4, 8.93],
    decays: [1.4, 0.9, 0.5, 0.3],
    gains: [0.34, 0.24, 0.13, 0.06],
    beat: 1.6,
  });
  noiseShot(v, t, { kind: 'white', type: 'highpass', f0: 1500, q: 0.7, a: 0.0008, dur: 0.035, peak: 0.3 });
  thud(v, t, 210, 120, 0.12, 0.28);
  thud(v, t, 80, 45, 0.25, 0.35);
});

sound('playerHurt', { priority: 9, max: 2, minInterval: 0.08, positional: false, gain: 0.8 }, (v, o) => {
  const t = v.t0;
  const H = o.heavy ? 1.25 : 1;
  thud(v, t, 82, 36, 0.32 * H, 0.6 * H);
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 500, f1: 180, q: 0.8, a: 0.002, dur: 0.18 * H, peak: 0.38 * H });
  grunt(v, t + 0.015, { f0: rand(106, 122), f1: 84, dur: 0.3 * H, peak: 0.5 });
  bubbles(v, t + 0.03, 'burst', { peak: 0.3, rate: rand(0.85, 1) });
});

// ---------------------------------------------------------------------------
// Combat impacts
// ---------------------------------------------------------------------------

sound('fleshHit', { priority: 7, max: 4, minInterval: 0.025, ref: 6, send: 0.1, gain: 0.72 }, (v, o) => {
  const t = v.t0;
  const I = clamp(o.intensity ?? 1, 0.4, 1.6);
  thud(v, t, 118, 46, 0.22 * I, 0.42 * Math.min(I, 1.25));
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 900, f1: 260, q: 0.9, a: 0.002, dur: 0.16 * I, peak: 0.36 });
  noiseShot(v, t, { kind: 'pink', f0: 1100, f1: 360, q: 4, a: 0.002, dur: 0.11, peak: 0.34 });
  crunch(v, t + 0.006, { peak: 0.3 * I, rate: rand(0.9, 1.2) });
  if (I > 1.2) {
    thud(v, t, 70, 32, 0.4, 0.3);
    bubbles(v, t + 0.02, 'burst', { peak: 0.16, rate: 1.1 });
  }
});

// Eye / gill stab: sharper squelch + scrape + pop.
sound('critHit', { priority: 8, max: 3, minInterval: 0.03, ref: 6, send: 0.25 }, (v) => {
  const t = v.t0;
  thud(v, t, 150, 55, 0.2, 0.5);
  thud(v, t, 82, 38, 0.32, 0.36);
  noiseShot(v, t, { kind: 'pink', f0: 1900, f1: 380, q: 6, a: 0.002, dur: 0.16, peak: 0.85 });
  noiseShot(v, t + 0.05, { kind: 'pink', f0: 1300, f1: 500, q: 5, a: 0.002, dur: 0.12, peak: 0.5 });
  const sc = noiseShot(v, t + 0.01, { kind: 'white', f0: 2500, q: 9, a: 0.01, dur: 0.22, peak: 0.3 });
  lfo(v, t, t + 0.3, 37, 350, sc.f.frequency, 'triangle');
  thud(v, t, 640, 180, 0.06, 0.2, { drop: 0.8, a: 0.001 });
  crunch(v, t + 0.01, { peak: 0.36, rate: rand(0.95, 1.15) });
});

sound('bite', { priority: 9, max: 2, minInterval: 0.2, ref: 7, send: 0.25, gain: 0.85 }, (v) => {
  const t = v.t0;
  noiseShot(v, t, { kind: 'white', f0: 1500, q: 1.6, a: 0.0005, dur: 0.03, peak: 0.5 });
  noiseShot(v, t, { kind: 'white', f0: 700, q: 1.2, a: 0.0005, dur: 0.05, peak: 0.42 });
  thud(v, t, 92, 40, 0.28, 0.55);
  crunch(v, t + 0.012, { peak: 0.5, rate: rand(0.85, 1.05) });
  crunch(v, t + 0.07, { peak: 0.34, rate: 0.8 });
  noiseShot(v, t + 0.02, { kind: 'pink', f0: 750, f1: 280, q: 2.5, a: 0.01, dur: 0.3, peak: 0.3 });
  bubbles(v, t + 0.02, 'burst', { peak: 0.14, rate: 1.2 });
});

// Jaws snapping shut on nothing (perfect dodge — the bite whiffed).
sound('jawSnap', { priority: 7, max: 2, minInterval: 0.15, ref: 7, send: 0.2 }, (v) => {
  const t = v.t0;
  noiseShot(v, t, { kind: 'white', f0: 1400, q: 1.6, a: 0.0005, dur: 0.035, peak: 0.45 });
  noiseShot(v, t, { kind: 'white', f0: 650, q: 1.2, a: 0.0005, dur: 0.05, peak: 0.36 });
  thud(v, t, 110, 60, 0.16, 0.36);
  noiseShot(v, t + 0.01, { kind: 'brown', type: 'lowpass', f0: 600, f1: 250, q: 0.8, a: 0.02, dur: 0.3, peak: 0.28 });
});

// Strike cue (enemy:strike: the jaws / snout arrive in `eta` s — every species,
// megalodon included, is cued from SharkAI's strike forecast: Combat cues at
// eta ≤ its STRIKE_ETA and the volume can't go live sooner than SharkAI's
// STRIKE_LEAD after the cue, so contact comes ≈0.2-0.4 s after it; the engine
// passes eta clamped to that range): the surge of water shoved ahead of the
// shark. A dull displacement 'whump' marks the onset — the moment to parry —
// then a rush rises in pitch and level straight into the contact and stops
// there, where the bite crunch, parry clang or dodge snap takes over. Not a jaw
// sound (that would read as a miss before the hit). opts.kind 'bite': a brighter
// hiss of water through the opening jaws; 'ram': lower and thuddier, a blunt
// bow wave. opts.size as for the other shark sounds (bigger = lower). On the
// 'cue' bus: the water's low-pass stops at CUE_FLOOR for it, so slow-mo, a hurt
// dip or a grab doesn't smother the "parry now" swell.
sound('strike', { bus: 'cue', priority: 8, max: 3, minInterval: 0.06, ref: 8, rolloff: 0.8, send: 0.15 }, (v, o) => {
  const t = v.t0;
  const ram = o.kind === 'ram';
  const s = clamp(o.size ?? 1, 0.6, 3);
  const eta = clamp(o.eta ?? 0.3, 0.12, 0.5);
  const k = 1 / Math.sqrt(s);
  // onset: a blunt pressure pulse
  thud(v, t, (ram ? 150 : 220) * k, (ram ? 72 : 120) * k, ram ? 0.16 : 0.1, ram ? 0.45 : 0.42, { drop: 0.5, a: 0.004 });
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: ram ? 480 : 820, f1: ram ? 190 : 320, q: 0.8, a: 0.004, dur: ram ? 0.12 : 0.08, peak: ram ? 0.38 : 0.4 });
  // the rush: audible at once (the onset must read), swelling into the contact
  const f0 = (ram ? 170 : 330) * k;
  const src = v.noise(ram ? 'brown' : 'pink', t, t + eta + 0.1);
  const bp = v.filter('bandpass', f0, ram ? 0.9 : 1);
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime((ram ? 620 : 1350) * k, t + eta);
  const g = v.gain();
  const peak = ram ? 1.1 : 1.3;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak * 0.3, t + 0.015);
  g.gain.exponentialRampToValueAtTime(peak, t + eta);
  g.gain.exponentialRampToValueAtTime(peak * 1e-3, t + eta + 0.06);
  g.gain.linearRampToValueAtTime(0, t + eta + 0.07);
  src.connect(bp).connect(g).connect(v.out);
});

// Shark committing to a lunge: big low rush of water (follows the shark).
sound('lunge', { priority: 6, max: 3, minInterval: 0.2, ref: 7, rolloff: 0.9 }, (v, o) => {
  const t = v.t0;
  const s = clamp(o.size ?? 1, 0.6, 3);
  const dur = 0.85 * s ** 0.3;
  whoosh(v, t, { dur, f0: 140, f1: 750, f2: 160, q: 0.9, kind: 'brown', type: 'lowpass', peak: 0.78, apex: 0.3 });
  whoosh(v, t, { dur, f0: 300, f1: 900, f2: 250, q: 0.9, peak: 0.26, apex: 0.35 });
  thud(v, t, Math.max(38, 50 / s ** 0.5), Math.max(30, 30 / s ** 0.5), dur, 0.28, { drop: 0.6, a: 0.05 }); // ≥ 30 Hz: below is only headroom
});

/**
 * Seconds the telegraph sting holds its peak after `duration` before it fades on
 * its own. The engine cuts it the moment the strike really comes (enemy state
 * 'attack'), and if the shark is still winding up when the plateau runs out it
 * hands over to 'telegraphHold' — so the swell never resolves before the lunge.
 */
export const TELE_PLATEAU = 0.12;

// Telegraph sting: rising pressure swell + growl + dissonant glissando, cut at the strike.
sound('telegraph', { priority: 8, max: 3, minInterval: 0.1, ref: 10, rolloff: 0.7, send: 0.35 }, (v, o) => {
  const t = v.t0;
  const d = clamp(o.duration ?? 0.8, 0.3, 2.5);
  const s = clamp(o.size ?? 1, 0.6, 3);
  const h = TELE_PLATEAU;
  const end = t + d + h + 0.2;
  const n = v.noise('pink', t, end);
  const bp = v.filter('bandpass', 220 / s, 1.6);
  bp.frequency.setValueAtTime(220 / s, t);
  bp.frequency.exponentialRampToValueAtTime(1300 / Math.sqrt(s), t + d);
  const g = v.gain();
  v.swell(g.gain, t, d, 0.75, 0.07, h);
  n.connect(bp).connect(g).connect(v.out);
  const gr = v.osc('sawtooth', 48 / s, t, end);
  gr.frequency.setValueAtTime(48 / s, t);
  gr.frequency.exponentialRampToValueAtTime(72 / s, t + d);
  const glp = v.filter('lowpass', 260, 1.5);
  const gam = v.gain(0.6);
  lfo(v, t, end, 17, 0.4, gam.gain);
  const gg = v.gain();
  v.swell(gg.gain, t, d, 0.48, 0.1, h);
  gr.connect(glp).connect(gam).connect(gg).connect(v.out);
  for (const [a, b] of [[290, 520], [307, 551]]) {
    const k = 1 / Math.sqrt(s);
    const o2 = v.osc('triangle', a * k, t, end);
    o2.frequency.setValueAtTime(a * k, t);
    o2.frequency.exponentialRampToValueAtTime(b * k, t + d);
    const og = v.gain();
    v.swell(og.gain, t, d, 0.1, 0.06, h);
    o2.connect(og).connect(v.out);
  }
});

// A wind-up held past its telegraphed duration (SharkAI keeps a finished wind-up
// for up to 1 s while another shark's hit lands; slow-mo or slow frames stretch
// it in real time): the sting's peak sustained as a trembling tail that keeps
// tightening (pitch and level creep up) until the strike comes or the wind-up is
// broken. Fades in over HOLD_FADE so it crossfades with the sting's plateau.
// Loop: the engine releases it (no ctl); follows the shark. opts.size as 'telegraph'.
const HOLD_FADE = 0.1;
sound('telegraphHold', { priority: 8, max: 3, ref: 10, rolloff: 0.7, send: 0.35, loop: true }, (v, o) => {
  const t = v.t0;
  const s = clamp(o.size ?? 1, 0.6, 3);
  const k = 1 / Math.sqrt(s);
  const creep = 1.6; // s to tighten by about a semitone
  const rise = (param, from, to) => {
    param.setValueAtTime(from, t);
    param.linearRampToValueAtTime(to, t + creep);
  };
  const fadeTo = (param, a, b) => {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(a, t + HOLD_FADE);
    param.linearRampToValueAtTime(b, t + creep);
  };
  // pressure hiss at the sting's top, trembling faster than the growl
  const n = v.noise('pink', t, null);
  const bp = v.filter('bandpass', 1300 * k, 1.6);
  rise(bp.frequency, 1300 * k, 1500 * k);
  const trem = v.gain(0.75);
  lfo(v, t, null, 11, 0.25, trem.gain);
  const g = v.gain(0);
  fadeTo(g.gain, 0.6, 0.7);
  n.connect(bp).connect(trem).connect(g).connect(v.out);
  // growl
  const gr = v.osc('sawtooth', 72 / s, t, null);
  rise(gr.frequency, 72 / s, 76 / s);
  const glp = v.filter('lowpass', 260, 1.5);
  const gam = v.gain(0.6);
  lfo(v, t, null, 17, 0.4, gam.gain);
  const gg = v.gain(0);
  fadeTo(gg.gain, 0.4, 0.46);
  gr.connect(glp).connect(gam).connect(gg).connect(v.out);
  // the dissonant pair, still bending upward
  for (const f of [520, 551]) {
    const o2 = v.osc('triangle', f * k, t, null);
    rise(o2.frequency, f * k, f * k * 1.06);
    const og = v.gain(0);
    fadeTo(og.gain, 0.085, 0.1);
    o2.connect(og).connect(v.out);
  }
});

sound('ram', { priority: 9, max: 2, minInterval: 0.15, ref: 8, send: 0.4, gain: 0.8 }, (v) => {
  const t = v.t0;
  thud(v, t, 62, 26, 0.7, 0.55, { drop: 0.5 });
  thud(v, t, 130, 70, 0.2, 0.35);
  noiseShot(v, t, { kind: 'white', f0: 800, q: 0.8, a: 0.001, dur: 0.06, peak: 0.42 });
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 400, f1: 120, q: 0.8, a: 0.003, dur: 0.6, peak: 0.45 });
  bubbles(v, t + 0.02, 'burst', { peak: 0.24, rate: 0.95 });
});

sound('tail', { priority: 7, max: 2, minInterval: 0.15, ref: 8 }, (v) => {
  const t = v.t0;
  const fl = v.gain(0.65); // tail-beat flutter
  fl.connect(v.out);
  lfo(v, t, t + 0.7, 11, 0.35, fl.gain, 'triangle');
  whoosh(v, t, { dur: 0.6, f0: 110, f1: 520, f2: 140, q: 0.7, peak: 0.55, apex: 0.45, dest: fl });
  whoosh(v, t, { dur: 0.65, f0: 120, f1: 400, f2: 100, q: 0.7, kind: 'brown', type: 'lowpass', peak: 0.4, apex: 0.5 });
});

sound('tailHit', { priority: 9, max: 2, minInterval: 0.15, ref: 8, send: 0.3 }, (v) => {
  const t = v.t0;
  noiseShot(v, t, { kind: 'white', f0: 1100, q: 0.9, a: 0.0008, dur: 0.05, peak: 0.48 });
  thud(v, t, 95, 42, 0.35, 0.6);
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 500, f1: 200, q: 0.8, a: 0.002, dur: 0.3, peak: 0.4 });
  bubbles(v, t + 0.02, 'burst', { peak: 0.18, rate: 1.1 });
});

sound('shockwave', { priority: 9, max: 2, minInterval: 0.3, ref: 14, rolloff: 0.6, send: 0.6, gain: 0.85 }, (v) => {
  const t = v.t0;
  const sh = v.shaper(2.5);
  const shg = v.gain(0.5);
  sh.connect(shg).connect(v.out);
  thud(v, t, 46, 21, 1.5, 0.8, { drop: 0.6, dest: sh });
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 220, f1: 60, q: 0.8, a: 0.02, dur: 2.2, peak: 0.4 });
  whoosh(v, t, { dur: 1.1, f0: 300, f1: 900, f2: 100, q: 0.8, peak: 0.24, apex: 0.15 });
  bubbles(v, t + 0.05, 'glug', { peak: 0.3, rate: 0.9 });
});

// Megalodon roar: distorted sub growl 30-90 Hz with vibrato, vocal fry,
// a mouth formant, a sub-bass hit and a huge reverb tail.
sound('roar', { priority: 10, max: 2, minInterval: 0.5, ref: 16, rolloff: 0.6, send: 0.9 }, (v, o) => {
  const t = v.t0;
  const s = clamp(o.size ?? 1, 0.6, 1.6);
  const dur = 3.8 * clamp(o.length ?? 1, 0.5, 1.6);
  const end = t + dur + 0.3;
  const f = 40 / s;
  const glide = (osc, k) => {
    osc.frequency.setValueAtTime(f * k * 0.72, t);
    osc.frequency.exponentialRampToValueAtTime(f * k * 1.2, t + 0.55);
    osc.frequency.exponentialRampToValueAtTime(f * k * 1.05, t + dur * 0.55);
    osc.frequency.exponentialRampToValueAtTime(f * k * 0.6, t + dur);
  };
  const core = v.osc('sawtooth', f, t, end);
  const core2 = v.osc('sawtooth', f * 1.5, t, end, -14);
  glide(core, 1);
  glide(core2, 1.5);
  for (const [osc, k] of [[core, 1], [core2, 1.5]]) {
    lfo(v, t, end, 6.3, f * k * 0.09, osc.frequency);
    lfo(v, t, end, 13.7, f * k * 0.05, osc.frequency, 'triangle');
  }
  const mix = v.gain(1);
  core.connect(mix);
  const c2g = v.gain(0.5);
  core2.connect(c2g).connect(mix);
  const drive = v.shaper(4.5);
  const lp = v.filter('lowpass', 300, 1.3);
  lp.frequency.setValueAtTime(300, t);
  lp.frequency.exponentialRampToValueAtTime(720, t + 0.6);
  lp.frequency.exponentialRampToValueAtTime(360, t + dur);
  const env = v.gain();
  v.adsr(env.gain, t, 0.45, 0.5, 0.8, dur - 1.95, 1.0, 0.5);
  mix.connect(drive).connect(lp).connect(env).connect(v.out);
  // vocal fry: band-passed noise chopped at ~31 Hz
  const n = v.noise('pink', t, end);
  const nbp = v.filter('bandpass', 240, 1.8);
  const chop = v.gain(0.5);
  lfo(v, t, end, 31, 0.5, chop.gain, 'square');
  const fry = v.gain();
  v.adsr(fry.gain, t, 0.3, 0.4, 0.75, dur - 1.7, 1.0, 0.55);
  n.connect(nbp).connect(chop).connect(fry).connect(v.out);
  // mouth formants
  const m = v.osc('sawtooth', 88 / s, t, end);
  m.frequency.setValueAtTime(88 / s, t);
  m.frequency.exponentialRampToValueAtTime(54 / s, t + dur);
  const fe = v.gain();
  v.adsr(fe.gain, t, 0.5, 0.3, 0.7, dur - 1.8, 1.0, 0.5);
  for (const [ff, q] of [[520, 5], [880, 7]]) m.connect(v.filter('bandpass', ff, q)).connect(fe);
  fe.connect(v.out);
  thud(v, t, 34, 22, 2.6, 0.5, { drop: 0.8, a: 0.15 });
  noiseShot(v, t + 0.1, { kind: 'brown', type: 'lowpass', f0: 600, f1: 200, q: 0.7, a: 0.4, dur: dur * 0.8, peak: 0.32 });
});

// Grab: continuous thrashing while held in the jaws. Loop; ctl.set(intensity).
sound('grabStruggle', { priority: 8, max: 1, positional: false, loop: true }, (v) => {
  const t = v.t0;
  const n = v.noise('brown', t, null);
  const lp = v.filter('lowpass', 450, 1.2);
  const am = v.gain(0.45);
  lfo(v, t, null, 6.7, 0.3, am.gain, 'square');
  lfo(v, t, null, 2.3, 0.22, am.gain);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.3, t + 0.1);
  n.connect(lp).connect(am).connect(g).connect(v.out);
  const b = v.noise('burst#0', t, null, 0.9);
  const bg = v.gain(0);
  bg.gain.setValueAtTime(0, t);
  bg.gain.linearRampToValueAtTime(0.18, t + 0.2);
  b.connect(bg).connect(v.out);
  const w = v.osc('sine', 52, t, null);
  const wam = v.gain(0.5);
  lfo(v, t, null, 6.7, 0.5, wam.gain, 'square');
  const wg = v.gain(0.12);
  w.connect(wam).connect(wg).connect(v.out);
  const P = {
    g: new SmoothParam(g.gain, 0.3, 0.003),
    lp: new SmoothParam(lp.frequency, 450, 0.01),
    bg: new SmoothParam(bg.gain, 0.18, 0.003),
  };
  v.ctl = {
    set(x, time) {
      const k = clamp(x, 0, 1);
      P.g.set(0.28 + 0.3 * k, time, 0.1);
      P.lp.set(420 + 700 * k, time, 0.1);
      P.bg.set(0.16 + 0.2 * k, time, 0.1);
    },
  };
});

sound('thrash', { priority: 5, max: 3, minInterval: 0.08, ref: 5 }, (v) => {
  const t = v.t0;
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 600, f1: 220, q: 0.9, a: 0.005, dur: 0.2, peak: 0.35 });
  thud(v, t, 75, 40, 0.18, 0.32);
});

sound('grabStab', { priority: 8, max: 3, minInterval: 0.06, positional: false, send: 0.15 }, (v) => {
  const t = v.t0;
  thud(v, t, 140, 60, 0.14, 0.42);
  noiseShot(v, t, { kind: 'pink', f0: 1500, f1: 420, q: 5, a: 0.002, dur: 0.13, peak: 0.48 });
  crunch(v, t + 0.005, { peak: 0.3, rate: rand(1, 1.25) });
});

sound('grabBreak', { priority: 9, max: 1, minInterval: 0.3, positional: false, send: 0.3 }, (v) => {
  const t = v.t0;
  noiseShot(v, t + 0.05, { kind: 'white', f0: 1400, q: 1.6, a: 0.0005, dur: 0.035, peak: 0.36 });
  whoosh(v, t, { dur: 0.5, f0: 150, f1: 620, f2: 140, q: 0.8, kind: 'brown', type: 'lowpass', peak: 0.5, apex: 0.3 });
  bubbles(v, t, 'burst', { peak: 0.48, rate: 0.95 });
  bubbles(v, t + 0.1, 'glug', { peak: 0.3, rate: 1 });
});

sound('enemyDeath', { priority: 7, max: 2, minInterval: 0.3, ref: 8, send: 0.4, gain: 0.85 }, (v, o) => {
  const t = v.t0;
  const s = clamp(o.size ?? 1, 0.6, 3);
  const n = v.noise('brown', t, t + 2.4);
  const lp = v.filter('lowpass', 600 / Math.sqrt(s), 0.9);
  const am = v.gain(0.5);
  const tl = lfo(v, t, t + 2.4, 7, 0.45, am.gain, 'square');
  tl.frequency.setValueAtTime(7, t);
  tl.frequency.exponentialRampToValueAtTime(2, t + 2.2);
  const env = v.gain();
  v.adsr(env.gain, t, 0.02, 0.3, 0.6, 0.6, 1.3, 0.5);
  n.connect(lp).connect(am).connect(env).connect(v.out);
  bubbles(v, t + 0.05, 'burst', { peak: 0.45, rate: 0.85 });
  bubbles(v, t + 0.4, 'glug', { peak: 0.35, rate: 0.9 });
  thud(v, t, 55 / Math.sqrt(s), 30 / Math.sqrt(s), 1.2, 0.45, { drop: 0.6 });
});

// Fast close pass of a big body (follows the shark).
sound('swimBy', { priority: 5, max: 3, minInterval: 0.4, ref: 6 }, (v, o) => {
  const t = v.t0;
  const s = clamp(o.size ?? 1, 0.6, 3);
  const dur = 1.6 * s ** 0.3;
  whoosh(v, t, { dur, f0: 200, f1: 520, f2: 160, q: 0.8, kind: 'brown', type: 'lowpass', peak: 0.55, apex: 0.45 });
  const f0 = Math.max(34, 42 / s ** 0.5); // the megalodon's would sit at 18-26 Hz: inaudible
  const sub = v.osc('sine', f0, t, t + dur + 0.1);
  sub.frequency.setValueAtTime(f0, t);
  sub.frequency.exponentialRampToValueAtTime(Math.max(28, 30 / s ** 0.5), t + dur);
  const sg = v.gain();
  v.adsr(sg.gain, t, dur * 0.45, 0.1, 0.7, 0, dur * 0.45, 0.22);
  sub.connect(sg).connect(v.out);
});

// Continuous presence of a shark: water displacement driven by its speed.
// Loop; ctl.set(speed01).
// The megalodon (size > 1.8; the engine plays it with ref ≈ 5·size m and a
// gentle rolloff so it carries at circling distance) is a moving mass of
// water: a 90-320 Hz rush swelling with its slow tail beat (~0.26 Hz), plus a
// low pressure tone (46 + 55 Hz) driven through an asymmetric saturator. The
// tone is heard through its harmonics (92-165 Hz, beating at 9 Hz — audible on
// laptop / phone speakers too): a 24 dB/oct high-pass at 100 Hz keeps only a
// trace of the bare fundamentals, which mostly cost headroom and pile up as
// sub-bass under the boss fight (≈ 35-45 % of the wake's power is < 120 Hz,
// down from ≈ 85 %).
sound('wake', { priority: 7, max: 4, ref: 5, rolloff: 1, loop: true }, (v, o) => {
  const t = v.t0;
  const s = clamp(o.size ?? 1, 0.5, 3);
  const big = s > 1.8;
  const n = v.noise('brown', t, null, 0.8);
  const lp = v.filter('lowpass', big ? 320 : 420 / Math.sqrt(s), 0.8);
  const am = v.gain(0.7);
  lfo(v, t, null, big ? 0.26 : 0.95 / Math.sqrt(s), big ? 0.4 : 0.3, am.gain);
  const g = v.gain(0);
  n.connect(lp).connect(v.filter('highpass', big ? 90 : 45, 0.7)).connect(am);
  am.connect(g).connect(v.out);
  const level = new SmoothParam(g.gain, 0, 0.004);
  let subLevel = null;
  if (big) {
    // fixed drive into the shaper (constant timbre); the level is set after it
    const drive = v.gain(0.45);
    v.osc('sine', 46, t, null).connect(drive);
    v.osc('sine', 55, t, null).connect(drive);
    v.constant(0.3, t, null).connect(drive); // asymmetry → even harmonics too
    // strips the DC and all but a trace of the bare fundamentals (2 × 12 dB/oct)
    const hp = v.filter('highpass', 100, 0.7);
    const hp2 = v.filter('highpass', 100, 0.7);
    const sam = v.gain(0.6);
    lfo(v, t, null, 0.26, 0.4, sam.gain); // the same slow tail-beat swell
    const sg = v.gain(0);
    drive.connect(v.shaper(2.5)).connect(hp).connect(hp2).connect(sam).connect(sg).connect(v.out);
    subLevel = new SmoothParam(sg.gain, 0, 0.004);
  }
  v.ctl = {
    set(x, time) {
      const k = clamp(x, 0, 1);
      level.set(0.07 + 0.55 * k * k, time, 0.25);
      subLevel?.set(0.22 + 0.62 * k, time, 0.4);
    },
  };
  v.ctl.set(0, t);
});

// ---------------------------------------------------------------------------
// Ambience one-shots
// ---------------------------------------------------------------------------

sound('bubbles', { priority: 2, max: 4, minInterval: 0.12, ref: 3, hrtf: false }, (v, o) => {
  const fam = o.big ? 'glug' : 'trickle';
  bubbles(v, v.t0, fam, { peak: 0.32 * clamp(o.intensity ?? 1, 0, 2), rate: rand(0.8, 1.25) * (o.pitch ?? 1) });
});

// The player's own breath leaving as bubbles past the ears.
sound('exhale', { priority: 3, max: 2, minInterval: 0.8, positional: false }, (v, o) => {
  const t = v.t0;
  const I = clamp(o.intensity ?? 0.5, 0, 1);
  const p = v.pan(rand(-0.25, 0.25));
  p.connect(v.out);
  bubbles(v, t + 0.06, 'exhale', { peak: 0.26 + 0.16 * I, rate: rand(0.85, 1.1), dest: p });
  const n = v.noise('pink', t, t + 1.35);
  const bp = v.filter('bandpass', 260, 1.1);
  const am = v.gain(0.55);
  lfo(v, t, t + 1.35, 23, 0.45, am.gain);
  const g = v.gain();
  v.adsr(g.gain, t, 0.12, 0.2, 0.6, 0.4, 0.45, 0.2 + 0.12 * I);
  n.connect(bp).connect(am).connect(g).connect(p);
});

// Distant metallic groan of the wreck.
sound('creak', { priority: 2, max: 2, minInterval: 1, ref: 12, rolloff: 0.6, send: 0.7, hrtf: false }, (v) => {
  const { src } = v.sample(variantKey('creak'), v.t0, rand(0.72, 1.15));
  const pk = v.filter('peaking', 380, 1, 4);
  const lp = v.filter('lowpass', 1800, 0.7);
  const g = v.gain(0.5);
  src.connect(pk).connect(lp).connect(g).connect(v.out);
});

// Far-off deep boom (shifting seabed, something huge moving in the dark).
sound('deepBoom', { priority: 2, max: 1, minInterval: 5, ref: 30, rolloff: 0.5, send: 0.8, hrtf: false }, (v) => {
  const t = v.t0;
  thud(v, t, 38, 24, 3.2, 0.45, { drop: 0.7, a: 0.08 });
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 140, f1: 60, q: 0.7, a: 0.2, dur: 3.5, peak: 0.38 });
});

sound('whaleMoan', { priority: 3, max: 1, minInterval: 8, ref: 40, rolloff: 0.5, send: 1, hrtf: false }, (v) => {
  const t = v.t0;
  const k = rand(0.85, 1.2);
  fmMoan(v, t, { path: [[0, 70 * k], [1.4, 118 * k], [2.8, 96 * k], [4.4, 58 * k]], ratio: 0.5, index: [0, 55, 20], dur: 4.6, peak: 0.3 });
});

// Sperm-whale passage: slow FM glides + a few distant clicks (codas).
sound('whaleSong', { priority: 6, max: 1, minInterval: 6, ref: 45, rolloff: 0.4, send: 1, hrtf: false }, (v) => {
  const t = v.t0;
  fmMoan(v, t, { path: [[0, 140], [1.8, 262], [3.5, 208], [5.2, 300], [7.6, 118]], ratio: 0.5, index: [0, 120, 40], dur: 8, peak: 0.34, a: 1.2, r: 2.2 });
  fmMoan(v, t + 2, { path: [[0, 410], [2, 600], [4, 380]], ratio: 1.5, index: [0, 90, 10], dur: 5, peak: 0.12, a: 1, r: 1.8 });
  for (let i = 0; i < 5; i++) {
    noiseShot(v, t + 6.2 + i * (0.19 + i * 0.02), { kind: 'white', f0: 1800, q: 3, a: 0.0005, dur: 0.012, peak: 0.25 });
  }
});

// ---------------------------------------------------------------------------
// Musical stingers (music bus)
// ---------------------------------------------------------------------------

// Wave start (also every retry): the loudest music event of a calm moment. The
// opening drum + sub hit is the transient that reached the limiter, so it is
// softer than the brass blast it announces.
sound('waveStart', { bus: 'music', priority: 9, max: 1, minInterval: 0.5, positional: false, send: 0.6, gain: 0.8 }, (v, o) => {
  const t = v.t0;
  const boss = !!o.boss;
  instTaiko(v, t, { vel: 0.8, size: boss ? 1.4 : 1.25 });
  thud(v, t, 55, 27, boss ? 3 : 2.2, 0.24, { drop: 0.7, a: 0.01 });
  instBrass(v, t, { midis: boss ? [26, 33, 38, 39, 45] : [26, 38, 45, 51], dur: boss ? 3.4 : 2.6, vel: 0.95, a: 0.04, r: boss ? 2.4 : 1.8 });
  noiseShot(v, t, { kind: 'white', f0: 3500, f1: 1800, q: 4, a: 0.01, dur: 1.5, peak: 0.035 });
  if (boss) {
    instTaiko(v, t + 0.46, { vel: 0.85, size: 1.3 });
    instTaiko(v, t + 0.92, { vel: 1, size: 1.45 });
  }
});

// Relief after a wave: dissonance resolving to an open sus2 chord + bell.
sound('waveClear', { bus: 'music', priority: 8, max: 1, minInterval: 0.5, positional: false, send: 0.5 }, (v) => {
  const t = v.t0;
  instTaiko(v, t, { vel: 0.4, size: 1.15 });
  instPad(v, t, { midis: [50, 51, 56], dur: 0.9, vel: 0.5, a: 0.05, r: 0.6, bright: 0.4 });
  instPad(v, t + 0.6, { midis: [38, 50, 57, 62, 64], dur: 5, vel: 0.95, a: 1.1, r: 2.6, bright: 0.45 });
  instBell(v, t + 0.75, { midi: 74, vel: 0.45, dur: 4 });
  instBell(v, t + 1.6, { midi: 81, vel: 0.25, dur: 3 });
});

sound('killSting', { bus: 'music', priority: 8, max: 1, minInterval: 0.4, positional: false, send: 0.5 }, (v) => {
  const t = v.t0;
  instTaiko(v, t, { vel: 0.95, size: 1.2 });
  instBrass(v, t, { midis: [26, 38, 41, 44], dur: 2.3, vel: 0.85, a: 0.03, r: 1.9 });
  thud(v, t, 46, 26, 1.8, 0.28, { drop: 0.7 });
});

// Short original melancholic-triumphant phrase: Dm → B♭ → F → A → D major.
sound('victory', { bus: 'music', priority: 10, max: 1, minInterval: 2, positional: false, send: 0.5 }, (v) => {
  const t = v.t0;
  const B = 60 / 66;
  const chords = [
    [0, 2, [38, 45, 50, 53]],
    [2, 2, [34, 41, 46, 50]],
    [4, 2, [41, 48, 53, 57]],
    [6, 2, [33, 40, 45, 49]],
    [8, 5.5, [26, 38, 45, 50, 54]],
  ];
  for (const [b, len, midis] of chords) instBrass(v, t + b * B, { midis, dur: len * B + 0.5, vel: b === 8 ? 1 : 0.72, a: 0.35, r: b === 8 ? 3 : 0.6 });
  const mel = [[57, 0, 1], [62, 1, 1], [65, 2, 1.5], [64, 3.5, 0.5], [62, 4, 1], [60, 5, 1], [57, 6, 1], [61, 7, 1], [62, 8, 4.5]];
  for (const [m, b, len] of mel) instCello(v, t + b * B, { midi: m, dur: len * B, vel: 1 });
  for (const b of [0, 2, 4, 6]) instTaiko(v, t + b * B, { vel: 0.65, size: 1.1 });
  for (let i = 0; i < 6; i++) instTaiko(v, t + (7 + i / 6) * B, { vel: 0.22 + i * 0.08, size: 0.8 });
  instTaiko(v, t + 8 * B, { vel: 1, size: 1.35 });
  instBell(v, t + 8 * B, { midi: 74, vel: 0.5, dur: 4.5 });
});

// Death: low cluster sinking a semitone into darkness + a final boom.
sound('death', { bus: 'music', priority: 10, max: 1, minInterval: 1, positional: false, send: 0.5 }, (v) => {
  const t = v.t0;
  const dur = 6.5;
  const lp = v.filter('lowpass', 420, 0.9);
  lp.frequency.setValueAtTime(420, t);
  lp.frequency.exponentialRampToValueAtTime(90, t + dur);
  const env = v.gain();
  v.adsr(env.gain, t, 0.8, 0.4, 0.85, dur - 3.7, 2.5, 0.11);
  for (const m of [26, 27, 33, 38]) {
    for (const d of [-7, 6]) {
      const o = v.osc('sawtooth', mtof(m), t, t + dur + 0.2, d);
      o.frequency.setValueAtTime(mtof(m), t + 0.6);
      o.frequency.exponentialRampToValueAtTime(mtof(m) * 0.94, t + dur);
      o.connect(lp);
    }
  }
  lp.connect(env).connect(v.out);
  thud(v, t, 50, 24, 2.2, 0.48, { drop: 0.8 });
  bubbles(v, t + 0.3, 'glug', { peak: 0.3, rate: 0.7 });
});

// ---------------------------------------------------------------------------
// Body / UI / intro (dry buses)
// ---------------------------------------------------------------------------

sound('heartbeat', { bus: 'body', priority: 6, max: 3, positional: false }, (v, o) => instHeart(v, v.t0, o));

sound('uiHover', { bus: 'ui', priority: 9, max: 2, minInterval: 0.05, positional: false }, (v) => {
  const t = v.t0;
  thud(v, t, 980, 1320, 0.05, 0.09, { drop: 0.7, a: 0.002 });
  thud(v, t, 1960, 2640, 0.03, 0.02, { drop: 0.7, a: 0.002 });
});

sound('uiClick', { bus: 'ui', priority: 9, max: 2, minInterval: 0.08, positional: false }, (v) => {
  const t = v.t0;
  thud(v, t, 520, 260, 0.11, 0.16, { drop: 0.6, a: 0.002 });
  noiseShot(v, t, { kind: 'white', f0: 2800, q: 1.2, a: 0.0005, dur: 0.012, peak: 0.09 });
  thud(v, t, 140, 90, 0.1, 0.08);
});

sound('subtitleTick', { bus: 'ui', priority: 3, max: 1, minInterval: 0.25, positional: false }, (v) => {
  const t = v.t0;
  thud(v, t, 2100, 1900, 0.04, 0.035, { a: 0.001 });
  noiseShot(v, t, { kind: 'white', f0: 4000, q: 2, a: 0.0005, dur: 0.015, peak: 0.025 });
});

// Original feature-phone ringtone (not any existing ring) through a tiny
// speaker, with the vibration motor buzzing on a table. opts.rings (default 3).
const RING = [81, 88, 93, 88, 91, 89, 88, 86, 88, 0, 81, 0, 0, 0, 0, 0];
sound('phoneRing', { bus: 'ui', priority: 9, max: 1, positional: false }, (v, o) => {
  const t = v.t0;
  const rings = clamp(Math.round(o.rings ?? 3), 1, 8);
  const step = 0.085;
  const cycle = 2.1;
  const end = t + rings * cycle;
  const osc = v.osc(getPulseWave(v.ctx), 440, t, end);
  const gate = v.gain(0);
  const hp = v.filter('highpass', 520, 0.8);
  const pk = v.filter('peaking', 2300, 1.4, 7);
  const lp = v.filter('lowpass', 4800, 0.7);
  const sh = v.shaper(1.6);
  const lvl = v.gain(0.55);
  osc.connect(gate).connect(hp).connect(pk).connect(lp).connect(sh).connect(lvl).connect(v.out);
  const buzz = v.osc('sawtooth', 168, t, end);
  const bl = v.filter('lowpass', 420, 1);
  const bg = v.gain(0);
  buzz.connect(bl).connect(bg).connect(v.out);
  for (let r = 0; r < rings; r++) {
    const tr = t + r * cycle;
    for (let i = 0; i < RING.length; i++) {
      const m = RING[i];
      if (!m) continue;
      const ts = tr + i * step;
      osc.frequency.setValueAtTime(mtof(m), ts);
      gate.gain.setValueAtTime(0, ts);
      gate.gain.linearRampToValueAtTime(0.5, ts + 0.004);
      gate.gain.setValueAtTime(0.5, ts + step * 0.8);
      gate.gain.linearRampToValueAtTime(0, ts + step * 0.8 + 0.006);
    }
    bg.gain.setValueAtTime(0, tr);
    bg.gain.linearRampToValueAtTime(0.1, tr + 0.03);
    bg.gain.setValueAtTime(0.1, tr + 1.2);
    bg.gain.linearRampToValueAtTime(0, tr + 1.25);
  }
});

sound('phonePickup', { bus: 'ui', priority: 9, max: 1, minInterval: 0.3, positional: false }, (v) => {
  const t = v.t0;
  noiseShot(v, t, { kind: 'white', f0: 3000, q: 1.5, a: 0.0005, dur: 0.012, peak: 0.16 });
  thud(v, t, 180, 120, 0.05, 0.1);
  noiseShot(v, t + 0.04, { kind: 'pink', type: 'bandpass', f0: 1800, q: 0.6, a: 0.05, dur: 0.6, peak: 0.02 });
});

// Hitting the water from above (dry: we are still above the surface).
sound('diveSplash', { bus: 'ui', priority: 8, max: 1, minInterval: 1, positional: false }, (v) => {
  const t = v.t0;
  noiseShot(v, t, { kind: 'white', type: 'lowpass', f0: 7000, f1: 1500, q: 0.5, a: 0.008, dur: 0.6, peak: 0.32 });
  noiseShot(v, t, { kind: 'pink', f0: 900, f1: 400, q: 0.8, a: 0.01, dur: 0.45, peak: 0.3 });
  thud(v, t, 120, 60, 0.25, 0.28);
  for (let i = 0; i < 7; i++) {
    const f = rand(1300, 2600);
    thud(v, t + rand(0.15, 0.8), f, f * 1.4, 0.04, 0.035, { drop: 0.6, a: 0.001 });
  }
});

// …and the muffled rush once the head goes under.
sound('diveBubbles', { priority: 8, max: 1, minInterval: 1, positional: false, send: 0.4 }, (v) => {
  const t = v.t0;
  bubbles(v, t, 'burst', { peak: 0.5, rate: 0.9 });
  bubbles(v, t + 0.1, 'glug', { peak: 0.35, rate: 1 });
  bubbles(v, t + 0.35, 'exhale', { peak: 0.3, rate: 0.8 });
  noiseShot(v, t, { kind: 'brown', type: 'lowpass', f0: 700, f1: 200, q: 0.8, a: 0.05, dur: 1.6, peak: 0.42 });
  thud(v, t, 70, 40, 0.6, 0.24);
});

/** Public play() names (documented at the top of AudioEngine.js). */
export const PUBLIC_SOUNDS = Object.keys(SOUNDS).filter((k) => !SOUNDS[k].internal);
