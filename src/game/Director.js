// Director — the game-flow state machine. See docs/DESIGN.md "Director".
//
// It is the ONLY module that calls game.setState(). Everything it schedules
// runs on a single Timeline driven by *real* time (so hitstop / slow-mo don't
// stretch title cards) that freezes while the game is paused.
//
//   boot ─► title ─► intro ─► transition ─► playing ⇄ paused
//                                 ▲            │
//                                 └─ breather ◄┤ (wave:clear, still 'playing')
//                                              ├─► dead ─► playing (retry)
//                                              └─► victory ─► transition (again)
//
// Every state has an exit, and a watchdog covers modules that forget to emit
// wave:clear / player:death, so the flow can never get stuck.
//
// Intro beats: the phone call plays over black (UI IntroVeil, dry audio);
// at INTRO_DIVE_AT the veil lifts on a white-water flash and a bubble burst
// while the camera plunges from just under the surface down to 老公
// (cinematics.introPose), arriving at the follow pose at FLOW.introLength.
import * as THREE from 'three';
import { WAVES, PLAYER } from '../core/config.js';
import { Timeline } from './Timeline.js';
import { PlayStats } from './PlayStats.js';

/** Intro time (s) of the cinematic 'dive' cue: the veil lifts, the camera plunges. */
export const INTRO_DIVE_AT = 8.6;

// Flow timings (seconds, real time). Exported so the UI can sync animations.
export const FLOW = {
  introSkipGrace: 0.6, // ignore skip presses this soon after the intro starts
  introDiveAt: INTRO_DIVE_AT,
  introLength: 11.6, // = INTRO_DIVE_AT + the 3 s plunge
  cardLength: 3.6, // wave title card ('transition')
  breather: 2.5, // after wave:clear, still 'playing' so blood drifts
  breatherBeforeBoss: 6.2, // longer: the sperm whale passes (AmbientLife)
  victoryDelay: 3.4, // after the last wave:clear
  deathDelay: 2.6, // player:death → 'dead' (let the sinking play; UI death card is delayed further)
  healBetweenWaves: 0.35, // fraction of maxHealth, from the 2nd wave on
  resumeGuard: 0.3, // a pause press this soon after pausing doesn't unpause
};

// Intro script: a dinner request from his wife, then the dive. Times in seconds.
const INTRO_SCRIPT = [
  { at: 0.55, speaker: '', text: '［ 手机震动 ］', duration: 1.7 },
  { at: 2.5, speaker: '老婆', text: '老公，我想吃鱼了。', duration: 3.3 },
  { at: 6.3, speaker: '老公', text: '好嘞，晚饭交给我！', duration: 2.3 },
];
// The dive beat: entry flash, a bubble burst in front of the camera, entry
// bubbles streaming past the camera while it plunges, and a short bubble
// trail from 老公 below. Times are seconds after INTRO_DIVE_AT.
const DIVE_FLASH = { color: 0xdfefff, intensity: 0.5, duration: 0.35 };
const DIVE_BURST = { ahead: 1.8, count: 140, opts: { speed: 4, size: 1.4, spread: 0.9 } };
const DIVE_WAKE = { ahead: 1.2, from: 0.1, until: 1.6, every: 0.1, count: 12, opts: { speed: 2.2, size: 1.2, spread: 0.5 } };
const DIVE_TRAIL = { from: 0, until: 1.5, every: 0.1, count: 5, opts: { speed: 1.2, size: 1.0, spread: 0.12 } };

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class Director {
  constructor(game) {
    this.game = game;
    this.waveIndex = 0;
    this.stats = new PlayStats();
    this.timeline = new Timeline();

    this.stateTime = 0; // seconds (real) since the last state change, pauses excluded
    // The last intro was cut short (skip, or a restart from inside it): the
    // camera jumps, so UI dips to black; a played-out intro hands over seamlessly.
    this.introSkipped = false;
    this.waveCleared = false; // current wave's wave:clear has been handled
    this.dying = false; // player:death received, 'dead' not reached yet

    this._startIndex = 0;
    this._pausedAt = -Infinity;
    this._pauseOnPlay = null; // 'key' | 'lock' — pause requested during intro/transition
    this._watch = { allDead: 0, playerDown: 0, empty: 0, respawned: false };

    const ev = game.events;
    ev.on('game:state', () => {
      this.stateTime = 0;
    });
    ev.on('wave:clear', ({ index } = {}) => this._onWaveClear(index));
    ev.on('player:death', () => this._onPlayerDeath());
    ev.on('input:pointerlock', ({ locked } = {}) => this._onPointerLock(locked));

    // ---- stats ----
    const s = this.stats;
    ev.on('enemy:hit', (e = {}) => {
      s.damage += Math.max(0, +e.damage || 0);
      s.hits++;
      if (e.critical) s.criticals++;
    });
    ev.on('enemy:death', () => {
      s.kills++;
    });
    ev.on('player:parry', (e = {}) => {
      if (e.success) s.parries++;
    });
    ev.on('player:perfectDodge', () => {
      s.perfectDodges++;
    });
    ev.on('grab:start', () => {
      s.grabs++;
    });
    ev.on('grab:end', (e = {}) => {
      if (e.success) s.grabsEscaped++;
    });
    ev.on('player:hit', (e = {}) => {
      s.damageTaken += Math.max(0, +e.damage || 0);
    });
  }

  // ------------------------------------------------------------------ API

  get wave() {
    return WAVES[this.waveIndex];
  }

  /** Name of the running flow script ('intro', 'card', 'breather', 'dying', 'victory') or null. */
  get phase() {
    return this.timeline.name;
  }

  boot() {
    const g = this.game;
    if (g.debug.autostart) this.startGame(g.debug.wave);
    else g.setState('title');
  }

  /**
   * Start a run at `index`. Plays the intro cinematic unless `?autostart`
   * (then it drops straight into combat) or `opts.skipIntro` (wave card only).
   */
  startGame(index = 0, opts = {}) {
    const g = this.game;
    index = this._clampWave(index);
    this._startIndex = index;
    this.stats.reset();
    this._pauseOnPlay = null;
    this._endGrab();
    if (g.state === 'intro') this.introSkipped = true; // leaving it early (a new intro resets this)
    if (g.debug.autostart && (g.state === 'boot' || opts.immediate)) {
      this.beginWave(index, { immediate: true });
    } else if (opts.skipIntro) {
      g.player?.reset?.();
      this.beginWave(index);
    } else {
      this._playIntro(index);
    }
  }

  /** Skip the intro cinematic (Enter / click / UI). */
  skipIntro() {
    if (this.game.state !== 'intro') return;
    this.introSkipped = true;
    this.beginWave(this._startIndex);
  }

  /**
   * Wave title card ('transition') → 'playing' + spawnWave + wave:start.
   * `opts.immediate` skips the card (autostart / retries); `opts.retry` marks
   * the wave:start as a retry so HUD / PostFX / Audio drop the old attempt.
   */
  beginWave(index, opts = {}) {
    const g = this.game;
    index = this._clampWave(index);
    this.waveIndex = index;
    this.waveCleared = false;
    this.dying = false;
    this._resetWatch();

    if (opts.immediate) {
      this.timeline.stop();
      this._enterCombat(index, !!opts.retry);
      return;
    }
    if (index > 0) this._healPlayer(FLOW.healBetweenWaves);
    g.setState('transition');
    this.timeline.run('card', [[FLOW.cardLength, () => this._enterCombat(index)]]);
  }

  /** Retry the current wave from scratch (death screen / pause menu). */
  restartWave() {
    const g = this.game;
    let index = this.waveIndex;
    // A grab still running (retry from the pause menu) must end before the
    // player reset — its release grants post-grab i-frames that reset() clears.
    this._endGrab();
    // Died during the breather after a clear: the wave is already won.
    if (this.waveCleared) {
      if (index + 1 >= WAVES.length) {
        g.player?.reset?.();
        this._victory();
        return;
      }
      index += 1;
    }
    this.timeline.stop();
    g.player?.reset?.();
    this.beginWave(index, { immediate: true, retry: true });
  }

  /** Full new run without the intro (victory screen 「再来一次」). */
  restartGame() {
    this.timeline.stop();
    this.startGame(0, { skipIntro: true });
  }

  togglePause() {
    const st = this.game.state;
    if (st === 'playing') this.pause();
    else if (st === 'paused') this.resume();
  }

  pause(reason = 'key') {
    const g = this.game;
    if (g.state !== 'playing') return;
    this._pausedAt = g.time.realElapsed;
    g.setState('paused');
    // Free the cursor for the menu (the browser already did if Esc unlocked it).
    if (reason !== 'lock') g.input.exitPointerLock?.();
  }

  /** Resume from the pause menu. Call from a user gesture so pointer lock is granted. */
  resume() {
    const g = this.game;
    if (g.state !== 'paused') return;
    g.setState('playing');
    if (!g.debug.freeMouse) g.input.requestPointerLock?.();
  }

  // --------------------------------------------------------------- update

  update() {
    const g = this.game;
    const rdt = g.time.realDt;
    if (g.state !== 'paused') {
      this.stateTime += rdt;
      this.timeline.update(rdt);
    }
    const st = g.state;
    if (st === 'playing') this.stats.time += rdt;

    const input = g.input;
    if (st === 'playing') {
      if (input.pressed('pause')) this.pause();
    } else if (st === 'paused') {
      if (
        input.pressed('pause') &&
        !g.ui?.isModalOpen?.() &&
        g.time.realElapsed - this._pausedAt > FLOW.resumeGuard
      ) {
        this.resume();
      }
    } else if (st === 'intro') {
      if (this.stateTime > FLOW.introSkipGrace && (input.pressed('confirm') || input.pressed('attack'))) {
        this.skipIntro();
      }
    } else if (st === 'transition') {
      // Pausing is only allowed from 'playing' — remember the request instead.
      if (input.pressed('pause')) this._pauseOnPlay = 'key';
    }

    this._watchdog(rdt);
  }

  // ------------------------------------------------------------ internals

  _playIntro(index) {
    const g = this.game;
    this.introSkipped = false;
    g.player?.reset?.();
    g.setState('intro');
    g.events.emit('cinematic', { name: 'intro' });
    const cues = INTRO_SCRIPT.map((line) => [line.at, () => this._say(line.speaker, line.text, line.duration)]);
    cues.push([
      INTRO_DIVE_AT,
      () => {
        g.events.emit('cinematic', { name: 'dive' });
        this._diveEntry();
      },
    ]);
    // Bubble streams after the entry (cancelled with the timeline on skip).
    for (let t = DIVE_WAKE.from; t <= DIVE_WAKE.until + 1e-6; t += DIVE_WAKE.every) {
      cues.push([INTRO_DIVE_AT + t, () => this._bubblesAhead(DIVE_WAKE)]);
    }
    for (let t = DIVE_TRAIL.from; t <= DIVE_TRAIL.until + 1e-6; t += DIVE_TRAIL.every) {
      cues.push([INTRO_DIVE_AT + t, () => this._bubblesFromPlayer()]);
    }
    cues.push([FLOW.introLength, () => this.beginWave(index)]);
    this.timeline.run('intro', cues);
  }

  // The camera breaks through the surface: white-water flash + bubble burst.
  _diveEntry() {
    const g = this.game;
    g.post?.flash?.(DIVE_FLASH.color, DIVE_FLASH.intensity, DIVE_FLASH.duration);
    this._bubblesAhead(DIVE_BURST);
  }

  /** Bubbles `spec.ahead` metres in front of the camera (it is looking down at 老公). */
  _bubblesAhead(spec) {
    const g = this.game;
    const cam = g.camera;
    if (!cam || !g.vfx?.spawnBubbles) return;
    cam.getWorldDirection(_fwd);
    _v.setFromMatrixPosition(cam.matrixWorld).addScaledVector(_fwd, spec.ahead);
    g.vfx.spawnBubbles(_v, spec.count, spec.opts);
  }

  _bubblesFromPlayer() {
    const g = this.game;
    const p = g.player;
    if (!p?.position || !g.vfx?.spawnBubbles) return;
    _v.copy(p.hurtbox?.center ?? p.position);
    _v.y += 0.45; // around the head
    g.vfx.spawnBubbles(_v, DIVE_TRAIL.count, DIVE_TRAIL.opts);
  }

  /** End a running grab QTE (retry / new run) without its fail outcome. */
  _endGrab() {
    const g = this.game;
    if (g.combat?.grab) {
      try {
        g.combat.qte?.end?.(false, 'restart');
      } catch (err) {
        console.error('[Director] ending the grab threw', err);
      }
    }
    // Fallback if nothing released the player.
    if (g.player?.grabbedBy) g.player.setGrabbed?.(null);
  }

  _enterCombat(index, retry = false) {
    const g = this.game;
    g.setState('playing');
    this._spawn(index);
    g.events.emit('wave:start', retry ? { index, wave: WAVES[index], retry: true } : { index, wave: WAVES[index] });
    const pending = this._pauseOnPlay;
    this._pauseOnPlay = null;
    if (pending === 'key') this.pause();
    else if (pending === 'lock' && !g.input.pointerLocked && !g.debug.freeMouse) this.pause('lock');
  }

  _spawn(index) {
    try {
      this.game.enemies?.spawnWave?.(index);
    } catch (err) {
      console.error('[Director] enemies.spawnWave threw', err);
    }
  }

  _onWaveClear(index) {
    const g = this.game;
    if (this.waveCleared) return;
    if (index !== undefined && index !== this.waveIndex) return; // stale event
    if (g.state !== 'playing' && g.state !== 'paused') return;
    this.waveCleared = true;
    const next = this.waveIndex + 1;
    if (this.dying) return; // death beat already scheduled; retry advances instead

    if (next >= WAVES.length) {
      this.timeline.run('victory', [[FLOW.victoryDelay, () => this._victory()]]);
    } else if (WAVES[next].boss) {
      // The sperm whale drifts past (AmbientLife reacts to wave:clear) — give
      // it room, and let 老公 notice.
      this.timeline.run('breather', [
        [2.4, () => this._say('老公', '这条……家里的锅装得下吗？', 3.2)],
        [FLOW.breatherBeforeBoss, () => this.beginWave(next)],
      ]);
    } else {
      this.timeline.run('breather', [[FLOW.breather, () => this.beginWave(next)]]);
    }
  }

  _onPlayerDeath() {
    const g = this.game;
    if (this.dying) return;
    if (g.state !== 'playing' && g.state !== 'paused') return;
    this.dying = true;
    this.stats.deaths++;
    this.timeline.run('dying', [
      [
        FLOW.deathDelay,
        () => {
          g.setState('dead');
          g.input.exitPointerLock?.();
        },
      ],
    ]);
  }

  _victory() {
    const g = this.game;
    g.setState('victory');
    g.input.exitPointerLock?.();
    g.events.emit('game:victory', { stats: this.stats.snapshot() });
  }

  _onPointerLock(locked) {
    const g = this.game;
    if (locked) {
      if (this._pauseOnPlay === 'lock') this._pauseOnPlay = null;
      return;
    }
    if (g.debug.freeMouse) return;
    if (g.state === 'playing') this.pause('lock');
    else if ((g.state === 'intro' || g.state === 'transition') && !this._pauseOnPlay) this._pauseOnPlay = 'lock';
  }

  _say(speaker, text, duration) {
    this.game.events.emit('subtitle', { speaker, text, duration });
  }

  _healPlayer(fraction) {
    const p = this.game.player;
    if (!p || !p.alive) return;
    const amount = (p.maxHealth ?? PLAYER.maxHealth) * fraction;
    if (typeof p.heal === 'function') p.heal(amount);
    else p.health = Math.min(p.maxHealth, p.health + amount);
  }

  _clampWave(index) {
    const i = Math.floor(+index || 0);
    return Math.max(0, Math.min(WAVES.length - 1, i));
  }

  _resetWatch() {
    const w = this._watch;
    w.allDead = 0;
    w.playerDown = 0;
    w.empty = 0;
    w.respawned = false;
  }

  // Safety net for modules that miss an event: never leave the game stuck.
  _watchdog(rdt) {
    const g = this.game;
    const w = this._watch;
    if (g.state !== 'playing' || this.timeline.active) {
      w.allDead = w.playerDown = w.empty = 0;
      return;
    }
    const list = g.enemies?.enemies;
    if (Array.isArray(list)) {
      if (list.length === 0) {
        w.empty += rdt;
        if (w.empty > 5 && !w.respawned && !this.waveCleared) {
          w.respawned = true;
          console.warn('[Director] no enemies after wave start — respawning wave', this.waveIndex);
          this._spawn(this.waveIndex);
        }
      } else {
        w.empty = 0;
        let anyAlive = false;
        for (let i = 0; i < list.length; i++) if (list[i].alive) anyAlive = true;
        w.allDead = anyAlive ? 0 : w.allDead + rdt;
        if (w.allDead > 4 && !this.waveCleared) {
          console.warn('[Director] all enemies dead but no wave:clear — advancing');
          this._onWaveClear(this.waveIndex);
        }
      }
    }
    const p = g.player;
    if (p && (p.alive === false || p.health <= 0) && !this.dying) {
      w.playerDown += rdt;
      if (w.playerDown > 1.2) {
        console.warn('[Director] player down without player:death — forcing death flow');
        this._onPlayerDeath();
      }
    } else {
      w.playerDown = 0;
    }
  }
}
