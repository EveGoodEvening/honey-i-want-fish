// Adaptive tension score. Original material only (D minor; the ostinato is a
// 3+3+2 pattern of roots, octaves and fifths — deliberately nothing like the
// famous two-note semitone shark motif).
//
// Persistent layers (built once, mixed continuously):
//   drone      two crossfading banks of detuned-saw "low strings" playing the
//              current chord through a slowly breathing low-pass
//   tremolo    high sul-ponticello-ish tremolo strings, fades in with danger
//   dissonance a ♭9 above the chord root, only near danger 1
// Scheduled layers (look-ahead scheduler, notes are VoicePool voices):
//   ostinato   low cello plucks; tempo, density, velocity and brightness
//              all rise with tension
//   taiko      war drums in the megalodon fight; density rises with danger and
//              with each roar (boss phase)
//   brass      low brass swells every few bars in the boss fight
//   heartbeat  lub-dub on the body bus; rate/volume from danger + low health
//   melody     the title theme (slow solo cello)
//
// Modes: off | title | intro | combat | boss | breather | dead | victory.
// Every level change is a setTargetAtTime glide — never an abrupt cut.
import { SmoothParam, mtof, clamp, lerp, smoothstep } from './dsp.js';

// Chords as [voice0..voice3] MIDI notes (low register) + ostinato root.
const CHORDS = [
  { notes: [26, 33, 38, 41], root: 38 }, // Dm      D1 A1 D2 F2
  { notes: [34, 41, 38, 45], root: 34 }, // B♭maj7  B♭1 F2 D2 A2
  { notes: [31, 38, 43, 46], root: 31 }, // Gm      G1 D2 G2 B♭2
  { notes: [33, 40, 43, 46], root: 33 }, // A7♭9 (no 3rd)  A1 E2 G2 B♭2
];
const MAJOR = { notes: [26, 33, 38, 42], root: 38 }; // D major (victory)
const DRONE_UP = 12; // the string banks play the chords an octave higher (sub root stays low)
const PULSE_UP = 12; // ostinato in the cello's middle register (the pluck adds its own sub-octave)

// 16 eighth-note steps: [interval from root, accent]. Accents on 1, 4, 7 of
// each bar give the 3+3+2 drive.
const OSTINATO = [
  [0, 1], [0, 0], [12, 0], [0, 1], [0, 0], [12, 0], [7, 1], [0, 0],
  [0, 1], [0, 0], [12, 0], [0, 1], [0, 0], [12, 0], [3, 1], [-2, 0],
];

// Taiko hits per level: step → [vel, size].
const TAIKO = [
  { 0: [0.9, 1.3] },
  { 0: [0.95, 1.3], 6: [0.55, 1], 8: [0.8, 1.2], 14: [0.55, 1] },
  { 0: [1, 1.3], 3: [0.45, 0.9], 6: [0.6, 1], 8: [0.85, 1.2], 11: [0.45, 0.9], 14: [0.6, 1], 15: [0.4, 0.85] },
  { 0: [1, 1.35], 2: [0.4, 0.85], 3: [0.5, 0.9], 6: [0.65, 1], 8: [0.9, 1.25], 10: [0.4, 0.85], 11: [0.5, 0.9], 12: [0.45, 0.85], 13: [0.5, 0.85], 14: [0.6, 1], 15: [0.7, 1] },
];

// Title theme (MIDI, beats) — slow solo cello.
const TITLE_THEME = [[62, 2], [65, 1], [64, 1], [57, 3], [0, 1], [58, 1], [57, 1], [55, 1], [53, 1], [52, 2], [57, 2], [50, 4]];

const MODES = {
  off: { drone: 0, cutoff: 200 },
  title: { drone: 0.5, cutoff: 430 },
  intro: { drone: 0.26, cutoff: 260 },
  combat: { drone: 0.34, cutoff: 300, pulse: true, heart: 1, tense: true },
  boss: { drone: 0.46, cutoff: 380, pulse: true, taiko: true, heart: 1, tense: true, floor: 0.35 },
  breather: { drone: 0.15, cutoff: 220, heart: 0.5 },
  dead: { drone: 0.26, cutoff: 150 },
  victory: { drone: 0, cutoff: 650 },
};

export class Music {
  constructor(ctx, mixer, pool, { quality = 'high' } = {}) {
    this.ctx = ctx;
    this.pool = pool;
    this.quality = quality;
    this.mode = 'off';
    this.modeTime = 0;
    this.tension = 0;
    this.phase = 0; // boss phase (incremented by roars)
    this.chordIndex = 0;
    this.chord = CHORDS[0];
    this.pulseOn = false;
    this.step = 0;
    this.nextStep = 0;
    this.nextChordAt = 0;
    this.nextBeat = 0;
    this.nextPhrase = 0;
    this.nodes = [];

    const g = (v = 1) => this._n(ctx.createGain(), (n) => (n.gain.value = v));
    this.out = g(1);
    this.out.connect(mixer.music);

    // ---- drone ----
    this.droneOut = g(0);
    const lp1 = this._filter('lowpass', 300, 0.7);
    const lp2 = this._filter('lowpass', 360, 1.1);
    this.droneOut.connect(lp1).connect(lp2).connect(this.out);
    this.droneLevel = new SmoothParam(this.droneOut.gain, 0, 0.004);
    this.droneCut1 = new SmoothParam(lp1.frequency, 300, 0.01);
    this.droneCut2 = new SmoothParam(lp2.frequency, 360, 0.01);
    const breathe = this._osc('sine', 0.07);
    const bd = g(55);
    breathe.connect(bd);
    bd.connect(lp1.frequency);
    bd.connect(lp2.frequency);
    // slow ensemble detune drift (chorus)
    const drift = this._osc('sine', 0.13);
    this.driftDepth = g(5);
    drift.connect(this.driftDepth);

    // Sub root: a soft sine an octave below the strings for weight (kept low:
    // 37-58 Hz barely reaches small speakers and only costs headroom).
    this.subOsc = this._osc('sine', mtof(this.chord.notes[0]));
    const subG = g(0.05);
    this.subOsc.connect(subG).connect(this.droneOut);

    const perVoice = quality === 'low' ? [-6, 7] : [-8, 0, 7];
    const pans = [-0.45, 0.4, -0.2, 0.25];
    this.banks = [0, 1].map((b) => {
      const bankGain = g(b === 0 ? 1 : 0);
      bankGain.connect(this.droneOut);
      const voices = this.chord.notes.map((m, i) => {
        const vg = g(0.07);
        const pan = ctx.createStereoPanner ? this._n(ctx.createStereoPanner(), (p) => (p.pan.value = pans[i])) : g(1);
        vg.connect(pan).connect(bankGain);
        const oscs = perVoice.map((d) => {
          const o = this._osc('sawtooth', mtof(m + DRONE_UP), d + (b ? 3 : -3));
          this.driftDepth.connect(o.detune);
          o.connect(vg);
          return o;
        });
        return { oscs };
      });
      return { gain: bankGain, voices };
    });
    this.active = 0;

    // ---- tremolo strings ----
    this.tremOut = g(0);
    const tremAM = g(0.5);
    this.tremLFO = this._osc('sine', 7);
    const tremDepth = g(0.5);
    this.tremLFO.connect(tremDepth).connect(tremAM.gain);
    const tbp = this._filter('bandpass', 1400, 0.8);
    const tlp = this._filter('lowpass', 3200, 0.7);
    this.tremOscs = [0, 1, 2].map((i) => {
      const o = this._osc('sawtooth', mtof(this.chord.notes[i + 1] + 24), (i - 1) * 9);
      const og = g(0.05);
      o.connect(og).connect(tbp);
      return o;
    });
    tbp.connect(tlp).connect(tremAM).connect(this.tremOut).connect(this.out);
    this.tremLevel = new SmoothParam(this.tremOut.gain, 0, 0.004);
    this.tremRate = new SmoothParam(this.tremLFO.frequency, 7, 0.02);

    // ---- ♭9 dissonance ----
    this.dissOut = g(0);
    const dlp = this._filter('lowpass', 900, 0.8);
    this.dissOscs = [-6, 6].map((d) => {
      const o = this._osc('sawtooth', mtof(this.chord.root + 13 + 12), d);
      o.connect(dlp);
      return o;
    });
    const dg = g(0.06);
    dlp.connect(dg).connect(this.dissOut).connect(this.out);
    this.dissLevel = new SmoothParam(this.dissOut.gain, 0, 0.004);

    this.outLevel = new SmoothParam(this.out.gain, 1, 0.004);
  }

  _n(node, init) {
    init?.(node);
    this.nodes.push(node);
    return node;
  }

  _filter(type, f, q) {
    return this._n(this.ctx.createBiquadFilter(), (b) => {
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
    });
  }

  _osc(type, f, detune = 0) {
    return this._n(this.ctx.createOscillator(), (o) => {
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      o.start();
    });
  }

  setMode(mode, now = this.ctx.currentTime) {
    if (!MODES[mode] || mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    this.modeTime = 0;
    if (mode === 'boss' && prev !== 'boss') this.phase = 0;
    if (mode === 'victory') this._setChord(MAJOR, now + 0.05, 2.5);
    else if (mode === 'dead' || mode === 'title' || mode === 'breather') {
      this.chordIndex = 0;
      this._setChord(CHORDS[0], now + 0.05, 1.5);
    }
    this.nextChordAt = now + 9;
    if (mode === 'title') this.nextPhrase = now + 3;
    if (!MODES[mode].pulse) this.pulseOn = false;
  }

  /**
   * Enemy telegraph: dissonant string cluster swelling into the strike.
   * Returns the cluster voice (or null) so an interrupted wind-up can release it.
   */
  telegraph(duration, now = this.ctx.currentTime) {
    if (!MODES[this.mode].tense) return null;
    return this.pool.play('m_cluster', {
      when: now,
      dur: clamp(duration ?? 0.8, 0.35, 2.5),
      root: this.chord.root + 12 + (this.chord.root < 34 ? 12 : 0),
      vel: 0.45 + 0.55 * this.tension,
    });
  }

  /** Megalodon roar / phase change: brass blast + drum fill, raises the boss phase. */
  roar(now = this.ctx.currentTime) {
    this.phase++;
    this.pool.play('m_brass', { when: now + 0.15, midis: [26, 33, 38, 39], dur: 3.6, vel: 1, a: 0.6, r: 1.6 });
    for (let i = 0; i < 6; i++) this.pool.play('m_taiko', { when: now + 0.6 + i * 0.16, vel: 0.35 + i * 0.11, size: 0.95 + i * 0.05 });
  }

  /** Short accent on a successful parry (bright pluck + bell-ish ping). */
  accent(now = this.ctx.currentTime) {
    if (!MODES[this.mode].tense) return;
    this.pool.play('m_pluck', { when: now, midi: this.chord.root + 24, vel: 0.7, bright: 0.9, len: 0.4 });
  }

  _setChord(chord, time, tau = 0.6) {
    this.chord = chord;
    const next = 1 - this.active;
    const bank = this.banks[next];
    for (let i = 0; i < bank.voices.length; i++) {
      const f = mtof(chord.notes[i] + DRONE_UP);
      for (const o of bank.voices[i].oscs) o.frequency.setValueAtTime(f, time);
    }
    bank.gain.gain.setTargetAtTime(1, time, tau);
    this.subOsc.frequency.setTargetAtTime(mtof(chord.notes[0]), time, 0.25);
    this.banks[this.active].gain.gain.setTargetAtTime(0, time, tau);
    this.active = next;
    for (let i = 0; i < this.tremOscs.length; i++) this.tremOscs[i].frequency.setTargetAtTime(mtof(chord.notes[i + 1] + 24), time, 0.05);
    const df = mtof(chord.root + 25);
    for (const o of this.dissOscs) o.frequency.setTargetAtTime(df, time, 0.08);
  }

  _advanceChord(time) {
    this.chordIndex = (this.chordIndex + 1) % CHORDS.length;
    this._setChord(CHORDS[this.chordIndex], time);
  }

  /**
   * p: { danger 0..1, lowHealth 0..1, grab bool, duck 0..1 (1 = full level) }
   * lookahead: seconds of notes to schedule ahead of `now`.
   */
  update(now, dt, p, lookahead = 0.2) {
    const mode = MODES[this.mode];
    this.modeTime += dt;
    const danger = Math.max(p.danger ?? 0, mode.floor ?? 0);
    const tension = clamp(Math.max(danger, (p.lowHealth ?? 0) * 0.7, p.grab ? 1 : 0), 0, 1);
    this.tension = tension;
    const tense = !!mode.tense;

    // ---- continuous mix ----
    let drone = mode.drone * (tense ? 0.75 + 0.6 * tension : 1);
    if (this.mode === 'victory' && this.modeTime > 9) drone = 0.3;
    this.droneLevel.set(drone, now, this.mode === 'off' ? 0.3 : 1.2);
    const cut = mode.cutoff + (tense ? 950 * tension : 0);
    this.droneCut1.set(cut, now, 0.8);
    this.droneCut2.set(cut * 1.2, now, 0.8);
    this.tremLevel.set(tense ? smoothstep(0.35, 0.95, tension) * 0.55 : 0, now, 0.9);
    this.tremRate.set(6 + 8 * tension, now, 0.5);
    this.dissLevel.set(tense ? smoothstep(0.6, 1, tension) * 0.5 : 0, now, 0.9);
    this.outLevel.set(clamp(p.duck ?? 1, 0, 1), now, 0.35);

    // ---- ostinato / drums (look-ahead scheduler) ----
    if (mode.pulse) {
      const want = this.mode === 'boss' || tension > 0.12;
      if (!this.pulseOn && want) {
        this.pulseOn = true;
        this.step = 0;
        this.nextStep = now + 0.08;
      } else if (this.pulseOn && this.mode !== 'boss' && tension < 0.06) {
        this.pulseOn = false;
      }
    }
    if (this.pulseOn) {
      if (this.nextStep < now - 0.15) this.nextStep = now + 0.03; // fell behind (tab hidden)
      while (this.nextStep < now + lookahead) {
        this._scheduleStep(this.nextStep, tension);
        this.nextStep += this._stepDur(tension);
        this.step++;
      }
    } else if (this.mode !== 'victory' && this.mode !== 'off' && now >= this.nextChordAt) {
      this._advanceChord(now + 0.05);
      this.nextChordAt = now + (this.mode === 'title' ? 11 : 9);
    }

    // ---- heartbeat ----
    if (mode.heart) {
      const breather = this.mode === 'breather';
      const drive = breather ? 0.05 : Math.max(tension * 0.85, p.lowHealth ?? 0, p.grab ? 1 : 0);
      const bpm = lerp(58, 150, drive);
      const vel = breather ? 0.38 : mode.heart * (0.1 + 0.6 * drive);
      if (this.nextBeat < now - 0.3) this.nextBeat = now + 0.1;
      while (this.nextBeat < now + lookahead) {
        if (vel > 0.04) this.pool.play('heartbeat', { when: this.nextBeat, vel, bpm });
        this.nextBeat += 60 / bpm;
      }
    } else {
      this.nextBeat = now;
    }

    // ---- title theme ----
    if (this.mode === 'title' && now >= this.nextPhrase) {
      const beat = 60 / 58;
      let tt = Math.max(now, this.nextPhrase);
      for (const [m, b] of TITLE_THEME) {
        if (m) this.pool.play('m_cello', { when: tt, midi: m, dur: b * beat * 0.95, vel: 0.75 });
        tt += b * beat;
      }
      this.pool.play('m_bell', { when: this.nextPhrase, midi: 62, vel: 0.3, dur: 5 });
      this.nextPhrase = tt + 12;
    }
  }

  _stepDur(tension) {
    let bpm = lerp(72, 152, tension ** 0.9);
    if (this.mode === 'boss') bpm = Math.max(bpm, 100);
    return 60 / bpm / 2;
  }

  _scheduleStep(time, tension) {
    const k = this.step % 16;
    if (k === 0 && this.step > 0) this._advanceChord(time);
    const [iv, acc] = OSTINATO[k];
    const root = this.chord.root;
    const ghostOk = tension > 0.3 && (iv !== 12 || tension > 0.5);
    if (acc || ghostOk) {
      const vel = acc ? 0.55 + 0.45 * tension : 0.18 + 0.35 * tension;
      const bright = 0.15 + 0.85 * tension;
      this.pool.play('m_pluck', { when: time, midi: root + iv + PULSE_UP, vel, bright });
      if (acc && tension > 0.72) {
        this.pool.play('m_pluck', { when: time + this._stepDur(tension) * 0.5, midi: root + iv + PULSE_UP + 12, vel: vel * 0.45, bright });
      }
    }
    if (this.mode === 'boss') {
      const level = clamp(Math.floor(tension * 2.3 + this.phase * 0.7), 0, 3);
      const hit = TAIKO[level][k];
      if (hit) this.pool.play('m_taiko', { when: time, vel: hit[0] * (0.7 + 0.3 * tension), size: hit[1] });
      if (k === 0 && this.step % 32 === 0 && (level >= 1 || this.phase > 0)) {
        const r = root < 34 ? root + 12 : root;
        this.pool.play('m_brass', { when: time, midis: [r - 12, r - 5, r], dur: this._stepDur(tension) * 14, vel: 0.55 + 0.4 * tension });
      }
    }
  }

  dispose() {
    for (const n of this.nodes) {
      try {
        n.stop?.();
      } catch {
        /* not a source / already stopped */
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
