// Mixer: bus routing + master chain. Works with any BaseAudioContext.
//
//   water ─► LP ─► LP ─┬► low-shelf ─► waterOut ─┬──────────────► pre
//   (in-world sounds:  │                         └► waterSend ─► reverbIn
//    muffled underwater acoustics)
//   cue ───► LP ─► LP ─┘  (in-world, but its low-pass never closes below
//                          CUE_FLOOR: the strike cue must read through
//                          slow-mo / hurt-dip / grab muffling)
//   music ─► LP 7k ─► musicOut ─┬──────────────► pre
//                               └► musicSend ─► reverbIn
//   ui    ─► uiOut ──────────────────────────────► pre   (dry, above water)
//   body  ─► LP ─► saturate ─► LP ─► bodyOut ────► pre   (heartbeat, "inside you")
//   reverbIn ─► pre-delay ─► Convolver (long dark tail) ─► HP ─► LP ─► reverbOut ─► pre
//
//   pre (×0.7 trim) ─► HP 28 Hz ─► master ─► glue compressor ─► limiter ─► ×0.5 ─► soft clipper ─► destination
//
// The 28 Hz high-pass keeps infrasonic weight (which no laptop or phone speaker
// reproduces) from eating headroom and pumping the glue compressor; the low
// end that should be *felt* is carried by harmonics in the 60-200 Hz range.
// The soft clipper's curve is pre-scaled so it is transparent below 0.8 and
// can never output more than 0.99, so the output never clips even if the
// limiter (which has a short look-ahead) overshoots on a transient.
import { SmoothParam, getImpulse, softClipCurve, driveCurve } from './dsp.js';

export const WATER_CUTOFF = 1400; // Hz, calm water-bus low-pass
// Hz, lowest low-pass the 'cue' branch follows the water bus down to. The strike
// cue's bite swell lives at 330-1350 Hz: through the slow-mo (620 Hz) or hurt-dip
// (≈300-420 Hz) cutoffs it sank 6-12 dB on the water bus (−19.8 dB calm → −28.6 at
// 420 Hz, −31.9 at 300), under the lunge it overlaps. Floored at 900 Hz it stays
// within ≈2.5 dB of calm water (−22.0 / −22.4 dB) and still sounds underwater.
export const CUE_FLOOR = 900;
export const REVERB_RETURN = 1; // reverb return level
export const MUSIC_LEVEL = 0.9; // score level (sits a few dB under the in-world sound)
export const BODY_LEVEL = 0.62; // heartbeat bus level
// Headroom into the master chain (part of the output stage, like the high-pass:
// offline per-sound renders without the chain skip it): the glue compressor
// adds ≈ +6 dB of automatic make-up gain (the limiter ≈ +1.7 dB) and its 12 ms
// attack lets fast transients through at full make-up, so the summed buses
// enter 3 dB down: in a calm fight not even a shark's wake passing at arm's
// length, a heavy thrust or the wave-start drum reaches the limiter. (Sustained,
// compressed material loses only about a third of that.)
export const MIX_TRIM = 0.7;

export function createMixer(ctx, { quality = 'high', destination = ctx.destination, masterChain = true } = {}) {
  const gain = (v = 1) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const biquad = (type, f, q = 0.707, db = 0) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = db;
    return b;
  };

  const m = { ctx, quality };

  // ---- master ----
  m.pre = gain(masterChain ? MIX_TRIM : 1);
  m.masterGain = gain(0.85);
  if (masterChain) {
    // Part of the output stage (offline per-sound renders skip it with the
    // rest of the chain: a high-pass this close to the roar's 22-37 Hz core
    // sharpens its raw peaks, which the limiter below then catches).
    const subCut = biquad('highpass', 28, 0.707); // 12 dB/oct
    m.pre.connect(subCut).connect(m.masterGain);
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 10;
    glue.ratio.value = 3;
    glue.attack.value = 0.012;
    glue.release.value = 0.28;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    const clipIn = gain(0.5);
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    m.masterGain.connect(glue).connect(limiter).connect(clipIn).connect(clip).connect(destination);
    m.glue = glue;
    m.limiter = limiter;
  } else {
    m.pre.connect(m.masterGain);
    m.masterGain.connect(destination);
  }
  m.master = new SmoothParam(m.masterGain.gain, 0.85);

  // ---- reverb ----
  const irSeconds = quality === 'low' ? 3 : quality === 'medium' ? 4.5 : 5.5;
  // Sub content is kept out of the reverb (it only turns into mud / boom).
  m.reverbIn = gain(1);
  const revInHP = biquad('highpass', 170, 0.7);
  const revInLP = biquad('lowpass', 3200, 0.7);
  const predelay = ctx.createDelay(0.2);
  predelay.delayTime.value = 0.035;
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = getImpulse(ctx, irSeconds);
  const revHP = biquad('highpass', 90, 0.6);
  const revLP = biquad('lowpass', 1600, 0.5);
  m.reverbOutGain = gain(REVERB_RETURN);
  m.reverbIn.connect(revInHP).connect(revInLP).connect(predelay).connect(conv).connect(revHP).connect(revLP).connect(m.reverbOutGain).connect(m.pre);
  m.reverbOut = new SmoothParam(m.reverbOutGain.gain, REVERB_RETURN);

  // ---- water bus ----
  m.water = gain(1);
  const lp1 = biquad('lowpass', WATER_CUTOFF, 0.6);
  const lp2 = biquad('lowpass', WATER_CUTOFF * 1.15, 0.85);
  const shelf = biquad('lowshelf', 120, 0.707, 2);
  m.waterOutGain = gain(1);
  m.water.connect(lp1).connect(lp2).connect(shelf).connect(m.waterOutGain).connect(m.pre);
  m.waterSendGain = gain(0.42);
  m.waterOutGain.connect(m.waterSendGain).connect(m.reverbIn);
  m.waterCut1 = new SmoothParam(lp1.frequency, WATER_CUTOFF, 0.01);
  m.waterCut2 = new SmoothParam(lp2.frequency, WATER_CUTOFF * 1.15, 0.01);
  m.waterLevel = new SmoothParam(m.waterOutGain.gain, 1);
  // cue branch: the same water (shelf, level, reverb send), its own low-pass pair
  m.cue = gain(1);
  const cueLp1 = biquad('lowpass', WATER_CUTOFF, 0.6);
  const cueLp2 = biquad('lowpass', WATER_CUTOFF * 1.15, 0.85);
  m.cue.connect(cueLp1).connect(cueLp2).connect(shelf);
  m.cueCut1 = new SmoothParam(cueLp1.frequency, WATER_CUTOFF, 0.01);
  m.cueCut2 = new SmoothParam(cueLp2.frequency, WATER_CUTOFF * 1.15, 0.01);

  // ---- music bus ----
  m.music = gain(1);
  const musicLP = biquad('lowpass', 7000, 0.5);
  m.musicOutGain = gain(MUSIC_LEVEL);
  m.music.connect(musicLP).connect(m.musicOutGain).connect(m.pre);
  m.musicSendGain = gain(0.3);
  m.musicOutGain.connect(m.musicSendGain).connect(m.reverbIn);
  m.musicLevel = new SmoothParam(m.musicOutGain.gain, MUSIC_LEVEL);

  // ---- ui bus (dry: menus, and the phone call above water) ----
  m.ui = gain(1);
  m.uiOutGain = gain(1);
  m.ui.connect(m.uiOutGain).connect(m.pre);
  m.uiLevel = new SmoothParam(m.uiOutGain.gain, 1);

  // ---- body bus (heartbeat): low-passed, gently saturated so the thump has
  // harmonics that survive laptop speakers, then tamed again ----
  m.body = gain(1);
  const bodyLP = biquad('lowpass', 240, 0.7);
  const bodySat = ctx.createWaveShaper();
  bodySat.curve = driveCurve(2.2);
  const bodyLP2 = biquad('lowpass', 700, 0.7);
  m.bodyOutGain = gain(BODY_LEVEL);
  m.body.connect(bodyLP).connect(bodySat).connect(bodyLP2).connect(m.bodyOutGain).connect(m.pre);
  m.bodyLevel = new SmoothParam(m.bodyOutGain.gain, BODY_LEVEL);

  m.buses = { water: m.water, cue: m.cue, music: m.music, ui: m.ui, body: m.body };

  /** Water-bus muffling (Hz). Lower = more pressure / deeper / hurt. The cue branch follows down to CUE_FLOOR. */
  m.setWaterCutoff = (hz, t = ctx.currentTime, tau = 0.12) => {
    m.waterCut1.set(hz, t, tau);
    m.waterCut2.set(hz * 1.15, t, tau);
    const cue = Math.max(hz, CUE_FLOOR);
    m.cueCut1.set(cue, t, tau);
    m.cueCut2.set(cue * 1.15, t, tau);
  };

  return m;
}
