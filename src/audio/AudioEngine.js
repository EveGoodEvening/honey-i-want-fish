/**
 * AudioEngine — 100 % procedural WebAudio for 「老公，我想吃鱼了」.
 * Contract: docs/DESIGN.md "AudioEngine" — { ready, unlock(), play(name, opts), update(dt) }.
 *
 * Before unlock() everything is a silent no-op. unlock() (UI start gesture —
 * the first pointerdown/keydown anywhere also unlocks, so the title music can
 * start) builds the graph:
 *
 *   buses   water (in-world: low-pass 1400 Hz calm that tightens with danger,
 *           grabs, hurt and slow-mo — not hitstops — + a long dark convolution
 *           reverb), cue (water whose low-pass stops at CUE_FLOOR: the strike
 *           cue), music, ui (dry: menus + the phone call above water),
 *           body (heartbeat; ducked while paused)
 *   master  28 Hz high-pass → glue compressor → limiter → safety soft-clipper
 *           (never > 0.99)
 *   3D      listener follows game.camera (pulled halfway toward the player
 *           in third person); positional sounds use PannerNode (HRTF on
 *           quality=high, equal-power otherwise) + distance/behind low-pass
 *   layers  Ambience (src/audio/ambience.js), adaptive score driven by
 *           game.danger / wave / boss state (src/audio/music.js), per-shark
 *           wake presence + swim-by whooshes, heavy-charge whine, grab struggle
 *
 * Behaviour notes
 *   heavy charge  player:heavyCharge {level} is a tier 0-3 (0 = start, 1/2/3 at
 *                 0.4/0.9/1.5 s). The whine glides toward the next tier over the
 *                 known gaps (game time), soft 'chargeTier' ticks mark 1 and 2,
 *                 'chargeReady' marks 3 (full, 60 dmg) — once per charge.
 *   telegraphs    the sting and the score's cluster are kept per shark and
 *                 released if the wind-up is interrupted (eye stab, death, …).
 *                 The sting holds its peak briefly (TELE_PLATEAU) and is cut
 *                 when the attack really starts; a wind-up held longer
 *                 (SharkAI's stacking hold, slow-mo) hands over to the
 *                 'telegraphHold' tail until the lunge. Paused mid-wind-up:
 *                 everything is released (the audio clock keeps running) and
 *                 the wind-up's remaining time kept; on resume a fresh sting
 *                 swells over what is left (or the held tail takes over at
 *                 once if the sting had (nearly) peaked).
 *   strike        enemy:strike {type, eta} plays 'strike' — a rush of water
 *                 into the contact (bite / ram variants): the "parry now" cue,
 *                 eta clamped to STRIKE_ETA_MIN-MAX, on the 'cue' bus (the
 *                 water low-pass stops at CUE_FLOOR for it).
 *                 jawSnap stays the sound of a whiffed bite (perfect dodge).
 *   parry         a press plays 'parryRaise', a window that closes on nothing
 *                 (player:parry {whiff}) 'parryMiss' — heavier with Player's
 *                 spam fatigue (the event's `fatigue` if sent, else mirrored
 *                 here), a clean parry the clang + a score accent.
 *   hits          one playerHurt per frame (the heaviest of that frame), and no
 *                 second bite when a grab starts on the hit that just crunched.
 *   grab          a failed escape ends on the jaws' crunch; non-outcome ends
 *                 (grab:end {interrupted}, wave restart, death) are silent.
 *   death         from player:death the score is in 'dead' mode: no danger
 *                 heartbeat or breathing over the death sting (heartbeats the
 *                 score had already scheduled ahead are cancelled). The sting
 *                 and its fading heartbeats are released (DEATH_RELEASE) when
 *                 the next attempt starts (wave:start / game:victory), so a
 *                 quick retry's wave-start blast doesn't land on top of them.
 *   intro         phone ring → pickup on the first line → splash + bubbles on
 *                 the Director's cinematic 'dive' (a game-time fallback fires
 *                 only if that cue never comes).
 *   mix           the music bus lifts up to MUSIC_LIFT_DB with danger.
 *
 * PLAY NAMES — engine.play(name, opts); unknown names are ignored silently.
 *   player    slash {combo 1-3}, slashHeavy, heavyCharge (loop: voice.ctl.set(level)),
 *             chargeTier {tier 1|2}, chargeReady, dodge, perfectDodge, parryRaise,
 *             parryMiss {fatigue 1-3}, parry, playerHurt {heavy}
 *   combat    fleshHit {intensity 0.4-1.6}, critHit, bite, jawSnap, lunge {size},
 *             strike {kind 'bite'|'ram', eta, size},
 *             telegraph {duration, size}, telegraphHold {size} (loop: release()),
 *             ram, tail, tailHit, shockwave,
 *             roar {size, length}, thrash, grabStab, grabBreak,
 *             grabStruggle (loop: ctl.set(progress)), enemyDeath {size},
 *             swimBy {size}, wake (loop: ctl.set(speed01))
 *   ambience  bubbles {big}, exhale {intensity}, creak, deepBoom, whaleMoan,
 *             whaleSong
 *   music     waveStart {boss}, waveClear, killSting, victory, death
 *   body/ui   heartbeat {vel, bpm}, uiHover, uiClick, subtitleTick,
 *             phoneRing {rings}, phonePickup, diveSplash, diveBubbles
 *   (`size` ≈ body length / 6 m: great white 1, tiger 0.75, megalodon 2.7)
 * Common opts: position (Vector3 | [x,y,z]) → 3D at that point;
 *   follow (enemy | Vector3) → 3D, tracked while playing; gain; delay (s);
 *   ref / rolloff (override the sound's panner distance model).
 * play() returns the Voice (call .release(fade) to stop a loop) or null.
 *
 * Extras: setVolume(0..1), setMuted(bool), toggleMute(), debugInfo(), dispose().
 * The engine subscribes to all game events itself (see _wire()); other modules
 * never need to call it except UI hover/click (auto-wired for buttons inside
 * #ui-root) and unlock().
 */
import * as THREE from 'three';
import { createMixer, WATER_CUTOFF, BODY_LEVEL, MUSIC_LEVEL } from './mixer.js';
import { VoicePool } from './voices.js';
import { SOUNDS, PUBLIC_SOUNDS, TELE_PLATEAU } from './sfx.js';
import { Music } from './music.js';
import { Ambience } from './ambience.js';
import { clamp, smoothstep, finite, rand, prewarmBuffers } from './dsp.js';

export const PLAY_NAMES = Object.freeze([...PUBLIC_SOUNDS]);

const UI_SELECTOR = 'button, [role="button"], [data-sfx], .btn, a[href], input[type="range"]';

// Heavy-charge tiers (Player HEAVY.levels 0.4 / 0.9 / 1.5 s): game-time gaps
// between tier events, and the no-event fallback ramp to full.
const CHARGE_GAPS = [0.4, 0.5, 0.6];
const CHARGE_FULL = 1.5;
const BODY_PAUSED = 0.1; // body bus (heartbeat) level while paused (BODY_LEVEL otherwise)
const WHALE_SONG_DELAY = 2.2; // s after ambient:whale (wave clear): let the kill stinger ring out
// The score rises with the fight: up to +MUSIC_LIFT_DB on the music bus as
// danger climbs 0.3 → 0.8, so it doesn't sink ≈ 8 dB under the in-world combat
// at the climax (the in-fight water bus grows faster than the score).
const MUSIC_LIFT_DB = 4;
// A wind-up still going this long after its sting peaked (s, audio clock) is
// being held by the AI (or stretched by slow-mo): 'telegraphHold' takes over
// while the sting's plateau (TELE_PLATEAU) still sounds. HOLD_GRACE leaves room
// for a frame of jitter between the audio clock and the game clock.
const HOLD_GRACE = TELE_PLATEAU * 0.4;
const HOLD_MAX = 2.5; // a held wind-up longer than this past its peak lets go
// A wind-up paused with at least this much of it left (s) gets a fresh sting
// over the rest on resume (the sting's shortest swell); with less, the held
// tail resumes at once.
const TELE_RESUME_MIN = 0.3;
// Strike cue eta range (s). The volume can't go live sooner than SharkAI's
// STRIKE_LEAD (0.16-0.22 s) after the cue, so a shorter forecast (a ram that
// starts with the snout already touching sends eta 0) would peak before the
// hit; Combat cues at eta ≤ its STRIKE_ETA (0.25-0.32 s), and a gape or a
// fallback cue can put the contact up to ≈0.4 s out.
const STRIKE_ETA_MIN = 0.17;
const STRIKE_ETA_MAX = 0.4;
// s: fade of the death sting (and its slowing heartbeats) when the next attempt
// starts. The wave-start drum + brass hit within ≈0.1 s, so only a short fade
// keeps them off the sting's sustain. Retry 3.4 s after death, limiter peak over
// the next 3 s — offline (score + ambience + master chain, 3 renders each): no
// release 0.73-0.80, a 0.6 s fade 0.66-0.77, 0.2 s 0.65-0.69; live: 0.59-0.65
// vs 0.71 unreleased. The sting is a low dark cluster by then; the hit masks the cut.
const DEATH_RELEASE = 0.2;
// Player's parry spam fatigue (Player.js PARRY_FATIGUE_*: +1 per whiff, capped
// at 3, drains 0.5 per game second; a clean parry or a reset clears it),
// mirrored for 'parryMiss' when player:parry {whiff} carries no `fatigue`.
const MISS_FATIGUE_MAX = 3;
const MISS_FATIGUE_DECAY = 0.5;
// Intro: if the Director's cinematic 'dive' never comes, dive this long (game
// seconds) after 老公's line has finished — the Director's own timeline clock,
// so a slow machine (clamped realDt) can't make it fire before the real cue.
const DIVE_FALLBACK = 1.0;

const _camPos = new THREE.Vector3();
const _camQuat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _lis = new THREE.Vector3();

export class AudioEngine {
  constructor(game) {
    this.game = game;
    this.ready = false;
    this.ctx = null;
    this.volume = 0.85;
    this.muted = false;
    this.mode = 'off';
    this._unsubs = [];
    // enemy → { wake, lastPass, seen, tele, cluster, teleEnd, teleSize, hold, frozenLeft }
    // (tele / hold: the telegraph sting and its held tail; teleEnd: audio time the
    // sting peaks; frozenLeft: teleEnd − now when play froze mid-wind-up, else null)
    this._enemies = new Map();
    this._killed = new WeakSet();
    this._timers = [];
    this._hurtDip = 0;
    this._roarDuck = 0;
    this._exertion = 0;
    this._lastAttack = { type: null, time: -10 };
    this._lastStabHit = -10;
    this._lastHitBite = -10; // audio time of the last bite crunch played for a player:hit
    this._pendingHurt = 0; // 0 none / 1 light / 2 heavy: this frame's hurt grunt (see update)
    this._deathVoices = []; // the death sting + its heartbeats (released by the next attempt)
    this._miss = { f: 0, t: 0 }; // mirrored parry spam fatigue, game time of the last whiff
    this._grab = null;
    // active: a charge is in progress; tier: last player:heavyCharge level
    // (null = no event yet); since / held: game seconds since that event /
    // since the charge started; level: last whine control (0..1, never falls).
    this._charge = { voice: null, active: false, tier: null, since: 0, held: 0, level: 0, readyPinged: false };
    this._slow = false;
    // fallbackAt: game time (realElapsed) of the no-'dive'-cue fallback, or null
    this._intro = { ring: null, ringStart: 0, pickupScheduled: false, dived: true, fallbackAt: null };
    this._frame = 0;
    this._lastWall = 0;
    this._warned = new Set();
    this._sweepEnemy = (st, enemy) => {
      if (st.seen !== this._frame) {
        st.wake?.release(1);
        this._cancelTelegraph(st);
        this._enemies.delete(enemy);
      }
    };
    this._wire();
    this._installDomHooks();
  }

  // -------------------------------------------------------------------------
  // Contract
  // -------------------------------------------------------------------------

  /** Create / resume the AudioContext. Call from a user gesture. Idempotent. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume?.().catch?.(() => {});
      return;
    }
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) return;
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      this._warn('ctx', 'AudioContext unavailable', err);
      return;
    }
    try {
      const q = this.game.quality ?? 'high';
      this.ctx = ctx;
      this.mixer = createMixer(ctx, { quality: q });
      this.pool = new VoicePool(ctx, this.mixer, { maxVoices: q === 'low' ? 24 : q === 'medium' ? 34 : 44, hrtf: q === 'high' });
      this.musicPool = new VoicePool(ctx, this.mixer, { maxVoices: q === 'low' ? 28 : 44, hrtf: false, label: 'music' });
      this.music = new Music(ctx, this.mixer, this.musicPool, { quality: q });
      this.ambience = new Ambience(ctx, this.mixer, this.pool);
      const now = ctx.currentTime;
      this.mixer.master.jump(0, now);
      this.mixer.master.set(this._masterTarget(), now + 0.05, 0.25);
      ctx.resume?.().catch?.(() => {});
      prewarmBuffers(ctx);
      this.ready = true;
      this._syncMode();
    } catch (err) {
      this._warn('unlock', 'audio graph build failed', err);
      this.ready = false;
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
  }

  /** Play a named sound (see PLAY NAMES above). Silent no-op before unlock. */
  play(name, opts = {}) {
    if (!this.ready) return null;
    const def = SOUNDS[name];
    if (!def) return null;
    try {
      return (def.internal ? this.musicPool : this.pool).play(name, opts ?? {});
    } catch (err) {
      this._warn(`play:${name}`, `play("${name}") failed`, err);
      return null;
    }
  }

  update(dt) {
    if (!this.ready) return;
    const g = this.game;
    const now = this.ctx.currentTime;
    const wall = performance.now();
    const wallDt = this._lastWall ? Math.min(0.5, (wall - this._lastWall) / 1000) : 1 / 60;
    this._lastWall = wall;
    const rdt = finite(g.time?.realDt, wallDt);
    const gdt = Math.max(0, finite(dt, 0)); // scaled game time (0 while paused)
    this._frame++;

    this._updateListener();
    this._runTimers(now);
    this._syncMode();
    if (this._pendingHurt) {
      // Every player:hit of this frame, as one grunt (a grab timeout lands the last
      // grind tick and the fail bite together).
      this.play('playerHurt', { heavy: this._pendingHurt > 1 });
      this._pendingHurt = 0;
    }

    const state = g.state;
    // Intro: the dive fallback (only if the Director's cinematic 'dive' never came).
    const I = this._intro;
    if (I.fallbackAt != null && !I.dived && state === 'intro' && finite(g.time?.realElapsed, 0) >= I.fallbackAt) this._dive();
    const inPlay = state === 'playing' || state === 'paused' || state === 'transition' || state === 'dead';
    const paused = state === 'paused';
    const p = g.player;
    // During the death beat (player:death → Director's 'dead' a moment later)
    // the game is still 'playing': nothing may keep a racing heart or
    // breathing going over the death sting.
    const alive = p?.alive !== false;
    const health01 = p && p.maxHealth > 0 ? clamp(finite(p.health, p.maxHealth) / p.maxHealth, 0, 1) : 1;
    const lowHealth = inPlay && state !== 'dead' && alive ? smoothstep(0.45, 0.12, health01) : 0;
    const danger = inPlay ? clamp(finite(g.danger), 0, 1) : 0;
    const grabbing = !!this._grab;

    this._hurtDip *= Math.exp(-rdt * 3);
    this._roarDuck *= Math.exp(-rdt * 0.8);
    this._exertion *= Math.exp(-rdt * 0.5);

    // Water muffling: tighter with danger, while held in jaws, in slow-mo,
    // paused, and a sharp dip on every hit taken. Slow-mo runs at a time
    // scale of 0.2-0.35; hitstops (≈0.02 for 0.03-0.16 s on every landed or
    // taken blow) must not count, or they dull exactly the impacts they
    // punctuate — so a hitstop frame keeps the previous slow-mo state.
    const ts = finite(g.time?.timeScale, 1);
    if (ts > 0.05) this._slow = ts < 0.6;
    const slow = !paused && this._slow;
    let cutoff = WATER_CUTOFF - 480 * danger;
    if (grabbing) cutoff = Math.min(cutoff, 800);
    if (slow) cutoff = Math.min(cutoff, 620);
    if (paused) cutoff = 520;
    cutoff *= 1 - 0.72 * this._hurtDip;
    this.mixer.setWaterCutoff(Math.max(180, cutoff), now, this._hurtDip > 0.3 ? 0.03 : 0.12);
    this.mixer.master.set(this._masterTarget() * (paused ? 0.6 : 1), now, 0.2);
    // The heartbeat lives on the body bus, which the music duck never reaches.
    this.mixer.bodyLevel?.set(paused ? BODY_PAUSED : BODY_LEVEL, now, 0.2);
    const lift = state === 'playing' && alive ? smoothstep(0.3, 0.8, danger) : 0;
    this.mixer.musicLevel?.set(MUSIC_LEVEL * 10 ** ((MUSIC_LIFT_DB * lift) / 20), now, 0.5);

    const duck = (paused ? 0.35 : 1) * (1 - 0.45 * this._roarDuck);
    const lookahead = clamp(wallDt * 2.5 + 0.06, 0.15, 0.6);
    this.music.update(now, rdt, { danger, lowHealth, grab: grabbing, duck }, lookahead);

    this.ambience.update(now, rdt, {
      level: this._ambienceLevel(state, danger),
      danger,
      breathing: alive && (state === 'playing' || state === 'transition' || (state === 'intro' && this._intro.dived)),
      exertion: clamp(this._exertion, 0, 1),
      lx: _lis.x,
      ly: _lis.y,
      lz: _lis.z,
      wreck: this._wreckPosition(),
    });

    this._updateEnemies(now);
    this._updateCharge(now, gdt);
    this._updateGrab(now, rdt, paused);
    this.pool.update(now);
    this.musicPool.update(now);
  }

  // -------------------------------------------------------------------------
  // Extras
  // -------------------------------------------------------------------------

  setVolume(v) {
    this.volume = clamp(finite(v, this.volume), 0, 1);
  }

  setMuted(m) {
    this.muted = !!m;
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  debugInfo() {
    return {
      ready: this.ready,
      ctxState: this.ctx?.state ?? null,
      time: this.ctx ? +this.ctx.currentTime.toFixed(3) : 0,
      mode: this.mode,
      musicTension: this.music ? +this.music.tension.toFixed(3) : 0,
      voices: this.pool?.voices.length ?? 0,
      activeVoices: this.pool ? this.pool.activeCount() : 0,
      maxVoices: this.pool?.maxVoices ?? 0,
      musicVoices: this.musicPool?.voices.length ?? 0,
      enemiesTracked: this._enemies.size,
      sfxStats: this.pool ? { ...this.pool.stats } : null,
      musicStats: this.musicPool ? { ...this.musicPool.stats } : null,
    };
  }

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this._onGesture, true);
      window.removeEventListener('keydown', this._onGesture, true);
      document.removeEventListener('pointerover', this._onOver);
      document.removeEventListener('click', this._onClick);
      document.removeEventListener('visibilitychange', this._onVis);
    }
    this.pool?.disposeAll();
    this.musicPool?.disposeAll();
    this.music?.dispose();
    this.ambience?.dispose();
    this.ctx?.close?.().catch?.(() => {});
    this.ready = false;
    this.ctx = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  _masterTarget() {
    return this.muted || this.game.debug?.mute ? 0 : this.volume;
  }

  _warn(key, msg, err) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(`[audio] ${msg}`, err);
  }

  _now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Run `fn` at audio-clock time `at` (checked every update). */
  _at(at, fn) {
    this._timers.push({ at, fn });
  }

  _runTimers(now) {
    const list = this._timers;
    if (!list.length) return;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.at <= now) {
        try {
          t.fn();
        } catch (err) {
          this._warn('timer', 'scheduled audio callback failed', err);
        }
      } else list[w++] = t;
    }
    list.length = w;
  }

  _deriveMode() {
    const g = this.game;
    switch (g.state) {
      case 'title':
        return 'title';
      case 'intro':
        return 'intro';
      case 'transition':
        return 'breather';
      case 'dead':
        return 'dead';
      case 'victory':
        return 'victory';
      case 'playing':
      case 'paused': {
        // Killed: the Director keeps 'playing' for the death beat; the score
        // goes dark at once (no combat pulse / heartbeat under the sting).
        if (g.player && g.player.alive === false) return 'dead';
        let alive = 0;
        let boss = false;
        const list = g.enemies?.enemies;
        if (list) {
          for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (!e?.alive) continue;
            alive++;
            if (e.isBoss || e.type === 'megalodon') boss = true;
          }
        }
        return boss ? 'boss' : alive ? 'combat' : 'breather';
      }
      default:
        return 'off';
    }
  }

  _syncMode() {
    const mode = this._deriveMode();
    if (mode === this.mode) return;
    this.mode = mode;
    this.music?.setMode(mode, this._now());
  }

  _ambienceLevel(state, danger) {
    switch (state) {
      case 'title':
        return 0.85;
      case 'intro':
        return this._intro.dived ? 1 : 0.1;
      case 'playing':
        return 1 - 0.3 * danger;
      case 'paused':
        return 0.6;
      case 'transition':
        return 1;
      case 'dead':
        return 0.7;
      case 'victory':
        return 0.85;
      default:
        return 0;
    }
  }

  _wreckPosition() {
    const env = this.game.env;
    const w = env?.wreckPosition ?? env?.wreck?.position ?? null;
    return w && Number.isFinite(w.x) ? w : null;
  }

  _updateListener() {
    const g = this.game;
    const cam = g.camera;
    if (!cam) return;
    cam.getWorldPosition(_camPos);
    cam.getWorldQuaternion(_camQuat);
    _fwd.set(0, 0, -1).applyQuaternion(_camQuat);
    _up.set(0, 1, 0).applyQuaternion(_camQuat);
    _lis.copy(_camPos);
    const s = g.state;
    const pp = g.player?.position;
    if (pp && (s === 'playing' || s === 'paused' || s === 'dead' || s === 'transition')) {
      _lis.lerp(pp, 0.5);
    }
    if (!Number.isFinite(_lis.x + _lis.y + _lis.z + _fwd.x + _fwd.y + _fwd.z + _up.x + _up.y + _up.z)) return;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = _lis.x;
      L.positionY.value = _lis.y;
      L.positionZ.value = _lis.z;
      L.forwardX.value = _fwd.x;
      L.forwardY.value = _fwd.y;
      L.forwardZ.value = _fwd.z;
      L.upX.value = _up.x;
      L.upY.value = _up.y;
      L.upZ.value = _up.z;
    } else {
      L.setPosition?.(_lis.x, _lis.y, _lis.z);
      L.setOrientation?.(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
    this.pool.setListener(_lis.x, _lis.y, _lis.z, _fwd.x, _fwd.y, _fwd.z);
  }

  _size(enemy) {
    const len = finite(enemy?.length, 0);
    if (len > 0) return clamp(len / 6, 0.5, 3);
    return enemy?.type === 'megalodon' ? 2.7 : enemy?.type === 'tiger' ? 0.75 : 1;
  }

  _enemyState(enemy) {
    let st = this._enemies.get(enemy);
    if (!st) {
      st = { wake: null, lastPass: -100, seen: this._frame, tele: null, cluster: null, teleEnd: null, teleSize: 1, hold: null, frozenLeft: null };
      this._enemies.set(enemy, st);
    }
    return st;
  }

  // Per-shark continuous wake + close swim-by whooshes + telegraph tracking.
  _updateEnemies(now) {
    const list = this.game.enemies?.enemies;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e?.position) continue;
        const st = this._enemyState(e);
        st.seen = this._frame;
        if (st.tele || st.cluster || st.teleEnd != null || st.frozenLeft != null) this._trackTelegraph(st, e, now);
        if (st.wake && !st.wake.loop) st.wake = null; // stolen by the pool
        if (e.alive && this.game.state !== 'title') {
          const size = this._size(e);
          // The megalodon must carry at circling distance (25-30 m): a
          // reference distance proportional to its size and a gentle rolloff.
          const big = size > 1.8;
          if (!st.wake) st.wake = this.play('wake', big ? { follow: e, size, ref: 5 * size, rolloff: 0.6 } : { follow: e, size });
          const speed = e.velocity ? e.velocity.length() : 0;
          st.wake?.ctl?.set(speed / (big ? 9 : 12), now);
          const d = e.position.distanceTo(_lis);
          const passR = 5 + finite(e.length, 5) * 0.7;
          if (d < passR && speed > 4 && now - st.lastPass > 3.5) {
            st.lastPass = now;
            this.play('swimBy', big ? { follow: e, size, ref: 5 * size, rolloff: 0.6 } : { follow: e, size });
          }
        } else if (st.wake) {
          st.wake.release(1.5);
          st.wake = null;
        }
      }
    }
    this._enemies.forEach(this._sweepEnemy);
  }

  // A telegraph sting / score cluster swells into the strike. The sting holds
  // its peak until the strike really comes ('attack': cut, the lunge takes over;
  // the cluster resolves on its own). A wind-up that outlasts the sting's peak
  // (SharkAI holds a finished one while another shark's hit lands; slow-mo)
  // hands over to the 'telegraphHold' tail. Any other exit (eye stab, heavy hit,
  // death, play stopping) releases everything at once. Frozen mid-wind-up (pause
  // menu): released too, with the time still to go kept for the resume.
  _trackTelegraph(st, e, now) {
    const s = e.ai?.state ?? e.state;
    if (e.alive !== false && s === 'telegraph') {
      if (this.game.state !== 'playing') {
        // No tension drone under the pause menu — and the sting / cluster are
        // scheduled on the audio clock, which keeps running: left alone they
        // would swell and resolve in the pause, leaving the rest of the wind-up
        // silent (and the held tail's HOLD_MAX run out) after it.
        if (st.frozenLeft == null && st.teleEnd != null) {
          st.frozenLeft = st.teleEnd - now; // ≤ 0: already past the peak (held)
          st.tele?.release(0.15);
          st.hold?.release(0.15);
          st.cluster?.release(0.2);
          st.tele = null;
          st.hold = null;
          st.cluster = null;
        }
        return;
      }
      if (st.frozenLeft != null) this._resumeTelegraph(st, e, now);
      if (st.hold && st.hold.ended) st.hold = null; // stolen by the pool
      const late = now - st.teleEnd;
      if (!st.hold && late >= HOLD_GRACE && late < HOLD_MAX) {
        st.hold = this.play('telegraphHold', { follow: e, size: st.teleSize });
      } else if (st.hold && late >= HOLD_MAX) {
        st.hold.release(0.3);
        st.hold = null;
        st.teleEnd = -Infinity; // stuck: don't re-arm
      }
      return;
    }
    if (e.alive !== false && s === 'attack') {
      // the strike: cut the sting / held tail now (on time, that is its peak)
      st.tele?.release(0.05);
      st.hold?.release(0.06);
      st.tele = null;
      st.hold = null;
      st.cluster = null;
      st.teleEnd = null;
      st.frozenLeft = null;
      return;
    }
    this._cancelTelegraph(st);
  }

  /**
   * Back from a pause mid-wind-up (st.frozenLeft = the sting's time to peak when
   * play froze): pick the telegraph up where it stopped. Enough wind-up left →
   * a fresh sting (and score cluster) swelling over the rest; (nearly) at or past
   * the peak → the held tail at once, with HOLD_MAX still counted from the peak.
   */
  _resumeTelegraph(st, e, now) {
    const left = st.frozenLeft;
    st.frozenLeft = null;
    if (!(left > -HOLD_MAX)) {
      st.teleEnd = -Infinity; // held too long already (or stuck): stays quiet
      return;
    }
    if (left >= TELE_RESUME_MIN) {
      st.tele = this.play('telegraph', { follow: e, duration: left, size: st.teleSize });
      st.cluster = this.music.telegraph(left, now);
      st.teleEnd = (st.tele ? st.tele.t0 : now) + left;
      return;
    }
    st.teleEnd = now + left;
    st.hold = this.play('telegraphHold', { follow: e, size: st.teleSize });
  }

  _cancelTelegraph(st) {
    st.tele?.release(0.08);
    st.hold?.release(0.08);
    st.cluster?.release(0.1);
    st.tele = null;
    st.hold = null;
    st.cluster = null;
    st.teleEnd = null;
    st.frozenLeft = null;
  }

  /** Fade out the death sting and the heartbeats after it (those not yet started never sound). */
  _releaseDeath(fade) {
    const dv = this._deathVoices;
    for (let i = 0; i < dv.length; i++) dv[i]?.release(fade);
    dv.length = 0;
  }

  /**
   * Spam fatigue for 'parryMiss': the whiff event's own `fatigue` when Player
   * sends one, else the mirror of Player's (this whiff included).
   */
  _missFatigue(sent) {
    if (Number.isFinite(sent)) return clamp(sent, 0, MISS_FATIGUE_MAX);
    const m = this._miss;
    const t = finite(this.game.time?.elapsed, 0);
    const drained = Math.max(0, m.f - MISS_FATIGUE_DECAY * Math.max(0, t - m.t));
    m.f = Math.min(MISS_FATIGUE_MAX, drained + 1);
    m.t = t;
    return m.f;
  }

  /** End the charge (released / cancelled / interrupted): whine off, progress reset. */
  _stopCharge(fade = 0.1) {
    const c = this._charge;
    c.voice?.release(fade);
    c.voice = null;
    c.active = false;
    c.tier = null;
    c.since = 0;
    c.held = 0;
    c.level = 0;
    c.readyPinged = false;
  }

  _chargeFull() {
    const c = this._charge;
    if (c.readyPinged) return;
    c.readyPinged = true;
    this.play('chargeReady');
  }

  _updateCharge(now, gdt) {
    const c = this._charge;
    const g = this.game;
    const p = g.player;
    const held = p?.state === 'heavyCharge' && p.alive !== false && (g.state === 'playing' || g.state === 'paused');
    if (!held) {
      if (c.active || c.voice) this._stopCharge(0.12);
      return;
    }
    c.active = true;
    if (g.state === 'paused') {
      // Frozen mid-charge: silence the whine but keep the progress.
      if (c.voice) {
        c.voice.release(0.15);
        c.voice = null;
      }
      return;
    }
    if (c.voice && !c.voice.loop) c.voice = null; // stolen by the pool
    if (!c.voice) {
      c.voice = this.play('heavyCharge');
      if (!c.voice) return;
    }
    c.held += gdt;
    c.since += gdt;
    // Whine control 0..1 = tier / 3, gliding toward the next tier over the
    // known gap so it reaches it just as the Player's event arrives (and
    // holds there if the event is late, e.g. in slow-mo).
    let level;
    if (c.tier == null) level = clamp(c.held / CHARGE_FULL, 0, 1); // no events: time fallback
    else if (c.tier >= 3) level = 1;
    else {
      const base = Math.floor(c.tier);
      level = Math.min((base + 1) / 3, (c.tier + c.since / CHARGE_GAPS[base]) / 3);
    }
    if (level < c.level) level = c.level; // never glides back down
    c.level = level;
    c.voice.ctl?.set(level, now);
    if (c.tier == null && level >= 1) this._chargeFull();
  }

  _updateGrab(now, rdt, paused) {
    const gr = this._grab;
    if (!gr) return;
    const g = this.game;
    const combat = g.combat;
    if (!paused) gr.elapsed += rdt;
    // Safety net if grab:end was missed (paused time does not count).
    if ((combat && 'grab' in combat && !combat.grab && gr.elapsed > 0.6) || gr.elapsed > 12 || g.state === 'dead' || g.player?.alive === false) {
      this._endGrab(false, true);
      return;
    }
    // Frozen mid-grab: no thrashing, and the struggle loop drops right back.
    if (paused !== gr.paused) {
      gr.paused = paused;
      const v = gr.voice;
      if (v && !v.ended && !v.released) {
        v.level = paused ? gr.level * 0.2 : gr.level; // release() fades from v.level
        v.out.gain.setTargetAtTime(v.level, now, 0.12);
      }
    }
    if (paused) {
      gr.nextThrash = now + 0.2;
      return;
    }
    if (now >= gr.nextThrash) {
      gr.nextThrash = now + rand(0.16, 0.42);
      const mouth = this._mouth(gr.enemy);
      this.play('thrash', mouth ? { position: mouth } : {});
    }
  }

  _endGrab(success, silent = false) {
    const gr = this._grab;
    if (!gr) return;
    gr.voice?.release(success ? 0.15 : 0.3);
    this._grab = null;
    if (silent) return;
    if (success) {
      this.play('grabBreak');
      return;
    }
    // Failed escape: the jaws crush down and spit 老公 out. The hurt grunt
    // comes from the player:hit Combat emits just before (still held).
    const mouth = this._mouth(gr.enemy);
    this.play('bite', mouth ? { position: mouth, gain: 1.1 } : { gain: 1.1 });
    this.play('ram', mouth ? { position: mouth, gain: 0.5 } : { gain: 0.5 });
  }

  _mouth(enemy) {
    if (!enemy) return null;
    try {
      const m = enemy.getMouthPosition?.();
      if (m && Number.isFinite(m.x)) return [m.x, m.y, m.z];
    } catch {
      /* ignore */
    }
    const p = enemy.position;
    return p ? [p.x, p.y, p.z] : null;
  }

  _onKill(enemy) {
    if (!enemy || this._killed.has(enemy)) return;
    this._killed.add(enemy);
    this.play('killSting');
    const p = enemy.position;
    this.play('enemyDeath', p ? { position: [p.x, p.y, p.z], size: this._size(enemy) } : { size: this._size(enemy) });
    const st = this._enemies.get(enemy);
    if (st) {
      this._cancelTelegraph(st);
      st.wake?.release(1.5);
      st.wake = null;
    }
  }

  // --- intro: phone ring → pickup → (subtitles) → dive ---
  _pickup() {
    const I = this._intro;
    if (!I.ring) return;
    I.ring.release(0.03);
    I.ring = null;
    this.play('phonePickup');
  }

  _dive() {
    const I = this._intro;
    I.fallbackAt = null;
    if (I.dived) return;
    I.dived = true;
    if (I.ring) {
      I.ring.release(0.05);
      I.ring = null;
    }
    this.play('diveSplash');
    this.play('diveBubbles', { delay: 0.22 });
  }

  _wire() {
    const ev = this.game.events;
    const on = (name, fn) => this._unsubs.push(ev.on(name, (p) => this.ready && fn(p ?? {})));

    on('player:attack', ({ type, combo }) => {
      this._exertion += 0.15;
      if (type === 'heavy') {
        this._stopCharge(0.05);
        this.play('slashHeavy');
      } else if (type !== 'grabStab') {
        this.play('slash', { combo: finite(combo, 1) });
      }
    });

    // level: 0 at charge start, then tiers 1 / 2 / 3 (26 / 40 / 60 damage).
    on('player:heavyCharge', ({ level }) => {
      if (!Number.isFinite(level)) return;
      const c = this._charge;
      const tier = clamp(level, 0, 3);
      if (tier <= 0 || c.tier == null || tier < c.tier) {
        // a new charge (the whine voice itself starts in _updateCharge)
        c.voice?.release(0.05);
        c.voice = null;
        c.held = 0;
        c.level = 0;
        c.readyPinged = false;
      }
      c.active = true;
      c.tier = tier;
      c.since = 0;
      if (tier >= 3) this._chargeFull();
      else if (tier >= 1) this.play('chargeTier', { tier });
    });

    on('player:dodge', () => {
      this._exertion += 0.5;
      this.play('dodge');
    });

    on('player:parry', (p) => {
      if (p.success) {
        this._miss.f = 0; // a clean parry forgives the spam fatigue (as Player does)
        const pos = this._mouth(p.enemy) ?? this._playerPos();
        this.play('parry', pos ? { position: pos } : {});
        this.music.accent(this._now());
      } else if (p.whiff) {
        this.play('parryMiss', { fatigue: this._missFatigue(p.fatigue) });
      } else if (p.attempt) {
        this.play('parryRaise');
      }
    });

    on('player:perfectDodge', ({ enemy }) => {
      this.play('perfectDodge');
      if (enemy) this.play('jawSnap', { follow: enemy, delay: 0.05 });
    });

    on('player:hit', ({ sourcePosition, heavy }) => {
      const now = this._now();
      const la = this._lastAttack;
      const type = now - la.time < 2.5 ? la.type : heavy ? 'ram' : 'bite';
      const sp = sourcePosition && Number.isFinite(sourcePosition.x) ? [sourcePosition.x, sourcePosition.y, sourcePosition.z] : this._playerPos();
      const at = sp ? { position: sp } : {};
      if (!this._grab) {
        if (type === 'ram') this.play('ram', at);
        else if (type === 'tail') this.play('tailHit', at);
        else if (type === 'shockwave') this.play('ram', { ...at, gain: 0.7 });
        else if (this.play('bite', at)) this._lastHitBite = now;
      }
      // The grunt is played once per frame in update() (the heaviest hit wins).
      this._pendingHurt = Math.max(this._pendingHurt, heavy ? 2 : 1);
      this._hurtDip = Math.max(this._hurtDip, heavy ? 1 : 0.7);
    });

    on('player:death', () => {
      this._stopCharge(0.05);
      if (this._grab) {
        // killed in the jaws: they close one last time
        const mouth = this._mouth(this._grab.enemy);
        this.play('bite', mouth ? { position: mouth } : {});
      }
      this._endGrab(false, true);
      this._syncMode(); // → 'dead' now, not on the next frame
      // The score schedules heartbeats up to its look-ahead (≤ 0.6 s) ahead:
      // cancel those that haven't started, or one lands over the death sting.
      const now = this._now();
      const mv = this.musicPool.voices;
      for (let i = 0; i < mv.length; i++) if (mv[i].name === 'heartbeat' && mv[i].t0 > now) mv[i].release(0.01);
      this._releaseDeath(0.3); // a previous death's sting, if nothing ended it
      const dv = this._deathVoices;
      dv.push(this.play('death'));
      dv.push(this.play('heartbeat', { delay: 0.35, vel: 0.8, bpm: 70 }));
      dv.push(this.play('heartbeat', { delay: 1.6, vel: 0.5, bpm: 50 }));
      dv.push(this.play('heartbeat', { delay: 3.3, vel: 0.28, bpm: 40 }));
      this._hurtDip = 1;
    });

    on('enemy:spawn', ({ enemy }) => {
      if (enemy && (enemy.isBoss || enemy.type === 'megalodon')) {
        // Something enormous announces itself from the dark before you see it.
        this.play('roar', { follow: enemy, size: 1.3, length: 0.8, gain: 0.55, delay: 2 });
      }
    });

    on('enemy:telegraph', ({ enemy, type, duration }) => {
      const size = this._size(enemy) * (type === 'shockwave' ? 1.3 : 1);
      const d = clamp(finite(duration, 0.8), 0.3, 2.5);
      const now = this._now();
      const tele = this.play('telegraph', enemy ? { follow: enemy, duration: d, size } : { duration: d, size });
      const cluster = this.music.telegraph(d, now);
      if (!enemy) return;
      // Kept per shark so an interrupted wind-up can be released and a held one
      // sustained (_trackTelegraph).
      const st = this._enemyState(enemy);
      this._cancelTelegraph(st);
      st.tele = tele;
      st.cluster = cluster;
      st.teleEnd = (tele ? tele.t0 : now) + d;
      st.teleSize = size;
    });

    // Combat's last-instant strike cue (enemy:strike {enemy, type, eta}): the
    // rush of water ahead of the jaws / snout, swelling into the contact — the
    // audible half of the HUD's strike flash (parry now). Bites and rams.
    on('enemy:strike', ({ enemy, type, eta }) => {
      if (!enemy || (type && type !== 'bite' && type !== 'ram')) return;
      const at = this._mouth(enemy);
      const opts = { kind: type === 'ram' ? 'ram' : 'bite', size: this._size(enemy), eta: clamp(finite(eta, 0.3), STRIKE_ETA_MIN, STRIKE_ETA_MAX) };
      if (at) opts.position = at;
      this.play('strike', opts);
    });

    on('enemy:attack', ({ enemy, type }) => {
      this._lastAttack.type = type;
      this._lastAttack.time = this._now();
      if (!enemy) return;
      const size = this._size(enemy);
      if (type === 'bite' || type === 'ram') this.play('lunge', { follow: enemy, size });
      else if (type === 'tail') this.play('tail', { follow: enemy });
      else if (type === 'shockwave') {
        const p = enemy.position;
        this.play('shockwave', p ? { position: [p.x, p.y, p.z] } : {});
      }
    });

    on('enemy:roar', ({ enemy }) => {
      this.play('roar', enemy ? { follow: enemy, size: this._size(enemy) > 1.8 ? 1.3 : 1 } : {});
      this.music.roar(this._now());
      this._roarDuck = 1;
    });

    on('enemy:hit', ({ enemy, part, position, critical, killed, attackType }) => {
      const p = position && Number.isFinite(position.x) ? position : enemy?.position;
      const at = p ? [p.x, p.y, p.z] : null;
      if (attackType === 'grabStab') this._lastStabHit = this._now();
      if (critical || part === 'eye' || part === 'gills') this.play('critHit', at ? { position: at } : {});
      else {
        const intensity = attackType === 'heavy' ? 1.45 : 1;
        this.play('fleshHit', at ? { position: at, intensity } : { intensity });
      }
      if (killed) this._onKill(enemy);
    });

    on('enemy:death', ({ enemy }) => this._onKill(enemy));

    on('grab:start', ({ enemy }) => {
      const now = this._now();
      this._endGrab(false, true);
      this._stopCharge(0.05);
      const mouth = this._mouth(enemy);
      // Combat emits the bite's player:hit just before grab:start: that one
      // already crunched (it happens in the same frame).
      if (now - this._lastHitBite > 0.1) this.play('bite', mouth ? { position: mouth } : {});
      const voice = this.play('grabStruggle');
      // elapsed: real seconds held, excluding pauses (safety net); level: the
      // loop's own level, restored after a pause duck.
      this._grab = { voice, value: 0, enemy, elapsed: 0, paused: false, level: voice?.level ?? 1, nextThrash: now + 0.2 };
      this._hurtDip = Math.max(this._hurtDip, 0.8);
    });

    on('grab:progress', ({ value }) => {
      const gr = this._grab;
      if (!gr) return;
      const v = clamp(finite(value, gr.value), 0, 1);
      if (v > gr.value + 0.001 && this._now() - this._lastStabHit > 0.12) this.play('grabStab');
      gr.value = v;
      gr.voice?.ctl?.set(v, this._now());
    });

    on('grab:end', ({ success, interrupted, enemy }) => {
      // Non-outcome ends (wave restart, shark removed, player dead) release
      // the loop silently. Combat flags them with `interrupted`; the checks
      // below cover the same cases if the flag is missing.
      const list = this.game.enemies?.enemies;
      const gone = !!enemy && (enemy.alive === false || (Array.isArray(list) && !list.includes(enemy)));
      const silent = !!interrupted || (!success && (gone || this.game.player?.alive === false || this.game.state !== 'playing'));
      this._endGrab(!!success, silent);
    });

    on('wave:start', ({ wave, retry }) => {
      // A new attempt: the death sting (if any) gives way to it, and the parry
      // fatigue mirror starts fresh (Player resets / has long drained its own).
      this._releaseDeath(DEATH_RELEASE);
      this._miss.f = 0;
      if (retry) {
        // Restarted mid-fight (death screen / pause menu): drop the old
        // grab, charge and boss-phase drum density.
        this._endGrab(false, true);
        this._stopCharge(0.05);
        if (this.music) this.music.phase = 0;
      }
      this.play('waveStart', { boss: !!wave?.boss });
    });

    on('wave:clear', () => this.play('waveClear', { delay: 0.6 }));

    on('game:victory', () => {
      this._releaseDeath(DEATH_RELEASE); // died in the last breather: the retry wins
      this.play('victory', { delay: 0.3 });
    });

    on('game:state', ({ from, to }) => {
      this._syncMode();
      const I = this._intro;
      if ((from === 'intro') !== (to === 'intro')) I.fallbackAt = null;
      if (from === 'intro' && to !== 'intro') {
        // Skipped intro (→ 'transition' wave card) or a missed dive cue: still go under.
        if (!I.dived && (to === 'playing' || to === 'transition')) {
          I.dived = true;
          this.play('diveBubbles');
        }
        if (I.ring) {
          I.ring.release(0.1);
          I.ring = null;
        }
      }
      if (to === 'intro' && from !== 'paused') I.dived = false;
      if (to !== 'playing' && to !== 'paused') this._stopCharge(0.1);
    });

    on('cinematic', ({ name }) => {
      const I = this._intro;
      if (name === 'intro') {
        I.ring?.release(0.05);
        I.ring = this.play('phoneRing', { rings: 4 });
        I.ringStart = this._now();
        I.pickupScheduled = false;
        I.dived = false;
        I.fallbackAt = null;
      } else if (name === 'dive' || name === 'introDive') {
        this._dive();
      } else if (name === 'pickup' || name === 'phonePickup') {
        this._pickup();
      }
    });

    on('subtitle', (s) => {
      const now = this._now();
      const I = this._intro;
      if (I.ring && !I.pickupScheduled) {
        // Let the phone ring at least one full cycle before it is picked up.
        I.pickupScheduled = true;
        this._at(Math.max(now, I.ringStart + 2.1), () => this._pickup());
      } else {
        this.play('subtitleTick');
      }
      // The splash belongs to the Director's cinematic 'dive' (veil lift + camera
      // plunge). Only if that cue never comes: dive DIVE_FALLBACK s after 老公's
      // line ends, on the game clock the Director's timeline runs on (the audio
      // clock runs ahead of it when slow frames clamp realDt).
      const speaker = String(s.speaker ?? '');
      if (this.game.state === 'intro' && !I.dived && speaker === '老公') {
        I.fallbackAt = finite(this.game.time?.realElapsed, 0) + clamp(finite(s.duration, 2.5), 0.5, 8) + DIVE_FALLBACK;
      }
    });

    // The whale pass starts on the wave clear: let the kill stinger and the
    // clear chord ring out first, then follow the whale along its ~150 m arc.
    on('ambient:whale', (p) => {
      const live = p.position && Number.isFinite(p.position.x) ? p.position : this.game.ambient?.whale?.position;
      if (live && Number.isFinite(live.x)) this.play('whaleSong', { follow: live, delay: WHALE_SONG_DELAY });
      else {
        const a = rand(0, Math.PI * 2);
        this.play('whaleSong', { position: [_lis.x + Math.cos(a) * 80, _lis.y - 10, _lis.z + Math.sin(a) * 80], delay: WHALE_SONG_DELAY });
      }
    });
  }

  _playerPos() {
    const p = this.game.player?.position;
    return p && Number.isFinite(p.x) ? [p.x, p.y, p.z] : null;
  }

  _installDomHooks() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    // First gesture anywhere unlocks (and resumes a suspended context).
    this._onGesture = () => this.unlock();
    window.addEventListener('pointerdown', this._onGesture, true);
    window.addEventListener('keydown', this._onGesture, true);
    // UI hover / click sounds for interactive elements inside #ui-root.
    const uiTarget = (e) => {
      const el = e.target?.closest?.(UI_SELECTOR);
      return el && el.closest('#ui-root') && !el.disabled ? el : null;
    };
    this._onOver = (e) => {
      const el = uiTarget(e);
      if (el && !el.contains(e.relatedTarget)) this.play('uiHover');
    };
    this._onClick = (e) => {
      if (uiTarget(e)) this.play('uiClick');
    };
    document.addEventListener('pointerover', this._onOver);
    document.addEventListener('click', this._onClick);
    // Pause the audio clock while the tab is hidden (rAF stops too).
    this._onVis = () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend?.().catch?.(() => {});
      else this.ctx.resume?.().catch?.(() => {});
    };
    document.addEventListener('visibilitychange', this._onVis);
  }
}
