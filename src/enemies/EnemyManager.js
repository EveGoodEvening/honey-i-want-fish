// EnemyManager — spawns and updates the sharks of the current wave and
// coordinates them (attack token, tiger pincer). Implements the EnemyManager
// contract in docs/DESIGN.md.
//
// Pacing between sharks:
//  - one attack token: only its holder may commit to an approach; once it is
//    released nobody may take it for TOKEN_COOLDOWN seconds (a little longer
//    with a pack alive; flankers, who never hold the token, are exempt);
//  - every player:hit is attributed to the shark that dealt it, so a second
//    shark's telegraph can hold until 老公 is out of the first hit's stun
//    (SharkAI asks hitByOtherWithin());
//  - a face-tanked shark may answer at once, cooldown or not, unless another
//    shark is mid-strike or holding him (requestCounter); knife hits on any
//    shark of the wave are counted (noteKnifeHit / recentKnifeHits) — a pack
//    being carved up rips instead of holding;
//  - a wave that starts with 老公 out at the edge / over the trench / deep
//    appears on the lit open water's side (_placeInMurk).
//
// Assets: species bundles are prefetched in idle slices and, while nothing is
// being fought (title, intro, wave card), also from the frame loop with a
// time budget per frame — idle callbacks barely run on a GPU-bound page. When
// a wave's card goes up ('transition') its species move to the front of the
// queue and the card's frames get a bigger budget, so the build finishes
// behind the card in slices; only a bundle still unfinished at the reveal is
// completed synchronously by spawnWave. Every finished bundle is
// shader-warmed (programs compiled before first sight).
//
// Enemy implementation: ./Shark.js (rig + motion), ./SharkAI.js (behaviour),
// procedural assets: ./SharkGeometry.js, ./SharkTextures.js, ./SharkAssets.js,
// species tuning: ./species.js.
import * as THREE from 'three';
import { WAVES, WORLD } from '../core/config.js';
import { SharkAssetLibrary } from './SharkAssets.js';
import { Shark, buildSharkRig } from './Shark.js';

const TAU = Math.PI * 2;
const TOKEN_COOLDOWN = 1.6;
// With a pack, each commit tends to bring a flanker too: a longer breath.
const TOKEN_COOLDOWN_PACK = 2.8;
// Frame-loop asset pump: a share of the frame interval (a slow, GPU-bound
// frame affords more), clamped to [min, max] ms.
const PUMP_STATES = new Set(['title', 'intro', 'transition']);
const PUMP_SHARE = 0.1;
const PUMP_MIN = 6;
const PUMP_MAX = 16;
// Behind the wave card, with its species still unbuilt.
const PUMP_CARD_SHARE = 0.25;
const PUMP_CARD_MIN = 12;
const PUMP_CARD_MAX = 40;
// Wave spawns with 老公 out past SPAWN_INWARD_R m / below SPAWN_UP_Y m come
// from the lit open water's side (see _placeInMurk; SharkAI's soft leash
// keeps the fight there).
const SPAWN_INWARD_R = [40, 55];
const SPAWN_UP_Y = [-45, -55];
const SPAWN_UP_TO = -25;
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();

export class EnemyManager {
  constructor(game) {
    this.game = game;
    this.enemies = [];
    this.waveIndex = -1;
    this._cleared = true;
    this._token = null; // shark currently allowed to commit to an attack
    this._tokenFreeAt = 0; // game time before which nobody may take the token
    this._attackId = 0;
    /** Game time of the last player:hit and the shark that dealt it. */
    this.lastPlayerHitAt = -Infinity;
    this.lastHitBy = null;
    /** The wave's opening reveal pass has been made (only one shark does it). */
    this.revealDone = false;
    // Game times of the last knife hits on any shark of the wave (SharkAI:
    // a pack being carved up rips instead of holding).
    this._knifeHits = [-Infinity, -Infinity, -Infinity, -Infinity];
    this._knifeNext = 0;
    this.assets = new SharkAssetLibrary(game);
    // Species drawn right now (live sharks and corpses): repainted at once
    // after a WebGL context restore.
    this.assets.inUse = (type) => this.enemies.some((e) => e.type === type);
    // Warm-up runs as its own idle task, not inside the build slice that
    // finished the bundle (the compile is one indivisible chunk of work).
    this.assets.onReady = (bundle) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => this._warm(bundle), { timeout: 300 });
      else setTimeout(() => this._warm(bundle), 0);
    };

    game.events?.on?.('player:hit', (p) => this._onPlayerHit(p));
    // The wave title card is up: build its species first, behind the card,
    // rather than block the frame that reveals the sharks.
    game.events?.on?.('game:state', ({ to } = {}) => {
      if (to === 'transition') this._prepareWave(game.director?.waveIndex);
    });
    this._pumpAt = 0; // performance.now() of the last frame pump
    this._cardTypes = null; // species of the wave whose card is up
  }

  start() {
    // Prefetch species in the order the waves need them, starting with the
    // wave the game will open on, so later waves do not hitch.
    const first = Math.min(this.game.debug?.wave ?? 0, WAVES.length - 1);
    const order = [];
    for (let k = 0; k < WAVES.length; k++) {
      const wave = WAVES[(first + k) % WAVES.length];
      for (const def of wave.enemies) if (!order.includes(def.type)) order.push(def.type);
    }
    for (const type of order) this.assets.prefetch(type);
  }

  spawnWave(index) {
    this.clear();
    const i = Math.max(0, Math.min(WAVES.length - 1, index | 0));
    const wave = WAVES[i];
    this.waveIndex = i;
    this._cleared = false;
    const n = wave.enemies.length;
    const base = Math.random() * TAU;
    wave.enemies.forEach((def, k) => {
      const shark = this._create(def.type);
      const angle = base + (k * TAU) / Math.max(2, n) * 0.55;
      this._placeInMurk(shark, angle);
      this.enemies.push(shark);
      this.game.events.emit('enemy:spawn', { enemy: shark });
    });
    // Start building whatever the next wave needs.
    const next = WAVES[i + 1];
    if (next) for (const def of next.enemies) this.assets.prefetch(def.type);
    return this.enemies;
  }

  clear() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this._token = null;
    this._tokenFreeAt = 0;
    this.lastHitBy = null;
    this.lastPlayerHitAt = -Infinity;
    this.revealDone = false;
    this._knifeHits.fill(-Infinity);
    this._cleared = true;
  }

  getAlive() {
    return this.enemies.filter((e) => e.alive);
  }

  getBoss() {
    for (const e of this.enemies) if (e.isBoss && e.alive) return e;
    return null;
  }

  getNearest(position, maxDist = Infinity) {
    let best = null;
    let bestD = maxDist;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = e.position.distanceTo(position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  update(dt) {
    this._pumpAssets();
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) list[i].update(dt);
    if (dt > 0) this._separate(dt);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive && !e._deathAnnounced) {
        e._deathAnnounced = true;
        this.game.events.emit('enemy:death', { enemy: e });
      }
    }
    if (!this._cleared && list.length) {
      let allDead = true;
      for (let i = 0; i < list.length; i++) if (list[i].alive) allDead = false;
      if (allDead) {
        this._cleared = true;
        this.game.events.emit('wave:clear', { index: this.waveIndex });
      }
    }
  }

  // ------------------------------------------------------------------ coordination (used by SharkAI)

  requestToken(shark) {
    const t = this._token;
    if (t === shark) return true;
    if ((this.game.time?.elapsed ?? 0) < this._tokenFreeAt) return false;
    if (!t || !t.alive || !t.ai.isEngaged()) {
      this._token = shark;
      return true;
    }
    return false;
  }

  releaseToken(shark) {
    if (this._token !== shark) return;
    this._token = null;
    // A breath between committed attacks, whoever makes the next one.
    let alive = 0;
    for (const e of this.enemies) if (e.alive) alive++;
    this._tokenFreeAt = (this.game.time?.elapsed ?? 0) + (alive > 1 ? TOKEN_COOLDOWN_PACK : TOKEN_COOLDOWN);
  }

  /**
   * A face-tanked shark wants to answer at once (SharkAI._counter): granted —
   * the token goes to it, cooldown or not — unless another shark is winding
   * up, striking or holding 老公 (no stacked hits).
   */
  requestCounter(shark) {
    for (const e of this.enemies) {
      if (e === shark || !e.alive) continue;
      const s = e.ai.state;
      if (s === 'telegraph' || s === 'attack' || s === 'grab') return false;
    }
    this._token = shark;
    return true;
  }

  /** A knife hit landed on a shark of this wave at game time `t` (not counting blows into a stagger). */
  noteKnifeHit(t) {
    this._knifeHits[this._knifeNext] = t;
    this._knifeNext = (this._knifeNext + 1) % this._knifeHits.length;
  }

  /** Knife hits on the wave's sharks in the last `window` s (up to 4). */
  recentKnifeHits(window) {
    const now = this.game.time?.elapsed ?? 0;
    let n = 0;
    for (let i = 0; i < this._knifeHits.length; i++) if (now - this._knifeHits[i] <= window) n++;
    return n;
  }

  /** True if a shark other than `shark` hit 老公 less than `window` seconds ago. */
  hitByOtherWithin(shark, window) {
    return !!this.lastHitBy && this.lastHitBy !== shark && (this.game.time?.elapsed ?? 0) - this.lastPlayerHitAt < window;
  }

  /**
   * A shark committed to an attack: tiger partners usually swing round to
   * flank (come from behind / below while the leader engages from the front).
   */
  onCommit(shark) {
    if (shark.type !== 'tiger') return;
    for (const e of this.enemies) {
      if (e === shark || !e.alive || e.type !== 'tiger') continue;
      if (Math.random() < 0.6) e.ai.beginFlank(shark);
      else e.ai.decisionTimer = Math.max(e.ai.decisionTimer, 2.5); // hang back this time
    }
  }

  anyGrabbing(except) {
    for (const e of this.enemies) if (e !== except && e.alive && e.ai.state === 'grab') return true;
    return false;
  }

  nextAttackId() {
    this._attackId = (this._attackId + 1) % 1e9;
    return this._attackId;
  }

  // ------------------------------------------------------------------ internals

  _create(type) {
    return new Shark(this.game, this, type, this.assets.get(type));
  }

  /** Attributes a player:hit to the shark that dealt it (grab holder, else nearest active volume). */
  _onPlayerHit(payload) {
    const g = this.game;
    let by = g.combat?.grab?.enemy ?? null;
    if (!by || !this.enemies.includes(by)) {
      by = null;
      const ref = g.player?.hurtbox?.center ?? payload?.sourcePosition ?? g.player?.position;
      let best = Infinity;
      if (ref) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const vols = e._active;
          for (let i = 0; i < vols.length; i++) {
            const d = vols[i].center.distanceTo(ref) - vols[i].radius;
            if (d < best) {
              best = d;
              by = e;
            }
          }
        }
      }
      // No live volume (e.g. the bite that ends a failed grab): the jaws nearest the source.
      const src = payload?.sourcePosition;
      if (!by && src) {
        best = 4;
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const d = e.getMouthPosition().distanceTo(src);
          if (d < best) {
            best = d;
            by = e;
          }
        }
      }
    }
    if (!by) return;
    this.lastHitBy = by;
    this.lastPlayerHitAt = g.time?.elapsed ?? 0;
  }

  /** Moves every species wave `index` needs to the front of the build queue. */
  _prepareWave(index) {
    const wave = WAVES[index];
    this._cardTypes = wave ? wave.enemies.map((def) => def.type) : null;
    if (!wave) return;
    for (let k = wave.enemies.length - 1; k >= 0; k--) this.assets.prioritize(wave.enemies[k].type);
  }

  /**
   * Prefetch from the frame loop while nothing is being fought. A frame's
   * budget is a share of the measured frame interval, so a page whose frames
   * already take 250 ms (software GL) builds faster than one at 60 fps; the
   * wave card gets a bigger share to finish its species before the reveal.
   */
  _pumpAssets() {
    const now = performance.now();
    const interval = now - this._pumpAt;
    this._pumpAt = now;
    const st = this.game.state;
    if (!this.assets.busy || !PUMP_STATES.has(st)) return;
    let card = false;
    if (st === 'transition' && this._cardTypes) {
      for (let i = 0; i < this._cardTypes.length; i++) if (!this.assets.isReady(this._cardTypes[i])) card = true;
    }
    const share = card ? PUMP_CARD_SHARE : PUMP_SHARE;
    const lo = card ? PUMP_CARD_MIN : PUMP_MIN;
    const hi = card ? PUMP_CARD_MAX : PUMP_MAX;
    this.assets.pump(THREE.MathUtils.clamp(interval * share, lo, hi));
  }

  /**
   * Compiles a bundle's shader programs before any shark of it is seen:
   * builds a throw-away rig (skinned body, eyes, teeth — the exact object
   * types a Shark renders) and hands it to PostFX's warm-up (which binds the
   * render target the scene is drawn into), else to renderer.compileAsync.
   * Only the temporary rig is disposed, never the shared bundle.
   */
  _warm(bundle) {
    const g = this.game;
    if (!g.post?.warmup && !g.renderer?.compileAsync) return;
    let rig = null;
    try {
      rig = buildSharkRig(bundle, g.quality);
      rig.mesh.updateMatrixWorld(true);
      const done = () => rig.dispose();
      const p = g.post?.warmup ? g.post.warmup(rig.mesh) : g.renderer.compileAsync(rig.mesh, g.camera, g.scene);
      if (p && typeof p.then === 'function') p.then(done, done);
      else done();
    } catch (err) {
      rig?.dispose();
      console.warn('[enemies] shader warm-up failed', err);
    }
  }

  /**
   * Places a shark out in the murk (≥ 35 m from the player), swimming
   * tangentially. With 老公 out toward the arena edge / over the trench (a
   * wave starts where the last one ended), it appears on the side of the lit
   * open water and a little shallower: the first chase leads him back in.
   */
  _placeInMurk(shark, angle) {
    const p = this.game.player.position;
    const lim = WORLD.arenaRadius - shark.length - 8;
    const pr = Math.hypot(p.x, p.z);
    const out = THREE.MathUtils.smoothstep(pr, SPAWN_INWARD_R[0], SPAWN_INWARD_R[1]);
    if (out > 0) {
      // Squeeze the given angle toward the centre's direction (to within
      // ±63° fully out; the pack keeps its relative spread, scaled).
      const inward = Math.atan2(-p.z, -p.x);
      let da = Math.atan2(Math.sin(angle - inward), Math.cos(angle - inward));
      da *= 0.35 + 0.65 * (1 - out);
      angle = inward + da;
    }
    let best = null;
    let bestR = Infinity;
    for (let k = 0; k < 12; k++) {
      const a = angle + (k === 0 ? 0 : (Math.random() - 0.5) * Math.PI * 1.6);
      const dist = 38 + Math.random() * 8 + (shark.isBoss ? 10 : 0);
      _v.set(p.x + Math.cos(a) * dist, 0, p.z + Math.sin(a) * dist);
      const r = Math.hypot(_v.x, _v.z);
      if (r < lim) {
        best = { x: _v.x, z: _v.z, a };
        break;
      }
      if (r < bestR) {
        bestR = r;
        best = { x: _v.x, z: _v.z, a };
      }
    }
    const floor = this.game.env?.getSeabedHeight?.(best.x, best.z) ?? WORLD.floorY;
    // Deep (over the trench): a little nearer the light than he is.
    const deep = THREE.MathUtils.smoothstep(-p.y, -SPAWN_UP_Y[0], -SPAWN_UP_Y[1]);
    const y = THREE.MathUtils.clamp(
      p.y + (SPAWN_UP_TO - p.y) * 0.3 * deep + (Math.random() * 7 - 3) + shark.spec.ai.depthBias,
      floor + shark._bottomMargin + 1,
      WORLD.surfaceY - shark._topMargin - 1,
    );
    _v.set(best.x, y, best.z);
    // Tangent to the circle around the player, in the shark's orbit direction.
    const dir = shark.ai.orbitDir;
    _d.set(-Math.sin(best.a) * dir, 0, Math.cos(best.a) * dir);
    shark.placeAt(_v, _d);
  }

  /** Keeps sharks from swimming through each other. */
  _separate(dt) {
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const minD = 0.3 * (a.length + b.length);
        _d.subVectors(a.position, b.position);
        const d = _d.length();
        if (d >= minD || d < 1e-4) continue;
        _d.multiplyScalar(((minD - d) / d) * 1.5 * dt);
        a.drift.add(_d);
        b.drift.sub(_d);
      }
    }
  }

  // ------------------------------------------------------------------ debug / tooling

  /** Spawns a single shark without clearing the wave (used by smoke scenarios). */
  debugSpawn(type, { position = null, forward = null, freeze = false } = {}) {
    const shark = this._create(type);
    if (position) shark.placeAt(position, forward ?? new THREE.Vector3(0, 0, 1));
    else this._placeInMurk(shark, Math.random() * TAU);
    shark.freeze = freeze;
    this.enemies.push(shark);
    this._cleared = false;
    this.game.events.emit('enemy:spawn', { enemy: shark });
    return shark;
  }
}
