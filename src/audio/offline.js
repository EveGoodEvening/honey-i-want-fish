// Offline rendering + analysis for the numeric audio self-test
// (scripts/audio-scenario.mjs). Not imported by the game itself.
//
// Every sound builder, the mixer, the score and the ambience take a context +
// destination, so they render bit-for-bit the same graph into an
// OfflineAudioContext. Frame updates are simulated with ctx.suspend(t).
import { createMixer } from './mixer.js';
import { VoicePool } from './voices.js';
import { SOUNDS, PUBLIC_SOUNDS } from './sfx.js';
import { Music } from './music.js';
import { Ambience } from './ambience.js';
import { mulberry32 } from './dsp.js';

const SR = 44100;

function makeCtx(seconds, sr = SR) {
  return new OfflineAudioContext({ numberOfChannels: 2, length: Math.max(128, Math.ceil(seconds * sr)), sampleRate: sr });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function monoMix(buf) {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

/** Peak / RMS / NaN / active span / spectral profile of a rendered buffer. */
export function analyze(buf, { from = 0, to = Infinity } = {}) {
  const sr = buf.sampleRate;
  const i0 = Math.max(0, Math.floor(from * sr));
  const i1 = Math.min(buf.length, Math.floor(Math.min(to, buf.duration) * sr));
  let peak = 0;
  let sum = 0;
  let nan = 0;
  let first = -1;
  let last = -1;
  const thr = 1e-3; // -60 dBFS
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = i0; i < i1; i++) {
      const x = d[i];
      if (!Number.isFinite(x)) {
        nan++;
        continue;
      }
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
      sum += x * x;
      if (a > thr) {
        if (first < 0 || i < first) first = i;
        if (i > last) last = i;
      }
    }
  }
  const count = Math.max(1, (i1 - i0) * buf.numberOfChannels);
  const rms = Math.sqrt(sum / count);
  // loudest 50 ms window
  const mono = monoMix(buf);
  const win = Math.floor(0.05 * sr);
  let maxWin = 0;
  for (let i = i0; i + win <= i1; i += win) {
    let s = 0;
    for (let k = 0; k < win; k++) s += mono[i + k] * mono[i + k];
    maxWin = Math.max(maxWin, Math.sqrt(s / win));
  }
  // averaged power spectrum
  const N = 4096;
  const bins = new Float64Array(N / 2);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let windows = 0;
  const hop = Math.max(N, Math.floor((i1 - i0 - N) / 48));
  for (let s = i0; s + N <= i1; s += hop) {
    for (let k = 0; k < N; k++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1));
      re[k] = mono[s + k] * w;
      im[k] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) bins[k] += re[k] * re[k] + im[k] * im[k];
    windows++;
  }
  let pTot = 0;
  let pf = 0;
  const bands = { sub: 0, low: 0, mid: 0, high: 0 }; // <120, 120-500, 500-2000, >2000 Hz
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    const p = bins[k];
    pTot += p;
    pf += p * f;
    if (f < 120) bands.sub += p;
    else if (f < 500) bands.low += p;
    else if (f < 2000) bands.mid += p;
    else bands.high += p;
  }
  if (pTot > 0) for (const k in bands) bands[k] = +(bands[k] / pTot).toFixed(4);
  const db = (x) => (x > 0 ? +(20 * Math.log10(x)).toFixed(1) : -200);
  return {
    peak: +peak.toFixed(4),
    peakDb: db(peak),
    rms: +rms.toFixed(5),
    rmsDb: db(rms),
    loudestDb: db(maxWin),
    nan,
    activeStart: first < 0 ? null : +(first / sr).toFixed(3),
    activeEnd: last < 0 ? null : +(last / sr).toFixed(3),
    centroid: pTot > 0 ? Math.round(pf / pTot) : 0,
    bands,
    windows,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render one registered sound (through its bus incl. reverb; master chain off
 * unless `master`). Looping sounds are driven 0→1 through their ctl and
 * released after `hold` seconds. `cutoff` sets the water-bus muffling (Hz, as
 * AudioEngine does for danger / slow-mo / hurt; the 'cue' branch follows it
 * down to CUE_FLOOR). The sound starts at 0.02 s.
 */
export async function renderSound(name, opts = {}, { tail = 1.5, master = false, quality = 'medium', hold = 1.6, hrtf = false, cutoff = null } = {}) {
  const def = SOUNDS[name];
  if (!def) throw new Error(`unknown sound ${name}`);
  // Dry run to learn the scheduled length.
  const probe = makeCtx(1);
  const pm = createMixer(probe, { quality: 'low', masterChain: false });
  const pv = new VoicePool(probe, pm, { hrtf: false }).play(name, { ...opts, when: 0.02 });
  const scheduled = pv ? (pv.loop ? hold + 0.25 : pv.end - 0.02) : 0;
  const ctx = makeCtx(0.02 + scheduled + tail);
  const mixer = createMixer(ctx, { quality, masterChain: master });
  if (cutoff) mixer.setWaterCutoff(cutoff, 0, 0.001);
  const pool = new VoicePool(ctx, mixer, { hrtf });
  const v = pool.play(name, { ...opts, when: 0.02 });
  if (v?.loop) {
    for (let i = 0; i <= 8; i++) v.ctl?.set(i / 8, 0.02 + (hold * i) / 8);
    v.release(0.2, 0.02 + hold);
  }
  const buf = await ctx.startRendering();
  return { buf, scheduled: +scheduled.toFixed(3), loop: !!def.loop };
}

async function simulate(seconds, setup, step = 0.05) {
  const ctx = makeCtx(seconds);
  const mixer = createMixer(ctx, { quality: 'medium', masterChain: setup.master ?? false });
  const pool = new VoicePool(ctx, mixer, { maxVoices: 44, hrtf: false });
  const tick = setup.build(ctx, mixer, pool);
  tick(0, step);
  for (let t = step; t < seconds - step; t += step) {
    ctx.suspend(t).then(() => {
      tick(ctx.currentTime, step);
      pool.update(ctx.currentTime);
      ctx.resume();
    });
  }
  return ctx.startRendering();
}

/** Render the adaptive score in a given mode at a fixed danger level. */
export function renderMusic({ mode = 'combat', danger = 0, lowHealth = 0, grab = false, phase = 0, seconds = 10, telegraphAt = null, master = false } = {}) {
  return simulate(seconds, {
    master,
    build(ctx, mixer, pool) {
      const music = new Music(ctx, mixer, pool, { quality: 'medium' });
      music.setMode(mode, 0);
      music.phase = phase;
      let tele = telegraphAt;
      return (now, dt) => {
        if (tele != null && now >= tele) {
          music.telegraph(0.9, now);
          tele = null;
        }
        music.update(now, dt, { danger, lowHealth, grab, duck: 1 }, 0.25);
      };
    },
  });
}

/** Render the ambience bed + its random events. */
export function renderAmbience({ seconds = 12, danger = 0 } = {}) {
  return simulate(seconds, {
    build(ctx, mixer, pool) {
      const amb = new Ambience(ctx, mixer, pool);
      // make sure each event type fires at least once in the window
      amb.t.creak = 1;
      amb.t.bubbles = 0.5;
      amb.t.exhale = 2;
      amb.t.boom = 4;
      amb.t.moan = 6;
      return (now, dt) => amb.update(now, dt, { level: 1, danger, breathing: true, exertion: 0.3, lx: 0, ly: -20, lz: 0, wreck: null });
    },
  });
}

/** Worst case: boss music at danger 1 + ambience + a pile-up of big SFX, through the master chain. */
export function renderStress({ seconds = 7 } = {}) {
  return simulate(seconds, {
    master: true,
    build(ctx, mixer, pool) {
      const music = new Music(ctx, mixer, pool, { quality: 'medium' });
      music.setMode('boss', 0);
      music.phase = 3;
      const amb = new Ambience(ctx, mixer, pool);
      let fired = false;
      return (now, dt) => {
        music.update(now, dt, { danger: 1, lowHealth: 1, grab: true, duck: 1 }, 0.25);
        amb.update(now, dt, { level: 1, danger: 1, breathing: true, exertion: 1, lx: 0, ly: 0, lz: 0, wreck: null });
        if (!fired && now >= 1) {
          fired = true;
          const at = [0, 0, -4];
          for (const n of ['roar', 'shockwave', 'ram', 'bite', 'strike', 'tailHit', 'parry', 'critHit', 'fleshHit', 'fleshHit', 'fleshHit']) pool.play(n, { position: at, when: now + 0.01 });
          for (const n of ['playerHurt', 'waveStart', 'killSting', 'slashHeavy', 'perfectDodge']) pool.play(n, { when: now + 0.01 });
          music.roar(now);
          music.telegraph(1, now);
        }
      };
    },
  });
}

// Per-sound options used by the self-test (positional ones get a position).
const TEST_OPTS = {
  slash: { combo: 3 },
  telegraph: { duration: 1.2, position: [6, 0, -8] },
  telegraphHold: { position: [6, 0, -8] },
  strike: { kind: 'bite', eta: 0.3, position: [0, 0, -4] },
  roar: { position: [0, 0, -12], size: 1.3 },
  lunge: { position: [3, 0, -8], size: 1 },
  fleshHit: { position: [0, 0, -4], intensity: 1.45 },
  critHit: { position: [0, 0, -4] },
  bite: { position: [0, 0, -3] },
  parry: { position: [0, 0, -2] },
  wake: { position: [8, 0, -8], size: 2.7 },
  swimBy: { position: [4, 0, -2], size: 1 },
  creak: { position: [30, -20, -30] },
  whaleSong: { position: [-60, -10, -40] },
  whaleMoan: { position: [-60, -10, -40] },
  deepBoom: { position: [40, -40, -40] },
  bubbles: { position: [2, 0, -3] },
  phoneRing: { rings: 2 },
  playerHurt: { heavy: true },
  waveStart: { boss: true },
  heartbeat: { vel: 0.9, bpm: 120 },
  chargeTier: { tier: 2 },
};

// Extra renders with level / spectrum thresholds. The megalodon's wake must
// carry at its circling distance (opts = what the engine passes for size 2.7)
// and live largely above 120 Hz (its harmonics; renders put 39-48 % of the power
// below 120 Hz, the old wake ≈ 85 %), so small speakers reproduce it and it
// doesn't pile up sub-bass under the boss fight. (Its broadband level is
// ≈ 1.5 dB under the old fundamental-heavy wake — the 46/55 Hz tones that made
// up most of it are gone — while the part above 120 Hz is ≈ 2 dB louder; the
// noise-driven loudest window varies ±1 dB per render. In play the live check
// is its share of the water bus within 20 m.) The strike cue's ram and
// megalodon variants must render too, and its swell into the contact (the last
// 70 ms before eta) must survive a hurt-dip cutoff (420 Hz) within SWELL_MAX_DROP
// dB of calm water (on the plain water bus it sank ≈9 dB; the 900 Hz floor still
// trims the top of the swell by ≈2.5 dB). A parry miss at full spam fatigue must
// be ≥ MISS_FATIGUE_LIFT dB louder than a lone one. `repeat` renders a case
// several times and averages its dB levels; `seed` makes those renders
// repeatable (Math.random seeded per render: seed, seed + 1, …), so cases that
// are compared with each other draw the same noise phases, variants and pitches.
const EXTRA_CASES = {
  'wake@30m': { name: 'wake', opts: { position: [0, 0, -30], size: 2.7, ref: 13.5, rolloff: 0.6 }, minLoudestDb: -26, minCentroid: 120, maxSub: 0.6 },
  'strike/ram': { name: 'strike', opts: { kind: 'ram', eta: 0.3, position: [0, 0, -4] }, minLoudestDb: -30 },
  'strike/mega': { name: 'strike', opts: { kind: 'bite', eta: 0.38, size: 2.7, position: [0, 0, -6] }, minLoudestDb: -30 },
  'strike@1400': { name: 'strike', opts: { kind: 'bite', eta: 0.3, position: [0, 0, -4] }, cutoff: 1400, swell: 0.3, repeat: 3, seed: 11 },
  'strike@420': { name: 'strike', opts: { kind: 'bite', eta: 0.3, position: [0, 0, -4] }, cutoff: 420, swell: 0.3, repeat: 3, seed: 11 },
  'parryMiss/f1': { name: 'parryMiss', opts: { fatigue: 1 }, minLoudestDb: -32, repeat: 3, seed: 7 },
  'parryMiss/f3': { name: 'parryMiss', opts: { fatigue: 3 }, minLoudestDb: -32, repeat: 3, seed: 7 },
};
const SWELL_MAX_DROP = 3.5;
const MISS_FATIGUE_LIFT = 2;

/** Render with Math.random seeded (restored afterwards). */
async function seeded(seed, fn) {
  if (seed == null) return fn();
  const random = Math.random;
  Math.random = mulberry32(seed);
  try {
    return await fn();
  } finally {
    Math.random = random;
  }
}

/**
 * Full self-test. Returns { sounds, music, ambience, stress, failures }.
 * Assertions: every public sound non-silent, finite, raw peak < 1, sane
 * duration; EXTRA_CASES level / centroid floors (megalodon wake at 30 m);
 * music louder + brighter at danger 1 than 0; master never ≥ 1.
 */
export async function runAudioSelfTest({ names = PUBLIC_SOUNDS } = {}) {
  const failures = [];
  const fail = (msg) => failures.push(msg);
  const t0 = performance.now();

  const sounds = {};
  for (const name of names) {
    try {
      const { buf, scheduled, loop } = await renderSound(name, TEST_OPTS[name] ?? {});
      const a = analyze(buf);
      // Sounds are randomised (variants, pitch, noise phase): re-render hot
      // ones and assert on the worst case, not on one lucky draw.
      if (a.peak > 0.5) {
        for (let k = 0; k < 3; k++) {
          const r = analyze((await renderSound(name, TEST_OPTS[name] ?? {})).buf);
          if (r.peak > a.peak) {
            a.peak = r.peak;
            a.peakDb = r.peakDb;
          }
          a.nan += r.nan;
        }
        a.retested = 3;
      }
      sounds[name] = { scheduled, loop, ...a };
      if (a.nan) fail(`${name}: ${a.nan} non-finite samples`);
      if (a.peak < 0.003) fail(`${name}: silent (peak ${a.peak})`);
      if (a.peak >= 1) fail(`${name}: raw peak ${a.peak} >= 1`);
      if (!(scheduled >= 0.02 && scheduled <= 15)) fail(`${name}: scheduled duration ${scheduled}s out of range`);
      if (a.activeEnd == null || a.activeEnd - a.activeStart < 0.01) fail(`${name}: active span too short`);
    } catch (err) {
      fail(`${name}: threw ${err?.message ?? err}`);
    }
  }

  for (const [key, c] of Object.entries(EXTRA_CASES)) {
    try {
      const n = c.repeat ?? 1;
      let a = null;
      for (let k = 0; k < n; k++) {
        const { buf } = await seeded(c.seed != null ? c.seed + k : null, () => renderSound(c.name, c.opts, { cutoff: c.cutoff }));
        const r = analyze(buf);
        // the strike's swell: the last 70 ms before contact (the sound starts at 0.02 s)
        if (c.swell) r.swellDb = analyze(buf, { from: 0.02 + c.swell - 0.07, to: 0.02 + c.swell }).rmsDb;
        if (!a) a = r;
        else {
          // worst-case peak / NaNs, mean levels
          if (r.peak > a.peak) {
            a.peak = r.peak;
            a.peakDb = r.peakDb;
          }
          a.nan += r.nan;
          for (const f of ['loudestDb', 'rmsDb', 'swellDb']) if (r[f] != null) a[f] += r[f];
        }
      }
      for (const f of ['loudestDb', 'rmsDb', 'swellDb']) if (a[f] != null) a[f] = +(a[f] / n).toFixed(1);
      sounds[key] = { scheduled: null, loop: !!SOUNDS[c.name].loop, ...a };
      if (a.nan) fail(`${key}: ${a.nan} non-finite samples`);
      if (a.peak >= 1) fail(`${key}: raw peak ${a.peak} >= 1`);
      if (c.minLoudestDb != null && !(a.loudestDb >= c.minLoudestDb)) fail(`${key}: loudest window ${a.loudestDb} dB < ${c.minLoudestDb} dB`);
      if (c.minCentroid != null && !(a.centroid >= c.minCentroid)) fail(`${key}: centroid ${a.centroid} Hz < ${c.minCentroid} Hz`);
      if (c.maxSub != null && !(a.bands.sub <= c.maxSub)) fail(`${key}: ${Math.round(100 * a.bands.sub)} % of the power < 120 Hz (max ${Math.round(100 * c.maxSub)} %)`);
    } catch (err) {
      fail(`${key}: threw ${err?.message ?? err}`);
    }
  }
  {
    const calm = sounds['strike@1400']?.swellDb;
    const dip = sounds['strike@420']?.swellDb;
    if (!(calm - dip <= SWELL_MAX_DROP)) fail(`strike: swell ${dip} dB at a 420 Hz cutoff vs ${calm} dB calm (max drop ${SWELL_MAX_DROP} dB)`);
    const lone = sounds['parryMiss/f1']?.loudestDb;
    const tired = sounds['parryMiss/f3']?.loudestDb;
    if (!(tired - lone >= MISS_FATIGUE_LIFT)) fail(`parryMiss: fatigue 3 (${tired} dB) not ${MISS_FATIGUE_LIFT} dB louder than a lone miss (${lone} dB)`);
  }

  const music = {};
  const musicCases = {
    combat_d0: { mode: 'combat', danger: 0 },
    combat_d05: { mode: 'combat', danger: 0.5 },
    combat_d1: { mode: 'combat', danger: 1 },
    boss_d03: { mode: 'boss', danger: 0.3 },
    boss_d1: { mode: 'boss', danger: 1, phase: 2 },
    title: { mode: 'title', danger: 0, seconds: 14 },
    breather: { mode: 'breather', danger: 0 },
    dead: { mode: 'dead', danger: 0 },
    telegraph: { mode: 'combat', danger: 0.6, telegraphAt: 3 },
  };
  for (const [key, cfg] of Object.entries(musicCases)) {
    try {
      const buf = await renderMusic(cfg);
      const a = analyze(buf, { from: 2.5 });
      music[key] = a;
      if (a.nan) fail(`music ${key}: NaN`);
      if (a.peak < 0.003) fail(`music ${key}: silent`);
      if (a.peak >= 1) fail(`music ${key}: raw peak ${a.peak} >= 1`);
    } catch (err) {
      fail(`music ${key}: threw ${err?.message ?? err}`);
    }
  }
  if (music.combat_d0 && music.combat_d1) {
    const lo = music.combat_d0;
    const hi = music.combat_d1;
    if (!(hi.rms > lo.rms * 1.4)) fail(`music: danger 1 not louder (rms ${lo.rms} → ${hi.rms})`);
    // spectral profile: more energy above 500 Hz and a higher centroid
    const upper = (a) => a.bands.mid + a.bands.high;
    if (!(upper(hi) > upper(lo) * 2)) fail(`music: danger 1 spectrum not brighter (>500 Hz share ${upper(lo)} → ${upper(hi)})`);
    if (!(hi.centroid > lo.centroid * 1.1)) fail(`music: danger 1 centroid not higher (${lo.centroid} → ${hi.centroid})`);
  }

  let ambience = null;
  try {
    const buf = await renderAmbience({ seconds: 12 });
    ambience = analyze(buf, { from: 2 });
    if (ambience.nan) fail('ambience: NaN');
    if (ambience.peak < 0.003) fail('ambience: silent');
    if (ambience.peak >= 1) fail(`ambience: raw peak ${ambience.peak} >= 1`);
  } catch (err) {
    fail(`ambience: threw ${err?.message ?? err}`);
  }

  let stress = null;
  try {
    const buf = await renderStress();
    stress = analyze(buf);
    if (stress.nan) fail('stress: NaN');
    if (stress.peak >= 1) fail(`stress: master peak ${stress.peak} >= 1`);
  } catch (err) {
    fail(`stress: threw ${err?.message ?? err}`);
  }

  return { ms: Math.round(performance.now() - t0), sounds, music, ambience, stress, failures };
}

// ---------------------------------------------------------------------------
// Visual report: spectrograms of rendered sounds on a canvas (for eyeballing
// the sound design in a screenshot, since a headless test cannot listen).
// ---------------------------------------------------------------------------

function drawSpectrogram(g, buf, x, y, w, h, { maxHz = 4000, seconds = null } = {}) {
  const mono = monoMix(buf);
  const sr = buf.sampleRate;
  const N = 2048;
  const dur = seconds ?? buf.duration;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const img = g.createImageData(w, h);
  const maxBin = Math.floor((maxHz / sr) * N);
  for (let col = 0; col < w; col++) {
    const s = Math.floor((col / w) * dur * sr);
    for (let k = 0; k < N; k++) {
      const v = s + k < mono.length ? mono[s + k] : 0;
      re[k] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)));
      im[k] = 0;
    }
    fft(re, im);
    for (let row = 0; row < h; row++) {
      // log-frequency axis 30 Hz .. maxHz
      const f = 30 * (maxHz / 30) ** (1 - row / (h - 1));
      const k = Math.min(maxBin, Math.max(1, Math.round((f / sr) * N)));
      // Hann-windowed sine of amplitude A → |X| = A·N/4
      const amp = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (N / 4);
      const db = 20 * Math.log10(amp + 1e-9);
      const t = Math.max(0, Math.min(1, (db + 84) / 72));
      const i = (row * w + col) * 4;
      img.data[i] = Math.round(255 * Math.min(1, t * 1.6));
      img.data[i + 1] = Math.round(255 * Math.max(0, t * 1.4 - 0.4));
      img.data[i + 2] = Math.round(255 * Math.max(0.15, 0.6 - t * 0.6 + (t > 0.85 ? t : 0)));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, x, y);
  // waveform overlay
  g.strokeStyle = 'rgba(160,230,255,0.55)';
  g.beginPath();
  for (let col = 0; col < w; col++) {
    const a = Math.floor((col / w) * dur * sr);
    const b = Math.floor(((col + 1) / w) * dur * sr);
    let pk = 0;
    for (let i = a; i < b && i < mono.length; i++) pk = Math.max(pk, Math.abs(mono[i]));
    g.moveTo(x + col + 0.5, y + h - 1);
    g.lineTo(x + col + 0.5, y + h - 1 - pk * (h - 2));
  }
  g.stroke();
}

/**
 * Render the given sound names (and optional music cases) into a full-page
 * canvas of labelled spectrograms. Returns the number of panels drawn.
 */
export async function showSpectrogramSheet(items, { cols = 4, panelW = 300, panelH = 120, title = 'audio' } = {}) {
  const rows = Math.ceil(items.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * (panelW + 10) + 10;
  canvas.height = rows * (panelH + 28) + 40;
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#050a0e';
  document.body.appendChild(canvas);
  const g = canvas.getContext('2d');
  g.fillStyle = '#050a0e';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#cfe';
  g.font = '14px monospace';
  g.fillText(`${title} — log-frequency spectrograms 30 Hz–4 kHz, waveform peak overlay`, 10, 20);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const x = 10 + (i % cols) * (panelW + 10);
    const y = 34 + Math.floor(i / cols) * (panelH + 28);
    let buf;
    let label = it.label ?? it.name;
    if (it.music) buf = await renderMusic(it.music);
    else if (it.ambience) buf = await renderAmbience(it.ambience);
    else buf = (await renderSound(it.name, it.opts ?? TEST_OPTS[it.name] ?? {})).buf;
    const a = analyze(buf);
    drawSpectrogram(g, buf, x, y + 16, panelW, panelH, { seconds: it.seconds ?? Math.min(buf.duration, it.music || it.ambience ? 10 : 4) });
    g.fillStyle = '#cfe';
    g.font = '11px monospace';
    g.fillText(`${label}  pk ${a.peakDb}dB rms ${a.rmsDb}dB  ${buf.duration.toFixed(1)}s`, x, y + 12);
  }
  return items.length;
}
