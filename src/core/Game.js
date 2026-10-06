import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';
import { WORLD } from './config.js';
import { resolveQuality } from './quality.js';
import { Environment } from '../world/Environment.js';
import { AmbientLife } from '../world/AmbientLife.js';
import { PostFX } from '../render/PostFX.js';
import { Player } from '../player/Player.js';
import { EnemyManager } from '../enemies/EnemyManager.js';
import { CombatSystem } from '../combat/CombatSystem.js';
import { CameraRig } from '../camera/CameraRig.js';
import { VFX } from '../vfx/VFX.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { UI } from '../ui/UI.js';
import { Director } from '../game/Director.js';

// Resolves after the browser has painted a frame: a requestAnimationFrame
// callback runs *before* that frame's paint, so continue from a task queued
// inside it. Falls back to a plain timeout when rAF is throttled (hidden tab).
function nextPaint() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 250);
  });
}

// Owns the renderer, scene, clock and every subsystem. The contract every
// subsystem implements is documented in docs/DESIGN.md.
export class Game {
  constructor(container) {
    this.container = container;
    this.params = new URLSearchParams(location.search);
    const p = this.params;
    this.debug = {
      autostart: p.has('autostart'),
      wave: Math.max(0, parseInt(p.get('wave') ?? '0', 10) || 0),
      god: p.has('god'),
      fixedDt: p.has('fixeddt'),
      freeMouse: p.has('freemouse'),
      noPost: p.has('nopost'),
      mute: p.has('mute'),
      stats: p.has('stats'),
    };

    this.events = new EventBus();
    this.state = 'boot';
    this.danger = 0; // 0..1 smoothed threat level (enemies' getDangerLevel)

    this.time = {
      elapsed: 0, // scaled game time (seconds)
      realElapsed: 0,
      dt: 0, // scaled delta for this frame
      realDt: 0, // unscaled delta for this frame
      timeScale: 1,
      frame: 0,
    };
    this._hitstopUntil = 0;
    this._hitstopScale = 1;
    this._slowmoUntil = 0;
    this._slowmoScale = 1;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    // Preset: URL > saved title-screen choice > 'high' for scripted runs > GPU
    // guess (see quality.js). Probed on this renderer's own (high-performance)
    // context, before anything quality-dependent is configured or built.
    const pick = resolveQuality({ params: p, debug: this.debug, gl: this.renderer.getContext() });
    this.quality = pick.quality; // 'low' | 'medium' | 'high'
    this.qualitySource = pick.source; // 'url' | 'saved' | 'debug' | 'detected'
    this.gpu = pick.gpu; // unmasked renderer string ('' if the browser hides it)
    const maxRatio = { low: 0.75, medium: 1, high: 1.5 }[this.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxRatio));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shader error checks read program/shader logs synchronously on each program's
    // first use, a stall on GPUs without parallel compile. Keep them in dev and in
    // scripted (?fixeddt) runs, where catching a broken shader matters more.
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV || this.debug.fixedDt;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, this._aspect(), 0.1, 700);
    this.camera.position.set(0, WORLD.playerSpawn[1] + 2, WORLD.playerSpawn[2] + 6);
    this.scene.add(this.camera);

    this.input = new Input(this);
    this.stats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 };
    this._statAccum = { frames: 0, time: 0 };
    this._moduleErrors = new Set();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  /**
   * Builds every subsystem, then starts the frame loop. Async: construction is
   * staged with a paint between the heavy constructors (≈0.8 s environment,
   * ≈0.9 s player on high) so the boot splash in index.html shows at once and
   * no single main-thread task blocks for ~2 s. Resolves once the loop runs;
   * `window.__game` is set first so scripted tests can poll `state` /
   * `time.frame` while it boots (`state` stays 'boot' until the end).
   */
  async init() {
    window.__game = this;
    // Construction order matters: later modules may read earlier ones in their
    // constructors (e.g. Player reads env.getSeabedHeight). Cross-references
    // to modules created later must be resolved lazily (in update/start).
    await nextPaint();
    this.env = new Environment(this);
    await nextPaint();
    this.player = new Player(this);
    await nextPaint();
    this.enemies = new EnemyManager(this);
    this.vfx = new VFX(this);
    this.combat = new CombatSystem(this);
    await nextPaint();
    this.cameraRig = new CameraRig(this);
    this.ambient = new AmbientLife(this);
    this.post = new PostFX(this);
    this.audio = new AudioEngine(this);
    this.ui = new UI(this);
    this.director = new Director(this);

    this.modules = [
      ['env', this.env], ['player', this.player], ['enemies', this.enemies],
      ['vfx', this.vfx], ['combat', this.combat], ['cameraRig', this.cameraRig],
      ['ambient', this.ambient], ['post', this.post], ['audio', this.audio],
      ['ui', this.ui], ['director', this.director],
    ];
    for (const [name, m] of this.modules) this._guard(name, 'start', () => m.start?.());

    this.resize();
    this.director.boot();
    this._last = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setState(next) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.events.emit('game:state', { from, to: next });
  }

  /** Freeze simulation briefly for hit impact. `scale` is the time scale during the stop. */
  hitstop(duration = 0.08, scale = 0.02) {
    const until = this.time.realElapsed + duration;
    if (until > this._hitstopUntil) this._hitstopUntil = until;
    this._hitstopScale = Math.min(scale, this._hitstopScale);
  }

  /** Slow motion for dramatic beats (perfect dodge, parry, kill). */
  slowmo(duration = 0.6, scale = 0.3) {
    const until = this.time.realElapsed + duration;
    if (until > this._slowmoUntil) this._slowmoUntil = until;
    this._slowmoScale = Math.min(scale, this._slowmoScale);
  }

  frame() {
    const now = performance.now();
    const measuredDt = (now - this._last) / 1000;
    this._last = now;
    let realDt = this.debug.fixedDt ? 1 / 60 : measuredDt;
    realDt = Math.min(realDt, 1 / 20);

    const t = this.time;
    t.realDt = realDt;
    t.realElapsed += realDt;

    let scale = 1;
    if (t.realElapsed < this._hitstopUntil) scale = Math.min(scale, this._hitstopScale);
    else this._hitstopScale = 1;
    if (t.realElapsed < this._slowmoUntil) scale = Math.min(scale, this._slowmoScale);
    else this._slowmoScale = 1;
    t.timeScale = scale;
    t.frame++;

    // The Director runs first and can pause or resume inside its update (P /
    // Esc, a pause requested during the wave card), so the state is read again
    // after it: the simulation skips any frame the game was paused in at all.
    // No simulation module ever updates with state 'paused' (SharkAI would read
    // that as "not playing" and drop a grab Combat still holds), a pause pressed
    // this frame freezes game time at once, and a resume takes effect next frame.
    const pausedBefore = this.state === 'paused';
    t.dt = pausedBefore ? 0 : realDt * scale;
    this._guard('director', 'update', () => this.director.update(t.dt));
    const paused = pausedBefore || this.state === 'paused';
    const dt = paused ? 0 : t.dt;
    t.dt = dt;
    t.elapsed += dt;

    if (!paused) {
      this._guard('player', 'update', () => this.player.update(dt));
      this._guard('enemies', 'update', () => this.enemies.update(dt));
      this._guard('combat', 'update', () => this.combat.update(dt));
      this._guard('vfx', 'update', () => this.vfx.update(dt));
      this._guard('ambient', 'update', () => this.ambient.update(dt));
      this._guard('env', 'update', () => this.env.update(dt));
      this._updateDanger(realDt);
    }
    this._guard('cameraRig', 'update', () => this.cameraRig.update(dt));
    this._guard('audio', 'update', () => this.audio.update(dt));
    this._guard('ui', 'update', () => this.ui.update(dt));
    this._guard('post', 'render', () => this.post.render(dt));

    this.input.endFrame();
    this._updateStats(measuredDt);
    if (t.frame === 1) this._dismissSplash();
  }

  // The static boot splash (#boot-splash in index.html) covers the page until
  // the first frame has been drawn under it, then fades into the title / play.
  _dismissSplash() {
    const el = document.getElementById('boot-splash');
    if (!el) return;
    const remove = () => el.remove();
    el.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 1500); // no transition (reduced motion, hidden tab)
    el.classList.add('is-gone');
  }

  _updateDanger(realDt) {
    let target = 0;
    for (const e of this.enemies.enemies ?? []) {
      if (e.alive) target = Math.max(target, e.getDangerLevel?.() ?? 0);
    }
    const k = 1 - Math.exp(-realDt * (target > this.danger ? 4 : 1.2));
    this.danger += (target - this.danger) * k;
  }

  _updateStats(realDt) {
    const s = this._statAccum;
    s.frames++;
    s.time += realDt;
    if (s.time >= 0.5) {
      this.stats.fps = Math.round(s.frames / s.time);
      this.stats.frameMs = +(1000 * s.time / s.frames).toFixed(1);
      this.stats.drawCalls = this.renderer.info.render.calls;
      this.stats.triangles = this.renderer.info.render.triangles;
      s.frames = 0;
      s.time = 0;
    }
  }

  // Keeps one broken subsystem from taking the whole frame loop down; logs the
  // first failure per module+method so the console stays readable.
  _guard(name, method, fn) {
    try {
      fn();
    } catch (err) {
      const key = `${name}.${method}`;
      if (!this._moduleErrors.has(key)) {
        this._moduleErrors.add(key);
        console.error(`[Game] ${key} threw`, err);
      }
    }
  }

  _aspect() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    return w / h;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.post?.setSize?.(w, h);
    this.events.emit('game:resize', { width: w, height: h });
  }
}
