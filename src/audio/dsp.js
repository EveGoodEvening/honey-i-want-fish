// Low-level DSP helpers shared by every audio builder:
//   - maths + a seeded RNG (procedural buffers are deterministic),
//   - procedurally generated sample buffers (noise colours, bubble textures,
//     bone crunches, metal creaks, the underwater reverb impulse response),
//   - waveshaper curves and a pulse PeriodicWave,
//   - SmoothParam: de-duplicated, click-free AudioParam automation,
//   - Voice: a tiny node-graph builder that records every node it creates so a
//     finished sound can be stopped and disconnected without leaking.
//
// Everything here takes a BaseAudioContext, so it works identically with the
// live AudioContext and with an OfflineAudioContext (used by the numeric
// self-test in src/audio/offline.js).

export const TAU = Math.PI * 2;
export const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (n) => (Math.random() * n) | 0;
export const finite = (x, fallback = 0) => (Number.isFinite(x) ? x : fallback);

/** mulberry32 — tiny deterministic PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Sample buffers
// ---------------------------------------------------------------------------
// AudioBuffers are not bound to a context, so they are cached per sample rate
// and shared between the live context and offline test contexts.

const bufferCache = new Map();

function makeBuffer(ctx, channels, length, sampleRate) {
  try {
    return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
  } catch {
    return ctx.createBuffer(channels, length, sampleRate);
  }
}

function normalizePeak(buf, target = 0.9) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= 0) return buf;
  const k = target / peak;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buf;
}

function normalizeRms(data, target) {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  const rms = Math.sqrt(s / data.length) || 1;
  const k = target / rms;
  for (let i = 0; i < data.length; i++) data[i] *= k;
}

/**
 * Make a looping noise buffer seamless: crossfade the last `fade` samples into
 * the start (equal-power, the two segments are uncorrelated) and drop them.
 */
function loopable(ctx, src, sampleRate, fade) {
  const len = src.length - fade;
  const buf = makeBuffer(ctx, 1, len, sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = src[i];
  for (let i = 0; i < fade; i++) {
    const x = i / fade;
    d[i] = src[i] * Math.sin(x * Math.PI * 0.5) + src[len + i] * Math.cos(x * Math.PI * 0.5);
  }
  return buf;
}

// Minnaert bubble resonance: f ≈ 3.26 / r  (r in metres) → 3260 / r_mm Hz.
// Damping and the slight upward chirp follow van den Doel's bubble model.
function synthBubbles(ctx, sr, seed, { dur, count, rMin, rMax, timeDist, skew = 1.6, gain = 0.9 }) {
  const R = mulberry32(seed);
  const len = Math.ceil(dur * sr);
  const buf = makeBuffer(ctx, 2, len, sr);
  const L = buf.getChannelData(0);
  const Rt = buf.getChannelData(1);
  for (let k = 0; k < count; k++) {
    const t0 = clamp(timeDist(R), 0, 0.97) * dur;
    const r = rMin * (rMax / rMin) ** (R() ** skew);
    const f0 = 3260 / r;
    const d = 0.043 * f0 + 0.0014 * f0 ** 1.5;
    const xi = 0.05 + R() * 0.35;
    const amp = (0.35 + 0.65 * R()) * (r / rMax) ** 0.5;
    const pan = (R() * 2 - 1) * 0.75;
    const gl = Math.cos((pan + 1) * Math.PI * 0.25);
    const gr = Math.sin((pan + 1) * Math.PI * 0.25);
    const n0 = Math.floor(t0 * sr);
    const n = Math.min(len - n0, Math.ceil((6.5 / d) * sr));
    const decay = Math.exp(-d / sr);
    let env = amp;
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = f0 * (1 + (xi * d * i) / sr);
      phase += (TAU * f) / sr;
      const att = i < 32 ? i / 32 : 1;
      const s = env * att * Math.sin(phase);
      L[n0 + i] += s * gl;
      Rt[n0 + i] += s * gr;
      env *= decay;
    }
  }
  return normalizePeak(buf, gain);
}

// Cartilage / bone crunch: a cluster of short resonant clicks.
function synthCrunch(ctx, sr, seed) {
  const R = mulberry32(seed);
  const dur = 0.3;
  const len = Math.ceil(dur * sr);
  const buf = makeBuffer(ctx, 1, len, sr);
  const out = buf.getChannelData(0);
  const clicks = 9 + Math.floor(R() * 8);
  for (let k = 0; k < clicks; k++) {
    const big = k < 2;
    const t0 = (R() ** 1.7) * 0.17 * dur / 0.3 + (big ? 0 : 0.004);
    const f = big ? 160 + R() * 160 : 450 + R() * 1700;
    const tau = big ? 0.02 + R() * 0.02 : 0.003 + R() * 0.008;
    const rr = Math.exp(-1 / (tau * sr));
    const a1 = 2 * rr * Math.cos((TAU * f) / sr);
    const a2 = rr * rr;
    const amp = (big ? 0.8 : 0.25 + R() * 0.75) * (R() < 0.5 ? -1 : 1);
    const exLen = Math.ceil((0.0006 + R() * 0.0015) * sr);
    const n0 = Math.floor(t0 * sr);
    const n = Math.min(len - n0, Math.ceil(tau * 7 * sr));
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const x = i < exLen ? amp * (R() * 2 - 1) * (1 - i / exLen) : 0;
      const y = x * (1 - rr) * 4 + a1 * y1 - a2 * y2;
      y2 = y1;
      y1 = y;
      out[n0 + i] += y;
    }
  }
  // fade the tail so the buffer always ends at silence
  const fade = Math.floor(0.02 * sr);
  for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
  return normalizePeak(buf, 0.9);
}

// Ship-hull / wreck metal groan: stick-slip friction impulses exciting a bank
// of inharmonic plate modes. The friction rate glides, giving the "creeeak".
function synthCreak(ctx, sr, seed) {
  const R = mulberry32(seed);
  const dur = 2.6 + R() * 1.6;
  const len = Math.ceil(dur * sr);
  const buf = makeBuffer(ctx, 1, len, sr);
  const out = buf.getChannelData(0);
  const ex = new Float32Array(len);
  const base = 9 + R() * 22;
  const peakRate = base * (1.8 + R() * 1.6);
  const peakAt = 0.3 + R() * 0.4;
  let phase = 0;
  let walk = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const env = Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.25) * (0.6 + 0.4 * Math.sin(t * 9.3 + seed));
    walk += (R() - 0.5) * 0.004;
    walk *= 0.999;
    const bell = Math.exp(-(((t - peakAt) / 0.28) ** 2));
    const rate = base + (peakRate - base) * bell + walk * base * 10;
    phase += Math.max(2, rate) / sr;
    if (phase >= 1) {
      phase -= 1;
      ex[i] += env * (0.5 + R() * 0.5) * (R() < 0.5 ? -1 : 1);
    }
    ex[i] += env * (R() * 2 - 1) * 0.012; // friction hiss
  }
  const f0 = 120 + R() * 140;
  const modes = [1, 1.59, 2.31, 3.37, 4.53, 5.97];
  for (let m = 0; m < modes.length; m++) {
    const f = f0 * modes[m] * (1 + (R() - 0.5) * 0.04);
    const tau = 0.08 + R() * 0.3;
    const rr = Math.exp(-1 / (tau * sr));
    const a1 = 2 * rr * Math.cos((TAU * f) / sr);
    const a2 = rr * rr;
    const g = (1 - rr) * (1.4 / (m + 1) ** 0.6);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < len; i++) {
      const y = ex[i] * g + a1 * y1 - a2 * y2;
      y2 = y1;
      y1 = y;
      out[i] += y;
    }
  }
  const fade = Math.floor(0.05 * sr);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[len - 1 - i] *= i / fade;
  }
  return normalizePeak(buf, 0.9);
}

const GENERATORS = {
  white(ctx, sr) {
    const R = mulberry32(11);
    const len = Math.floor(sr * 3);
    const buf = makeBuffer(ctx, 1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = R() * 2 - 1;
    return buf;
  },
  pink(ctx, sr) {
    // Paul Kellet's refined pink filter.
    const R = mulberry32(23);
    const len = Math.floor(sr * 3.2);
    const d = new Float32Array(len);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = R() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    normalizeRms(d, 0.3);
    return loopable(ctx, d, sr, Math.floor(sr * 0.2));
  },
  brown(ctx, sr) {
    const R = mulberry32(37);
    const len = Math.floor(sr * 3.4);
    const d = new Float32Array(len);
    let b = 0;
    for (let i = 0; i < len; i++) {
      b = (b + 0.02 * (R() * 2 - 1)) / 1.02;
      d[i] = b;
    }
    // remove DC, then normalise
    let mean = 0;
    for (let i = 0; i < len; i++) mean += d[i];
    mean /= len;
    for (let i = 0; i < len; i++) d[i] -= mean;
    normalizeRms(d, 0.3);
    return loopable(ctx, d, sr, Math.floor(sr * 0.25));
  },
  trickle(ctx, sr, v) {
    return synthBubbles(ctx, sr, 101 + v, {
      dur: 2.2, count: 16 + v * 3, rMin: 2.6, rMax: 7, skew: 1.2,
      timeDist: (R) => (R() < 0.3 ? R() * 0.3 : R()),
    });
  },
  burst(ctx, sr, v) {
    return synthBubbles(ctx, sr, 211 + v, {
      dur: 1.4, count: 70 + v * 8, rMin: 2.2, rMax: 11,
      timeDist: (R) => R() ** 2.4,
    });
  },
  exhale(ctx, sr, v) {
    return synthBubbles(ctx, sr, 307 + v, {
      dur: 1.9, count: 46 + v * 6, rMin: 4, rMax: 14, skew: 1.1,
      timeDist: (R) => (R() + R() + R()) / 3 * 0.85,
    });
  },
  glug(ctx, sr, v) {
    return synthBubbles(ctx, sr, 401 + v, {
      dur: 1.6, count: 16 + v * 2, rMin: 8, rMax: 22, skew: 0.9,
      timeDist: (R) => R() ** 1.4 * 0.9,
    });
  },
  crunch(ctx, sr, v) {
    return synthCrunch(ctx, sr, 503 + v * 17);
  },
  creak(ctx, sr, v) {
    return synthCreak(ctx, sr, 601 + v * 31);
  },
};

export const BUFFER_VARIANTS = { trickle: 3, burst: 3, exhale: 3, glug: 2, crunch: 4, creak: 3 };

/** Get (and lazily synthesise) a named buffer, e.g. 'brown', 'burst#2', 'creak#1'. */
export function getBuffer(ctx, key) {
  const ck = `${key}@${ctx.sampleRate}`;
  let b = bufferCache.get(ck);
  if (!b) {
    const hash = key.indexOf('#');
    const name = hash < 0 ? key : key.slice(0, hash);
    const variant = hash < 0 ? 0 : +key.slice(hash + 1) || 0;
    const gen = GENERATORS[name];
    if (!gen) return null;
    b = gen(ctx, ctx.sampleRate, variant);
    bufferCache.set(ck, b);
  }
  return b;
}

/** Random variant key of a multi-variant buffer family. */
export function variantKey(name) {
  const n = BUFFER_VARIANTS[name] ?? 1;
  return `${name}#${randInt(n)}`;
}

/** Pre-synthesise every buffer for this sample rate (spread over idle time). */
export function prewarmBuffers(ctx, onDone) {
  const keys = ['white', 'pink', 'brown'];
  for (const [name, n] of Object.entries(BUFFER_VARIANTS)) for (let i = 0; i < n; i++) keys.push(`${name}#${i}`);
  let i = 0;
  const step = () => {
    const t0 = performance.now();
    while (i < keys.length && performance.now() - t0 < 6) getBuffer(ctx, keys[i++]);
    if (i < keys.length) setTimeout(step, 16);
    else onDone?.();
  };
  step();
}

/** Energy (Σh² per channel) of the reverb IR; sets the reverb's loudness. */
export const IR_ENERGY = 0.012;

/**
 * Underwater reverb impulse response: diffuse stereo noise with an exponential
 * decay whose spectrum darkens over time (high frequencies die first, like sound
 * in deep water), a slow diffuse build-up and a few early reflections.
 */
export function getImpulse(ctx, seconds = 5, energy = IR_ENERGY) {
  const sr = ctx.sampleRate;
  const ck = `ir:${seconds}:${energy}@${sr}`;
  let buf = bufferCache.get(ck);
  if (buf) return buf;
  const len = Math.floor(seconds * sr);
  buf = makeBuffer(ctx, 2, len, sr);
  const rt60 = seconds * 0.82;
  for (let ch = 0; ch < 2; ch++) {
    const R = mulberry32(1234 + ch * 777);
    const d = buf.getChannelData(ch);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp((-t * 6.91) / rt60);
      const alpha = 0.075 + 0.45 * Math.exp(-t * 2.6);
      const comp = ((2 - alpha) / alpha) ** 0.7;
      const w = R() * 2 - 1;
      y1 += alpha * (w - y1);
      y2 += alpha * (y1 - y2);
      const build = t < 0.06 ? t / 0.06 : 1;
      d[i] = y2 * env * comp * build;
    }
    // early reflections (seabed / wreck hull)
    const taps = [11, 19, 27, 38, 53, 71, 94];
    for (let k = 0; k < taps.length; k++) {
      const n = Math.floor(((taps[k] + ch * 3.7) / 1000) * sr);
      if (n < len) d[n] += (0.5 / (k + 1)) * (R() < 0.5 ? -1 : 1);
    }
  }
  // Normalise to a known energy (sum of squares per channel) instead of the
  // convolver's own normalisation, whose gain on a dark IR is unpredictable
  // (and huge for low frequencies).
  let e = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) e += d[i] * d[i];
  }
  const k = Math.sqrt(energy / (e / 2 || 1));
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  bufferCache.set(ck, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Curves & waves
// ---------------------------------------------------------------------------

const curveCache = new Map();

/** tanh saturation curve, normalised so ±1 maps to ±1. */
export function driveCurve(amount) {
  const key = `drive:${amount.toFixed(2)}`;
  let c = curveCache.get(key);
  if (!c) {
    const n = 2048;
    c = new Float32Array(n);
    const norm = Math.tanh(amount);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(amount * x) / norm;
    }
    curveCache.set(key, c);
  }
  return c;
}

/**
 * Final safety soft clipper. The shaper input is pre-scaled by 0.5, so the
 * curve domain [-1, 1] covers signal levels [-2, 2]: transparent up to 0.8,
 * then a soft knee that never exceeds 0.99.
 */
export function softClipCurve() {
  let c = curveCache.get('softclip');
  if (!c) {
    const n = 4096;
    c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = ((i / (n - 1)) * 2 - 1) * 2;
      const a = Math.abs(s);
      const y = a <= 0.8 ? a : 0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19);
      c[i] = Math.sign(s) * y;
    }
    curveCache.set('softclip', c);
  }
  return c;
}

const waveCache = new WeakMap();

/** Narrow pulse wave (≈25 % duty) — the reedy timbre of an old phone buzzer. */
export function getPulseWave(ctx) {
  let w = waveCache.get(ctx);
  if (!w) {
    const n = 32;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const duty = 0.25;
    for (let k = 1; k < n; k++) imag[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty) * (1 - k / n);
    w = ctx.createPeriodicWave(real, imag);
    waveCache.set(ctx, w);
  }
  return w;
}

// ---------------------------------------------------------------------------
// SmoothParam
// ---------------------------------------------------------------------------

/**
 * Wraps an AudioParam that is driven every frame. Only issues a new
 * setTargetAtTime when the target moved by more than `eps` (relative for
 * values > 1), so the automation timeline stays short; never accepts NaN.
 */
export class SmoothParam {
  constructor(param, value, eps = 0.004) {
    this.param = param;
    this.target = value;
    this.eps = eps;
    param.value = value;
  }

  set(v, now, tau = 0.12) {
    if (!Number.isFinite(v)) return;
    if (Math.abs(v - this.target) <= this.eps * Math.max(1, Math.abs(v))) return;
    this.target = v;
    this.param.setTargetAtTime(v, now, tau);
  }

  jump(v, now) {
    if (!Number.isFinite(v)) return;
    this.target = v;
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(v, now);
  }
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

/**
 * A single playing sound. Builders create nodes through the factory methods so
 * every node is recorded; `end` tracks the latest scheduled stop time. The
 * owning VoicePool disconnects everything once `end` has passed.
 */
export class Voice {
  constructor(ctx, name, dest, t0) {
    this.ctx = ctx;
    this.name = name;
    this.t0 = t0;
    this.end = t0;
    this.loop = false;
    this.ended = false;
    this.released = false; // fading out (stolen / loop stopped): no longer counts against the cap
    this.priority = 5;
    this.level = 1;
    this.nodes = [];
    this.sources = [];
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.nodes.push(this.out);
    this.ctl = null; // live controls for looping sounds: { set(value, time) }
    this.follow = null; // Vector3-like followed by the panner
    this.panner = null;
    this.distLP = null;
    this.reverbSend = null; // set by the pool (mixer.reverbIn)
  }

  _n(node) {
    this.nodes.push(node);
    return node;
  }

  _src(node, start, stop) {
    node.start(start);
    if (stop == null) this.loop = true;
    else {
      node.stop(stop);
      if (stop > this.end) this.end = stop;
    }
    this.sources.push(node);
    return this._n(node);
  }

  gain(value = 0) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return this._n(g);
  }

  filter(type, freq, Q = 0.707, gainDb = 0) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = Q;
    f.gain.value = gainDb;
    return this._n(f);
  }

  osc(type, freq, start, stop, detune = 0) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type;
    else o.setPeriodicWave(type);
    o.frequency.value = freq;
    o.detune.value = detune;
    return this._src(o, start, stop);
  }

  /** Constant (DC) source — e.g. to bias a waveshaper for even harmonics. */
  constant(value, start, stop) {
    const c = this.ctx.createConstantSource();
    c.offset.value = value;
    return this._src(c, start, stop);
  }

  /** Looping noise of a given colour from a random offset. */
  noise(kind, start, stop, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = getBuffer(this.ctx, kind);
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(start, Math.random() * (s.buffer.duration - 0.05));
    if (stop == null) this.loop = true;
    else {
      s.stop(stop);
      if (stop > this.end) this.end = stop;
    }
    this.sources.push(s);
    return this._n(s);
  }

  /** One-shot sample playback (bubble textures, crunches, creaks). */
  sample(key, start, rate = 1) {
    const buf = getBuffer(this.ctx, key);
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const stop = start + buf.duration / rate + 0.01;
    return { src: this._src(s, start, stop), stop };
  }

  shaper(amount) {
    const w = this.ctx.createWaveShaper();
    w.curve = driveCurve(amount);
    return this._n(w);
  }

  pan(value) {
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (!p) return this.gain(1);
    p.pan.value = clamp(value, -1, 1);
    return this._n(p);
  }

  delay(seconds, max = 1) {
    const d = this.ctx.createDelay(max);
    d.delayTime.value = seconds;
    return this._n(d);
  }

  /** Extra reverb send straight into the mixer's reverb (bigger / farther sounds). */
  send(amount) {
    if (!this.reverbSend || !(amount > 0)) return;
    const g = this.gain(amount);
    this.out.connect(g);
    g.connect(this.reverbSend);
  }

  // --- envelopes (all return the time at which the param is back at 0) ---

  /** Percussive: linear attack, exponential decay to -60 dB over `dur`, then 0. */
  perc(param, t, a, dur, peak) {
    peak = finite(peak);
    param.setValueAtTime(0, t);
    if (peak <= 0) return t;
    param.linearRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(peak * 1e-3, t + a + dur);
    param.linearRampToValueAtTime(0, t + a + dur + 0.015);
    return t + a + dur + 0.02;
  }

  /** ADSR with a known hold time (fully scheduled up front). */
  adsr(param, t, a, d, s, hold, r, peak) {
    peak = finite(peak);
    param.setValueAtTime(0, t);
    if (peak <= 0) return t;
    const sus = Math.max(1e-4, peak * s);
    param.linearRampToValueAtTime(peak, t + a);
    param.linearRampToValueAtTime(sus, t + a + d);
    const tr = t + a + d + Math.max(0, hold);
    param.setValueAtTime(sus, tr);
    param.exponentialRampToValueAtTime(Math.max(1e-5, sus * 1e-3), tr + r);
    param.linearRampToValueAtTime(0, tr + r + 0.015);
    return tr + r + 0.02;
  }

  /** Exponential crescendo to `peak` at t+dur, held for `hold` s, then a quick release. */
  swell(param, t, dur, peak, release = 0.08, hold = 0) {
    peak = finite(peak);
    param.setValueAtTime(0, t);
    if (peak <= 0) return t;
    param.linearRampToValueAtTime(peak * 1e-3, t + 0.01);
    param.exponentialRampToValueAtTime(peak, t + dur);
    const r = t + dur + Math.max(0, hold);
    if (hold > 0) param.setValueAtTime(peak, r);
    param.exponentialRampToValueAtTime(peak * 1e-3, r + release);
    param.linearRampToValueAtTime(0, r + release + 0.01);
    return r + release + 0.02;
  }

  /** Fade the whole voice out and stop it (voice stealing / loop release). */
  release(fade = 0.08, at = null) {
    if (this.ended || this.released) return;
    this.released = true;
    const t = Math.max(this.ctx.currentTime, at ?? this.ctx.currentTime);
    const g = this.out.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(this.level, t);
      g.linearRampToValueAtTime(0, t + fade);
    } catch {
      /* ignore */
    }
    const stop = t + fade + 0.02;
    for (const s of this.sources) {
      try {
        s.stop(stop);
      } catch {
        /* already stopped */
      }
    }
    this.loop = false;
    this.end = stop + 0.02;
  }

  dispose() {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    this.follow = null;
    this.ctl = null;
  }
}
