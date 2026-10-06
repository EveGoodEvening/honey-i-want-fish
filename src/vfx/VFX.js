// VFX — pooled, GPU-friendly particle effects. See docs/DESIGN.md "VFX".
//
//   spawnBlood(position, direction, amount)        amount ~0.2..3
//   spawnBubbles(position, count, { speed, size, spread, life })
//   spawnImpact(position, normal, { strength })
//   spawnShockwave(position, radius, { strength, normal })
//   spawnSediment(position, amount)                 (extra) silt cloud
//   spawnSpark(position, normal, strength)          (extra) parry glint
//   addWound(enemy, worldPoint, { duration, rate, size })  (extra) bleeding tendrils
//   update(dt)
//
// Everything is preallocated at construction (budgets scale with
// game.quality); spawning and updating never allocate. Systems:
//   CloudSystem  — blood + sediment (depth-sorted alpha clouds)
//   BubbleSystem — rising bubbles (premultiplied, mostly additive)
//   DustSystem   — displaced particulate specks
//   PressureFX   — soft expanding pressure rings (no shells: see spawnShockwave)
//   KnifeTrail   — ribbon following player.getActiveAttack()
//   Emitters     — wounds, wakes, dodge streams, sediment from bodies
import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { createCloudAtlas, createNoiseTexture } from './textures.js';
import { CloudSystem, CLOUD_KIND } from './CloudSystem.js';
import { BubbleSystem } from './BubbleSystem.js';
import { DustSystem } from './DustSystem.js';
import { PressureFX } from './PressureFX.js';
import { KnifeTrail } from './KnifeTrail.js';
import { Emitters } from './Emitters.js';

// Sunlight absorption per metre — must match the Environment's LIGHT_ABSORB_K
// (its sun colour already carries exp(-K · cameraDepth)).
const ENV_ABSORB = [0.075, 0.034, 0.028];
// Diffuse in-scatter fill vs. the horizontal water colour (meshes get ≈9× from
// the hemisphere light; particles are thin media lit from all around).
const AMBIENT_GAIN = 4.0;

const BUDGETS = {
  low: { clouds: 280, bubbles: 360, dust: 220, mul: 0.45, selfShadow: false },
  medium: { clouds: 560, bubbles: 800, dust: 480, mul: 0.7, selfShadow: true },
  high: { clouds: 900, bubbles: 1400, dust: 800, mul: 1, selfShadow: true },
};

// Blood albedo (linear). Real blood reflects a little green; with depth
// absorption that is what survives, giving the green-black look. The game's
// diffuse light at combat depth is cyan (−20 m: ≈ 0.39 : 1 : 1.09), so an
// albedo ≈ 1.3× red over green lands lit at ≈ 0.5 : 1 : 0.8 — dark green-black,
// desaturated (the shader greys it a little more); at −8 m ≈ 0.8 : 1 : 0.75, a
// dark neutral grey. Round 3's 2.3× red with little blue (0.068, 0.03, 0.013)
// lit up with red ≈ green and blue at half: ochre / olive mud, read as
// stirred-up sediment. Never orange or pink.
const BLOOD = [0.026, 0.02, 0.015];
// Puffs bled by a corpse (its wounds trickle for ~14 s) thin out from this age
// (s) and are gone soon after, so the body is not wrapped in a growing smog.
const CORPSE_BLEED_FADE = 2;
const CORPSE_BLEED_LIFE = [2.8, 3.4];
// Blood is a thin, light-absorbing medium the water shows through: every puff
// is capped at this opacity. Round 2's near-opaque puffs (×1.65, up to 1)
// stacked into black smoke that hid the kills; overlapping puffs still build
// a dark core where the cloud is thick.
const BLOOD_ALPHA_MAX = 0.5;
// Bursts above amount 1 grow only this fast with it: a kill's gush (2–3)
// spawns about half the puffs it used to, none bigger than 1.6 m.
const BLOOD_BIG_GROWTH = 0.45;
const SEDIMENT = [0.5, 0.47, 0.37];
const SILT = [0.62, 0.62, 0.55];
// pressure waves (see spawnShockwave): a flat ring only up to this radius (m) —
// bigger, it cuts across the frame as a line — and the bubble / speck front above
const RING_MAX_RADIUS = 6;
// strength of PostFX's roar distortion pulse for the megalodon's tail slam
const SLAM_DISTORT = 0.6;

const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _size = new THREE.Vector2();
const _up = new THREE.Vector3(0, 1, 0);
const _sunCol = new THREE.Color();

function rand(a, b) {
  return a + Math.random() * (b - a);
}

/** Random unit vector inside a cone around `axis` (unit). spread 0..1 */
function coneDir(out, axis, spread) {
  out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
  out.normalize().multiplyScalar(spread).add(axis);
  if (out.lengthSq() < 1e-6) out.copy(axis);
  return out.normalize();
}

export class VFX {
  constructor(game) {
    this.game = game;
    const q = BUDGETS[game.quality] ?? BUDGETS.high;
    this.budget = q.mul;
    this.surfaceY = WORLD.surfaceY;

    // Uniform objects shared (by reference) by every VFX material, updated
    // once per frame from the Environment's light (same model as the meshes:
    // the sun / fill tuned for the camera depth, relative absorption per
    // particle depth — see shaderChunks.js).
    this.shared = {
      uSunColor: { value: new THREE.Color(0.9, 1.0, 1.0) },
      uAmbient: { value: new THREE.Color(0.08, 0.28, 0.36) },
      uAbsorb: { value: new THREE.Vector3(...ENV_ABSORB) },
      uCamDepth: { value: 20 },
      uSurfaceY: { value: WORLD.surfaceY },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uViewportH: { value: 720 },
      uNearFade: { value: 0.3 },
    };

    // 256 texels per puff (128 on low): big puffs stay crisp when magnified
    this.atlas = createCloudAtlas(game.quality === 'low' ? 256 : 512);
    this.noise = createNoiseTexture(64);

    const scene = game.scene;
    this.clouds = new CloudSystem({ capacity: q.clouds, atlas: this.atlas, shared: this.shared, selfShadow: q.selfShadow });
    this.bubbles = new BubbleSystem({ capacity: q.bubbles, shared: this.shared, surfaceY: WORLD.surfaceY });
    this.dust = new DustSystem({ capacity: q.dust, shared: this.shared });
    this.pressure = new PressureFX({ scene, shared: this.shared, noise: this.noise });
    scene.add(this.clouds.mesh, this.dust.mesh, this.bubbles.mesh);

    this.trail = new KnifeTrail({
      scene,
      shared: this.shared,
      noise: this.noise,
      quality: game.quality,
      onCavitate: (x, y, z, vel) => {
        this.bubbles.spawn(
          x, y, z,
          vel.x * 0.06 + rand(-0.15, 0.15),
          vel.y * 0.06 + rand(-0.15, 0.15),
          vel.z * 0.06 + rand(-0.15, 0.15),
          0.0015 + Math.pow(Math.random(), 3) * 0.006,
          rand(1.0, 2.4),
          0.85,
        );
      },
      // a heavy thrust punches a small pressure pop into the water at the tip
      onThrust: (tip, axis) => this.spawnShockwave(tip, 0.6, { strength: 0.2, normal: axis }),
    });

    this.emitters = new Emitters(this);
    this._stir = new Float32Array(8 * 8);
    this._stirCount = 0;
    this._solids = new Float32Array(32 * 4);
    this._solidCount = 0;
    this._corpseBleed = false; // the blood being spawned comes from a corpse (see _nearCorpse)
    this.time = 0;

    game.events.on('player:dodge', () => this.emitters.onDodge());
    // The megalodon's tail-slam shockwave: PostFX's expanding distortion ring
    // (its roar pulse, softer) carries the pressure front on screen — PostFX
    // pulses the roar itself, but nothing else pulses for the slam.
    game.events.on('enemy:attack', ({ enemy, type } = {}) => {
      if (type !== 'shockwave' || !enemy?.position) return;
      this.game.post?.pulse?.('roar', { position: enemy.position, strength: SLAM_DISTORT });
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Billowing blood. amount ≈ 0.2 (a trickle) .. 3 (kill / eye stab burst).
   * direction: the slash / spray direction (need not be normalised).
   * Puffs are translucent (BLOOD_ALPHA_MAX), swell fast and thin out within
   * ~2 s (a corpse's bleeding is gone by ~3 s), so even a kill's burst reads
   * as a dark cloud the shark stays visible through, not black smoke; big
   * amounts grow sub-linearly.
   */
  spawnBlood(position, direction, amount = 1) {
    if (!position) return;
    amount = Math.min(4, Math.max(0.05, amount));
    this._corpseBleed = this._nearCorpse(position);
    if (direction && direction.lengthSq() > 1e-8) _dir.copy(direction).normalize();
    else coneDir(_dir, _up, 1);

    if (amount < 0.35) {
      const n = 2 + Math.round(amount * 6);
      for (let i = 0; i < n; i++) this.spawnBloodTendril(position, 0.8 + amount, _dir);
      return;
    }

    const m = this.budget;
    const a = amount <= 1 ? amount : 1 + (amount - 1) * BLOOD_BIG_GROWTH;
    const sq = Math.sqrt(a);
    // Most puffs stay close and billow into one cohesive cloud; a few are
    // thrown further out so the cloud has an irregular, torn silhouette.
    const n = Math.max(3, Math.round((3 + a * 8) * m));
    for (let i = 0; i < n; i++) {
      const far = Math.random() < 0.3;
      coneDir(_a, _dir, far ? 0.6 : 0.95);
      const speed = (far ? rand(1.4, 3.0) : rand(0.15, 1.1)) * sq;
      const r0 = rand(0.1, 0.2) * Math.pow(a, 0.35);
      const r1 = Math.min(1.6, r0 * rand(4, 6.5) * (0.75 + 0.25 * sq));
      this._blood(
        position.x + rand(-0.1, 0.1), position.y + rand(-0.1, 0.1), position.z + rand(-0.1, 0.1),
        _a.x * speed, _a.y * speed, _a.z * speed,
        r0, r1, rand(0.6, 1.1), rand(3.2, 5), rand(0.38, 0.5), rand(1.5, 2.8),
      );
    }
    // a slower core: a few overlapping puffs swelling less than the billows,
    // so the centre stays the darkest part while the edges thin
    const core = a >= 1 ? 3 : 2;
    for (let i = 0; i < core; i++) {
      this._blood(
        position.x + rand(-0.06, 0.06), position.y + rand(-0.06, 0.06), position.z + rand(-0.06, 0.06),
        _dir.x * 0.25 + rand(-0.1, 0.1), _dir.y * 0.25 + rand(-0.1, 0.1), _dir.z * 0.25 + rand(-0.1, 0.1),
        0.12 * sq, Math.min(1.3, 0.6 * sq), rand(0.4, 0.6), rand(3.6, 5), 0.5, 1.5,
      );
    }
    // fast streamers — long thin jets that leave a line of blood behind them
    if (a >= 1.2) {
      const strands = Math.round((a >= 1.8 ? 4 : 2) * Math.max(0.5, m));
      for (let s = 0; s < strands; s++) {
        coneDir(_b, _dir, 0.55);
        const len = rand(0.8, 1.6) * sq;
        // puffs must overlap or the strand reads as a dotted line
        const steps = Math.max(5, Math.round(12 * m));
        for (let k = 0; k < steps; k++) {
          const f = (k + rand(0.6, 1.2)) / steps;
          const sp = 0.3 + f * 1.3;
          const j = 0.03 + 0.06 * f;
          this._blood(
            position.x + _b.x * len * f + rand(-j, j), position.y + _b.y * len * f + rand(-j, j), position.z + _b.z * len * f + rand(-j, j),
            _b.x * sp, _b.y * sp, _b.z * sp,
            0.05 + 0.025 * (1 - f), rand(0.16, 0.3), rand(0.4, 0.7), rand(3, 5), 0.45 * (1 - f * 0.45), 2.2,
          );
        }
      }
    }
  }

  /**
   * One thin wisp of blood — used for continuous bleeding from wounds: small,
   * faint puffs that the moving wound strings out into a long thin trail.
   */
  spawnBloodTendril(position, size = 1, direction = null) {
    if (!position) return;
    if (direction !== _dir) this._corpseBleed = this._nearCorpse(position); // (spawnBlood's trickles: already set)
    let vx = rand(-0.1, 0.1);
    let vy = rand(-0.04, 0.1);
    let vz = rand(-0.1, 0.1);
    if (direction) {
      vx += direction.x * 0.5;
      vy += direction.y * 0.5;
      vz += direction.z * 0.5;
    }
    this._blood(
      position.x, position.y, position.z, vx, vy, vz,
      0.03 * size, rand(0.1, 0.22) * size, rand(0.3, 0.55), rand(3, 5.5), rand(0.32, 0.45), 1.2,
    );
  }

  spawnBubbles(position, count = 10, { speed = 1, size = 1, spread = 0.2, life = 0 } = {}) {
    if (!position) return;
    const n = Math.max(1, Math.round(count * (0.4 + 0.6 * this.budget)));
    for (let i = 0; i < n; i++) {
      coneDir(_a, _up, 1.6);
      const sp = speed * rand(0.2, 1);
      const r = (0.003 + Math.pow(Math.random(), 2.6) * 0.03) * size;
      this.bubbles.spawn(
        position.x + rand(-spread, spread), position.y + rand(-spread, spread), position.z + rand(-spread, spread),
        _a.x * sp, _a.y * sp * 0.6 + 0.2, _a.z * sp,
        r, life > 0 ? life * rand(0.7, 1.3) : rand(2.5, 6), rand(0.75, 1),
      );
    }
  }

  /**
   * Water burst at a hit: particulate spray along the normal, a puff of
   * cavitation micro-bubbles and a few bigger ones (no pressure shell — at
   * this size it read as a glass ball around the hit).
   */
  spawnImpact(position, normal, { strength = 1 } = {}) {
    if (!position) return;
    strength = Math.min(3, Math.max(0.1, strength));
    if (normal && normal.lengthSq() > 1e-8) _dir.copy(normal).normalize();
    else coneDir(_dir, _up, 1);
    // cavitation: a tight, fast-spreading fizz of tiny bubbles that dies quickly
    const nc = Math.round((6 + 10 * strength) * (0.5 + 0.5 * this.budget));
    for (let i = 0; i < nc; i++) {
      coneDir(_a, _dir, 1.4);
      const sp = rand(1.5, 4) * (0.6 + 0.4 * strength);
      this.bubbles.spawn(
        position.x, position.y, position.z, _a.x * sp, _a.y * sp, _a.z * sp,
        0.0012 + Math.pow(Math.random(), 2) * 0.003, rand(0.5, 1.3), 0.8,
      );
    }
    const n = Math.round((8 + 16 * strength) * this.budget);
    for (let i = 0; i < n; i++) {
      coneDir(_a, _dir, 0.9);
      const sp = rand(1.2, 4.5) * (0.6 + 0.4 * strength);
      const shade = rand(0.55, 1);
      this.dust.spawn(
        position.x, position.y, position.z,
        _a.x * sp, _a.y * sp, _a.z * sp,
        rand(0.006, 0.018), rand(0.7, 2.0), rand(0.5, 0.9),
        SILT[0] * shade, SILT[1] * shade, SILT[2] * shade,
        rand(3, 5), 0.04, 0.35,
      );
    }
    const nb = Math.round(3 + 7 * strength);
    for (let i = 0; i < nb; i++) {
      coneDir(_a, _dir, 0.8);
      const sp = rand(0.6, 2.2) * strength;
      this.bubbles.spawn(
        position.x, position.y, position.z, _a.x * sp, _a.y * sp, _a.z * sp,
        0.002 + Math.pow(Math.random(), 3) * 0.012, rand(1.5, 3.5), 0.9,
      );
    }
  }

  /**
   * Pressure wave from a tail slam / roar (or a knife thrust's small pop): a
   * radial burst of bubbles and particulate carries the front. A big wave
   * adds a sphere of cavitation bubbles and specks flung out about as far as
   * the wave reaches (travel ≈ speed / drag), and on screen PostFX's
   * distortion ring (the roar pulse — PostFX's own for a roar, the slam
   * listener above for the tail slam). No pressure globe (it read as a glass
   * ball) and a flat ring only for mid-sized waves (soft, fading edge-on).
   */
  spawnShockwave(position, radius = 6, { strength = 1, normal = null } = {}) {
    if (!position) return;
    radius = Math.max(0.5, radius);
    const n = normal && normal.lengthSq() > 1e-8 ? _b.copy(normal).normalize() : _b.set(0, 1, 0);
    const dur = 0.75 + radius * 0.04;
    if (radius >= 2 && radius <= RING_MAX_RADIUS) this.pressure.ring(position, n, radius * 1.15, dur * 1.2, 0.3 * strength, 0.1);
    if (radius > RING_MAX_RADIUS) {
      const k = Math.min(1.5, strength);
      const nf = Math.round(80 * this.budget * k);
      for (let i = 0; i < nf; i++) {
        coneDir(_dir, _up, 8);
        const sp = radius * rand(1.5, 2.3);
        const shade = rand(0.75, 1.05);
        this.dust.spawn(
          position.x + _dir.x * radius * 0.12, position.y + _dir.y * radius * 0.12, position.z + _dir.z * radius * 0.12,
          _dir.x * sp, _dir.y * sp, _dir.z * sp,
          rand(0.02, 0.045), rand(1.2, 2.2), rand(0.55, 0.9),
          SILT[0] * shade, SILT[1] * shade, SILT[2] * shade,
          2.2, 0.02, 0.35,
        );
      }
      // bubbles brake harder sideways (≈2.6 / s) and float up: a shell of
      // sparkles that slows and drifts upward behind the front
      const nc = Math.round(70 * this.budget * k);
      for (let i = 0; i < nc; i++) {
        coneDir(_dir, _up, 8);
        const sp = radius * rand(1.4, 2.2);
        this.bubbles.spawn(
          position.x + _dir.x * radius * 0.1, position.y + _dir.y * radius * 0.1, position.z + _dir.z * radius * 0.1,
          _dir.x * sp, _dir.y * sp * 0.6, _dir.z * sp,
          0.003 + Math.pow(Math.random(), 2.5) * 0.016, rand(1.4, 3), 0.9,
        );
      }
    }
    // build an in-plane basis for radial spawning
    _a.set(1, 0, 0);
    if (Math.abs(n.dot(_a)) > 0.9) _a.set(0, 0, 1);
    const t1 = _a.cross(n).normalize();
    const t2 = _tmp.crossVectors(n, t1);
    // particle counts scale down for small pops (a knife thrust vs a tail slam)
    const size = Math.min(1, 0.15 + radius / 7);
    const nb = Math.round(48 * this.budget * size);
    for (let i = 0; i < nb; i++) {
      const ang = (i / nb) * Math.PI * 2 + rand(-0.1, 0.1);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dx = t1.x * c + t2.x * s;
      const dy = t1.y * c + t2.y * s;
      const dz = t1.z * c + t2.z * s;
      const r0 = radius * rand(0.1, 0.25);
      const sp = radius * rand(0.9, 1.6);
      this.bubbles.spawn(
        position.x + dx * r0, position.y + dy * r0 + rand(-0.3, 0.3), position.z + dz * r0,
        dx * sp, dy * sp, dz * sp,
        0.003 + Math.pow(Math.random(), 2.5) * 0.02, rand(1.8, 4), 0.9,
      );
    }
    const nd = Math.round(70 * this.budget * size);
    for (let i = 0; i < nd; i++) {
      coneDir(_dir, n, 3);
      const sp = radius * rand(0.6, 1.8);
      const shade = rand(0.5, 1);
      this.dust.spawn(
        position.x + _dir.x * radius * 0.15, position.y + _dir.y * radius * 0.15, position.z + _dir.z * radius * 0.15,
        _dir.x * sp, _dir.y * sp, _dir.z * sp,
        rand(0.008, 0.025), rand(1.2, 3), rand(0.4, 0.8),
        SILT[0] * shade, SILT[1] * shade, SILT[2] * shade,
        rand(1.8, 3), 0.03, 0.3,
      );
    }
    // near the bottom the wave lifts a ring of silt
    const env = this.game.env;
    const floor = env?.getSeabedHeight ? env.getSeabedHeight(position.x, position.z) : -1e9;
    if (position.y - floor < radius * 0.7 && radius > 2) {
      const ns = Math.round(12 * this.budget) + 4;
      for (let i = 0; i < ns; i++) {
        const ang = (i / ns) * Math.PI * 2;
        const rr = radius * rand(0.3, 0.7);
        const x = position.x + Math.cos(ang) * rr;
        const z = position.z + Math.sin(ang) * rr;
        const y = env.getSeabedHeight(x, z) + 0.3;
        const sp = radius * 0.25;
        this.clouds.spawn(
          x, y, z, Math.cos(ang) * sp, rand(0.2, 0.6), Math.sin(ang) * sp,
          rand(0.4, 0.7), rand(1.8, 3.2), rand(0.3, 0.6), rand(7, 11), rand(0.35, 0.5),
          SEDIMENT[0], SEDIMENT[1], SEDIMENT[2], CLOUD_KIND.sediment, 0.9, -0.01,
        );
      }
    }
  }

  /**
   * (extra) Bright glint + a few fast specks — knife meeting teeth on a parry.
   * Underwater there are no real sparks, so this is a short flash of
   * scattered light and shed tooth/bone fragments.
   */
  spawnSpark(position, normal, strength = 1) {
    if (!position) return;
    if (normal && normal.lengthSq() > 1e-8) _dir.copy(normal).normalize();
    else coneDir(_dir, _up, 1);
    this.dust.spawn(position.x, position.y, position.z, 0, 0, 0, 0.32 * strength, 0.14, 1, 5, 5.5, 6, 0, 0, 0);
    this.dust.spawn(position.x, position.y, position.z, 0, 0, 0, 0.9 * strength, 0.2, 0.45, 1.6, 1.9, 2.2, 0, 0, 0);
    const n = Math.round(14 * strength * (0.5 + 0.5 * this.budget));
    for (let i = 0; i < n; i++) {
      coneDir(_a, _dir, 1.1);
      const sp = rand(3, 8) * strength;
      this.dust.spawn(
        position.x, position.y, position.z, _a.x * sp, _a.y * sp, _a.z * sp,
        rand(0.008, 0.016), rand(0.25, 0.6), 1, 3.2, 3.4, 3.4, rand(6, 9), 0.2, 0.05,
      );
    }
    // (no pressure shell: PostFX's parry ring distorts the screen around it)
  }

  /** Silt cloud kicked up from the seabed. amount ~0.3 .. 3 */
  spawnSediment(position, amount = 1) {
    if (!position) return;
    const n = Math.max(1, Math.round((1 + amount * 4) * this.budget));
    const sq = Math.sqrt(amount);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = rand(0.2, 1.1) * sq;
      const shade = rand(0.75, 1.05);
      this.clouds.spawn(
        position.x + rand(-0.3, 0.3) * sq, position.y + rand(0, 0.3), position.z + rand(-0.3, 0.3) * sq,
        Math.cos(ang) * sp, rand(0.15, 0.6) * sq, Math.sin(ang) * sp,
        rand(0.2, 0.4) * sq, rand(1.0, 2.2) * sq, rand(0.3, 0.6), rand(6, 10), rand(0.3, 0.5),
        SEDIMENT[0] * shade, SEDIMENT[1] * shade, SEDIMENT[2] * shade, CLOUD_KIND.sediment, 1.1, -0.012,
      );
    }
    const nd = Math.round(10 * amount * this.budget);
    for (let i = 0; i < nd; i++) {
      coneDir(_a, _up, 1.2);
      const sp = rand(0.4, 1.8) * sq;
      this.dust.spawn(
        position.x, position.y + 0.1, position.z, _a.x * sp, Math.abs(_a.y) * sp, _a.z * sp,
        rand(0.008, 0.02), rand(2, 4), rand(0.5, 0.9), SEDIMENT[0], SEDIMENT[1], SEDIMENT[2], 2.2, 0.12, 0.7,
      );
    }
  }

  /** Continuous bleeding from a cut on an enemy (follows the enemy). */
  addWound(enemy, worldPoint, opts) {
    this.emitters.addWound(enemy, worldPoint, opts);
  }

  /** Optional per the contract — the trail reads player.getActiveAttack() itself. */
  spawnSlashTrail() {}

  // ---------------------------------------------------------------------------

  _blood(x, y, z, vx, vy, vz, r0, r1, growK, life, alpha, drag) {
    const v = rand(0.8, 1.15);
    const corpse = this._corpseBleed;
    if (corpse) life = Math.min(life, rand(CORPSE_BLEED_LIFE[0], CORPSE_BLEED_LIFE[1]));
    this.clouds.spawn(
      x, y, z, vx, vy, vz, r0, r1, growK, life, Math.min(BLOOD_ALPHA_MAX, alpha),
      BLOOD[0] * v, BLOOD[1] * v, BLOOD[2] * v, CLOUD_KIND.blood, drag, 0.004,
      corpse ? CORPSE_BLEED_FADE : -1,
    );
  }

  /** Is `p` on (or beside) a dead enemy's body — i.e. is this blood a corpse bleeding? */
  _nearCorpse(p) {
    const en = this.game.enemies?.enemies;
    if (!en) return false;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (!e || e.alive || !e.position) continue;
      const r = (e.length ?? 5) * 0.6 + 1;
      if (e.position.distanceToSquared(p) < r * r) return true;
    }
    return false;
  }

  _updateShared() {
    const game = this.game;
    const env = game.env;
    const sh = this.shared;
    // sun radiance at the camera depth (env already absorbed it down to here);
    // particles at other depths apply the relative absorption in the shader
    const dim = env?.uniforms?.uEnvDim?.value ?? 1;
    const sun = env?.sun;
    if (sun?.color) {
      _sunCol.copy(sun.color).multiplyScalar(Math.min(6, sun.intensity ?? 2) * 0.45 * dim);
      sh.uSunColor.value.copy(_sunCol);
    }
    const wc = env?.waterColor;
    if (wc) {
      const g = AMBIENT_GAIN * dim;
      sh.uAmbient.value.setRGB(wc.r * g + 0.002, wc.g * g + 0.004, wc.b * g + 0.005);
    }
    const cam = game.camera;
    sh.uCamDepth.value = Math.max(0, this.surfaceY - cam.position.y);
    const sd = env?.sunDirection;
    if (sd) sh.uSunView.value.copy(sd).transformDirection(cam.matrixWorldInverse);
    game.renderer.getDrawingBufferSize(_size);
    sh.uViewportH.value = _size.y || 720;
  }

  _gatherStirrers() {
    const st = this._stir;
    let n = 0;
    const p = this.game.player;
    if (p?.velocity && p.velocity.lengthSq() > 1) {
      const o = n * 8;
      st[o] = p.position.x; st[o + 1] = p.position.y; st[o + 2] = p.position.z;
      st[o + 3] = p.velocity.x; st[o + 4] = p.velocity.y; st[o + 5] = p.velocity.z;
      st[o + 6] = 1.1;
      n++;
    }
    const en = this.game.enemies?.enemies;
    if (en) {
      for (let i = 0; i < en.length && n < 8; i++) {
        const e = en[i];
        if (!e?.velocity || e.velocity.lengthSq() < 1) continue;
        const o = n * 8;
        st[o] = e.position.x; st[o + 1] = e.position.y; st[o + 2] = e.position.z;
        st[o + 3] = e.velocity.x; st[o + 4] = e.velocity.y; st[o + 5] = e.velocity.z;
        st[o + 6] = Math.max(1.5, (e.length ?? 5) * 0.4);
        n++;
      }
    }
    this._stirCount = n;

    // solid spheres for clouds to stay out of: big hurtboxes + the player
    const so = this._solids;
    let m = 0;
    if (p?.position) {
      so[0] = p.position.x; so[1] = p.position.y; so[2] = p.position.z; so[3] = (p.radius ?? 0.45) + 0.1;
      m = 1;
    }
    if (en) {
      for (let i = 0; i < en.length; i++) {
        const hbs = en[i]?.hurtboxes;
        if (!hbs) continue;
        for (let h = 0; h < hbs.length && m < 32; h++) {
          const hb = hbs[h];
          if (hb.radius < 0.35 || hb.part === 'eye') continue;
          const o = m * 4;
          so[o] = hb.center.x; so[o + 1] = hb.center.y; so[o + 2] = hb.center.z; so[o + 3] = hb.radius * 0.9;
          m++;
        }
      }
    }
    this._solidCount = m;
  }

  update(dt) {
    this.time += dt;
    this._updateShared();
    const cam = this.game.camera;
    cam.getWorldDirection(_camDir);
    this._gatherStirrers();

    const attack = this.game.player?.getActiveAttack?.() ?? null;
    this.trail.update(dt, attack);
    this.emitters.update(dt);
    this.clouds.update(dt, cam.position, _camDir, this._stir, this._stirCount, this._solids, this._solidCount);
    this.bubbles.update(dt);
    this.dust.update(dt);
    this.pressure.update(dt);
  }

  /** Remove every live particle (e.g. hard scene reset). */
  clear() {
    this.clouds.clear();
    this.bubbles.clear();
    this.dust.clear();
  }
}
