// FishSchools — hundreds of small silvery fish in a single InstancedMesh.
//
// Simulation (boids-lite, allocation-free, typed arrays):
//   - Each school has a centre that wanders around a "home" orbiting the
//     player (so there is always life in view) and swerves away from threats.
//   - Every fish owns a slot in a milling, travel-stretched formation around
//     the centre (cohesion), matches the school velocity (alignment) and is
//     pushed away from close neighbours found through a spatial hash
//     (separation).
//   - Threats (sharks, the player, blood clouds) cause individual fish to
//     burst away — sideways from a charging predator — producing the classic
//     "flash expansion", after which the school slowly reforms.
// Rendering: procedural fish geometry, counter-shaded vertex colours, a
// metallic MeshStandardMaterial reflecting a procedural Snell's-window
// environment (fish flash silver when they turn), tail wag in the vertex
// shader driven by a per-instance (phase, intensity) attribute.
//   - The reflection dims with depth (the env map is built from surface
//     radiance) and fish beyond ~10 m fade to dark silhouettes before the fog,
//     so distant schools read as shoals of shadows, not fields of 1-px glints.
//   - No shadow casting: 0.1-0.6 m fish against a ~4 cm shadow texel add
//     nothing visible (and the depth material ignores the tail wag) but were
//     the largest shadow caster in the scene.
//   - update() writes every fish's instance matrix into a staging array in
//     fish order; prepareRender(camera) — run from the scene's chained
//     onBeforeRender (AmbientLife) with the camera actually rendering —
//     culls whole schools against that camera's frustum and packs the
//     visible ones at the front of the instance buffer (`mesh.count` trims
//     the draw). Culling with the render camera means a hard camera cut never
//     drops a school for a frame.
import * as THREE from 'three';
import { WORLD } from '../../core/config.js';
import { createFishGeometry } from './fishGeometry.js';
import { chainShaderPatch, clamp, createRng, envPatch } from './util.js';

const ENV_INTENSITY = 1.15; // at the surface
const ENV_DEPTH_SCALE = 28; // m: e-folding depth of the reflected surface light

const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

const SPECIES = {
  sardine: { length: 0.22, cruise: 1.5, burst: 6.5, radius: 2.6, height: 2.3, tint: [0.92, 0.97, 1.0], sep: 0.34 },
  scad: { length: 0.34, cruise: 1.7, burst: 6.0, radius: 3.1, height: 2.5, tint: [1.0, 0.96, 0.84], sep: 0.48 },
  jack: { length: 0.62, cruise: 2.0, burst: 5.5, radius: 3.8, height: 2.8, tint: [0.8, 0.86, 0.9], sep: 0.6 },
  fry: { length: 0.13, cruise: 1.2, burst: 5.0, radius: 1.9, height: 1.6, tint: [0.86, 1.0, 0.95], sep: 0.22 },
};

const LAYOUT = {
  high: [
    ['sardine', 210],
    ['scad', 140],
    ['jack', 56],
    ['fry', 170],
  ],
  medium: [
    ['sardine', 130],
    ['scad', 90],
    ['jack', 36],
  ],
  low: [
    ['sardine', 80],
    ['scad', 56],
  ],
};

// spatial hash
const CELL = 0.6;
const INV_CELL = 1 / CELL;
const TABLE = 4096;
const MAX_NEIGHBOURS = 7;

function hashCell(ix, iy, iz) {
  return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & (TABLE - 1);
}

// Initial culling radius of a school (formation ball, stretched when travelling).
function radius0(sp) {
  return sp.radius * 2 + sp.height;
}

// Culling-sphere margin over a school's measured extent (which already
// includes one fish length): covers the vertex-shader tail wag.
const CULL_PAD = 0.5; // m

const SWIM_GLSL = /* glsl */ `
attribute vec2 aSwim; // x = tail-beat phase (rad), y = intensity 0..1
float fishWag(float z, float ph, float k) {
  float tailW = smoothstep(0.22, -0.5, z);
  float amp = 0.03 + 0.08 * k;
  float w = sin(ph - z * 6.5) * amp * tailW * tailW;
  w += sin(ph + 2.4) * amp * 0.14 * (1.0 - tailW); // head recoil
  return w;
}
`;

export class FishSchools {
  constructor(game, parent, { envMap, quality = 'high', seed = 7 } = {}) {
    this.game = game;
    const rng = createRng(seed);
    this.rng = rng;
    const layout = LAYOUT[quality] ?? LAYOUT.high;

    // ---- schools ----
    this.schools = [];
    let total = 0;
    layout.forEach(([speciesName, count], si) => {
      const sp = SPECIES[speciesName];
      const homeAngle = (si / layout.length) * Math.PI * 2 + rng.range(-0.4, 0.4);
      this.schools.push({
        species: speciesName,
        sp,
        start: total,
        count,
        center: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        anchor: new THREE.Vector3(),
        homeAngle,
        homeDrift: rng.sign() * rng.range(0.012, 0.03),
        homeDist: rng.range(15, 28),
        homeY: rng.range(-4, 7),
        wanderPhase: [rng() * 10, rng() * 10, rng() * 10],
        heading: rng() * Math.PI * 2,
        travel: 0,
        panic: 0,
        millDir: rng.sign(),
        millRate: sp.cruise * rng.range(0.35, 0.55),
        placed: false,
        extent: radius0(sp), // max fish distance from the centre (last frame), m
        visible: true,
      });
      total += count;
    });
    this.total = total;
    const N = total;
    this._ext2 = new Float32Array(this.schools.length);

    // ---- per-fish state ----
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this.vz = new Float32Array(N);
    this.slotR = new Float32Array(N);
    this.slotTh = new Float32Array(N);
    this.slotY = new Float32Array(N);
    this.phase = new Float32Array(N);
    this.rate = new Float32Array(N);
    this.scale = new Float32Array(N);
    this.fear = new Float32Array(N);
    this.schoolOf = new Uint8Array(N);
    this.cellHead = new Int32Array(TABLE);
    this.cellNext = new Int32Array(N);

    for (let s = 0; s < this.schools.length; s++) {
      const sc = this.schools[s];
      const { radius, height } = sc.sp;
      for (let k = 0; k < sc.count; k++) {
        const i = sc.start + k;
        this.schoolOf[i] = s;
        // ellipsoidal milling ball (slightly sparser core)
        const rr = radius * (0.08 + 0.92 * Math.pow(rng(), 0.6));
        const edge = rr / radius;
        this.slotR[i] = rr;
        this.slotTh[i] = rng() * Math.PI * 2;
        this.slotY[i] = (rng() - 0.5) * height * (1 - 0.45 * edge * edge);
        this.phase[i] = rng() * Math.PI * 2;
        this.rate[i] = rng.range(0.85, 1.15);
        this.scale[i] = sc.sp.length * rng.range(0.82, 1.15);
      }
    }

    // ---- rendering ----
    // Staging in fish order (written by update), packed per visible school
    // into the instance buffers by prepareRender.
    this._mat = new Float32Array(N * 16);
    this._swimAll = new Float32Array(N * 2);
    this._dirty = false; // staging changed since the last pack
    const geo = quality === 'low' ? createFishGeometry({ rings: 9, radial: 7 }) : createFishGeometry();
    this.swim = new Float32Array(N * 2);
    const swimAttr = new THREE.InstancedBufferAttribute(this.swim, 2);
    swimAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSwim', swimAttr);
    this.swimAttr = swimAttr;

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.6,
      roughness: 0.3,
      envMap: envMap ?? null,
      envMapIntensity: ENV_INTENSITY,
      side: THREE.DoubleSide,
    });
    mat.name = 'AmbientLife.fish';
    envPatch(game, mat);
    // Linear water colour the far fish fade toward (copied from env each frame).
    this.uniforms = { uFishWater: { value: new THREE.Color(0x0b3140) } };
    const U = this.uniforms;
    chainShaderPatch(mat, 'ambient-fish-swim-v2', (shader) => {
      shader.uniforms.uFishWater = U.uFishWater;
      // Past ~10 m the silvery flanks stop reading: fade to a dark
      // silhouette (≈55 % at 20 m, ≈90 % at 25 m; then the scene fog veils
      // it). Kills the sub-pixel glints of distant schools.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uFishWater;')
        .replace(
          '#include <opaque_fragment>',
          `outgoingLight = mix( outgoingLight, uFishWater * 0.6, smoothstep( 8.0, 30.0, length( vViewPosition ) ) );
          #include <opaque_fragment>`,
        );
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${SWIM_GLSL}`)
        .replace(
          '#include <defaultnormal_vertex>',
          `{
            float zz = position.z;
            float slope = (fishWag(zz + 0.01, aSwim.x, aSwim.y) - fishWag(zz - 0.01, aSwim.x, aSwim.y)) / 0.02;
            objectNormal.z -= slope * objectNormal.x;
          }
          #include <defaultnormal_vertex>`,
        )
        .replace(
          '#include <project_vertex>',
          `transformed.x += fishWag(position.z, aSwim.x, aSwim.y);
          #include <project_vertex>`,
        );
    });
    this.material = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.name = 'AmbientLife.fishSchools';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances roam far outside the base bounds; culled per school
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const tmpColor = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const sc = this.schools[this.schoolOf[i]];
      const b = rng.range(0.86, 1.06);
      tmpColor.setRGB(sc.sp.tint[0] * b, sc.sp.tint[1] * b, sc.sp.tint[2] * b);
      mesh.setColorAt(i, tmpColor);
    }
    mesh.instanceColor.needsUpdate = true;
    // Per-fish colours by fish index; the instance buffer is packed by visible
    // school, so colours are re-packed whenever the visible set changes.
    this.baseColor = mesh.instanceColor.array.slice();
    this._colorMask = (1 << this.schools.length) - 1; // school set the colours are packed for
    this._packMask = -1; // school set the matrices are packed for (-1: none yet)
    this.mesh = mesh;
    parent.add(mesh);
  }

  // Which schools are inside `cam`'s frustum (the camera about to render, so
  // the spheres only pad for the tail wag). Returns a bitmask.
  _cullSchools(cam) {
    if (!cam) return (1 << this.schools.length) - 1;
    // three has already refreshed matrixWorld(Inverse) for this render
    _projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projView);
    let mask = 0;
    for (let s = 0; s < this.schools.length; s++) {
      const sc = this.schools[s];
      _sphere.center.copy(sc.center);
      _sphere.radius = sc.extent + CULL_PAD;
      sc.visible = !sc.placed || _frustum.intersectsSphere(_sphere);
      if (sc.visible) mask |= 1 << s;
    }
    return mask;
  }

  /**
   * Called right before every render of the scene (AmbientLife chains
   * scene.onBeforeRender) with the camera in use: depth-dimmed look, school
   * culling and packing of the visible schools' instances. Re-packs only when
   * the simulation stepped or the visible set changed.
   */
  prepareRender(camera) {
    if (!camera) return;
    this._updateLook(camera);
    const mask = this._cullSchools(camera);
    if (!this._dirty && mask === this._packMask) return;
    const src = this._mat;
    const dst = this.mesh.instanceMatrix.array;
    const swimSrc = this._swimAll;
    const swim = this.swim;
    let w = 0; // packed instance slot
    for (let s = 0; s < this.schools.length; s++) {
      const sc = this.schools[s];
      if (!sc.visible) continue;
      // contiguous fish range [start, start + count) → slots [w, w + count)
      const m0 = sc.start * 16;
      const m1 = m0 + sc.count * 16;
      for (let k = m0, o = w * 16; k < m1; k++, o++) dst[o] = src[k];
      const s0 = sc.start * 2;
      const s1 = s0 + sc.count * 2;
      for (let k = s0, o = w * 2; k < s1; k++, o++) swim[o] = swimSrc[k];
      w += sc.count;
    }
    if (mask !== this._colorMask) {
      this._colorMask = mask;
      this._packColors();
    }
    this._packMask = mask;
    this._dirty = false;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.swimAttr.needsUpdate = true;
  }

  // Place a school (and its fish in formation) around a point.
  _place(sc, x, y, z) {
    sc.center.set(x, y, z);
    sc.anchor.set(x, y, z);
    sc.vel.set(0, 0, 0);
    for (let k = 0; k < sc.count; k++) {
      const i = sc.start + k;
      const r = this.slotR[i];
      const th = this.slotTh[i];
      this.px[i] = x + Math.cos(th) * r;
      this.py[i] = y + this.slotY[i];
      this.pz[i] = z + Math.sin(th) * r;
      // tangential (milling) start velocity
      const sp = sc.sp.cruise * 0.6 * sc.millDir;
      this.vx[i] = -Math.sin(th) * sp;
      this.vy[i] = 0;
      this.vz[i] = Math.cos(th) * sp;
      this.fear[i] = 0;
    }
    sc.placed = true;
  }

  _homeOf(sc, out, time) {
    const p = this.game.player?.position;
    const px = p ? p.x : WORLD.playerSpawn[0];
    const py = p ? p.y : WORLD.playerSpawn[1];
    const pz = p ? p.z : WORLD.playerSpawn[2];
    const w = sc.wanderPhase;
    out.x = px + Math.cos(sc.homeAngle) * sc.homeDist + Math.sin(time * 0.05 + w[0]) * 7;
    out.y = py + sc.homeY + Math.sin(time * 0.07 + w[1]) * 2.5;
    out.z = pz + Math.sin(sc.homeAngle) * sc.homeDist + Math.cos(time * 0.045 + w[2]) * 7;
    // keep inside the arena volume
    const rMax = WORLD.arenaRadius - 6;
    const rh = Math.sqrt(out.x * out.x + out.z * out.z);
    if (rh > rMax) {
      out.x *= rMax / rh;
      out.z *= rMax / rh;
    }
    const floor = this._seabed(out.x, out.z);
    out.y = clamp(out.y, floor + sc.sp.height + 2.5, WORLD.surfaceY - sc.sp.height - 2.5);
    return out;
  }

  _seabed(x, z) {
    const env = this.game.env;
    if (env?.getSeabedHeight) {
      const h = env.getSeabedHeight(x, z);
      if (Number.isFinite(h)) return h;
    }
    return WORLD.floorY;
  }

  update(dt, threats, time) {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 20);
    const T = threats.list;
    const TC = threats.count;

    // ---------------- school centres ----------------
    for (let s = 0; s < this.schools.length; s++) {
      const sc = this.schools[s];
      sc.homeAngle += sc.homeDrift * dt;
      const anchor = this._homeOf(sc, sc.anchor, time);
      if (!sc.placed) {
        this._place(sc, anchor.x, anchor.y, anchor.z);
        continue;
      }
      const c = sc.center;
      let dx = anchor.x - c.x;
      let dy = anchor.y - c.y;
      let dz = anchor.z - c.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
      if (dist > 80) {
        // fell hopelessly behind (respawn / teleport): re-place out in the murk
        this._place(sc, anchor.x, anchor.y, anchor.z);
        continue;
      }
      const catchUp = dist > 30 ? Math.min(4.5, sc.sp.cruise + (dist - 30) * 0.1) : sc.sp.cruise;
      const want = Math.min(catchUp, dist * 0.22) / dist;
      let tx = dx * want;
      let ty = dy * want;
      let tz = dz * want;

      // school-level avoidance
      for (let k = 0; k < TC; k++) {
        const t = T[k];
        dx = c.x - t.x;
        dy = c.y - t.y;
        dz = c.z - t.z;
        const R = t.radius + sc.sp.radius + 3;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) + 1e-4;
        const k1 = 1 - d / R;
        const f = k1 * sc.sp.burst * 0.55 * Math.min(1.5, t.strength);
        tx += (dx / d) * f;
        ty += (dy / d) * f * 0.6;
        tz += (dz / d) * f;
        sc.panic = Math.max(sc.panic, k1 * Math.min(1, t.strength));
      }
      const steer = 1 - Math.exp(-dt * (0.7 + 2.5 * sc.panic));
      sc.vel.x += (tx - sc.vel.x) * steer;
      sc.vel.y += (ty - sc.vel.y) * steer;
      sc.vel.z += (tz - sc.vel.z) * steer;
      c.addScaledVector(sc.vel, dt);
      const floor = this._seabed(c.x, c.z);
      c.y = clamp(c.y, floor + sc.sp.height + 1.2, WORLD.surfaceY - sc.sp.height - 1.2);

      const hs = Math.sqrt(sc.vel.x * sc.vel.x + sc.vel.z * sc.vel.z);
      if (hs > 0.15) {
        const target = Math.atan2(sc.vel.x, sc.vel.z);
        let dh = target - sc.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        sc.heading += dh * (1 - Math.exp(-dt * 0.8));
      }
      const travelTarget = clamp(hs / (sc.sp.cruise * 1.1), 0, 1);
      sc.travel += (travelTarget - sc.travel) * (1 - Math.exp(-dt * 0.6));
      sc.panic = Math.max(0, sc.panic - dt * 0.22);
    }

    // ---------------- spatial hash (separation) ----------------
    const N = this.total;
    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const vx = this.vx;
    const vy = this.vy;
    const vz = this.vz;
    const head = this.cellHead;
    const next = this.cellNext;
    head.fill(-1);
    for (let i = 0; i < N; i++) {
      const h = hashCell(Math.floor(px[i] * INV_CELL), Math.floor(py[i] * INV_CELL), Math.floor(pz[i] * INV_CELL));
      next[i] = head[h];
      head[h] = i;
    }

    const ext2 = this._ext2;
    ext2.fill(0);

    // ---------------- fish ----------------
    const surfaceLimit = WORLD.surfaceY - 1.0;
    const nearFloorY = WORLD.floorY + 9;
    const swim = this._swimAll;
    const arr = this._mat;
    for (let i = 0; i < N; i++) {
      const si = this.schoolOf[i];
      const sc = this.schools[si];
      const sp = sc.sp;
      const c = sc.center;

      // ---- formation slot (cohesion target) ----
      const r = this.slotR[i];
      const th = (this.slotTh[i] += (dt * sc.millRate * sc.millDir * (1 - 0.65 * sc.travel)) / Math.max(r, 0.6));
      const cosH = Math.cos(sc.heading);
      const sinH = Math.sin(sc.heading);
      const spread = 1 + sc.panic * 1.3;
      const along = Math.sin(th) * r * (1 + 0.9 * sc.travel) * spread;
      const across = Math.cos(th) * r * (1 - 0.25 * sc.travel) * spread;
      // heading basis: forward (sinH, 0, cosH), right (cosH, 0, -sinH)
      const tx = c.x + cosH * across + sinH * along;
      const ty = c.y + this.slotY[i] * spread;
      const tz = c.z - sinH * across + cosH * along;

      let dx = tx - px[i];
      let dy = ty - py[i];
      let dz = tz - pz[i];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
      const pull = Math.min(dist * 1.1, sp.cruise * 1.6) / dist;
      // alignment: school velocity + pull toward the slot
      let wx = sc.vel.x + dx * pull;
      let wy = sc.vel.y + dy * pull;
      let wz = sc.vel.z + dz * pull;

      // ---- separation ----
      const sep = sp.sep;
      const sep2 = sep * sep;
      const cx = Math.floor(px[i] * INV_CELL);
      const cy = Math.floor(py[i] * INV_CELL);
      const cz = Math.floor(pz[i] * INV_CELL);
      let found = 0;
      for (let ox = -1; ox <= 1 && found < MAX_NEIGHBOURS; ox++) {
        for (let oy = -1; oy <= 1 && found < MAX_NEIGHBOURS; oy++) {
          for (let oz = -1; oz <= 1 && found < MAX_NEIGHBOURS; oz++) {
            let j = head[hashCell(cx + ox, cy + oy, cz + oz)];
            while (j !== -1) {
              if (j !== i) {
                const ex = px[i] - px[j];
                const ey = py[i] - py[j];
                const ez = pz[i] - pz[j];
                const e2 = ex * ex + ey * ey + ez * ez;
                if (e2 < sep2 && e2 > 1e-8) {
                  const e = Math.sqrt(e2);
                  const push = ((sep - e) / sep) * 2.2 / e;
                  wx += ex * push;
                  wy += ey * push;
                  wz += ez * push;
                  if (++found >= MAX_NEIGHBOURS) break;
                }
              }
              j = next[j];
            }
          }
        }
      }

      // ---- flee threats ----
      let fear = this.fear[i];
      for (let k = 0; k < TC; k++) {
        const t = T[k];
        dx = px[i] - t.x;
        dy = py[i] - t.y;
        dz = pz[i] - t.z;
        const R = t.radius;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) + 1e-4;
        const k1 = 1 - d / R;
        let ax = dx / d;
        let ay = dy / d;
        let az = dz / d;
        // dart sideways from a charging predator
        const tv2 = t.vx * t.vx + t.vy * t.vy + t.vz * t.vz;
        if (tv2 > 1) {
          const tv = Math.sqrt(tv2);
          const hx = t.vx / tv;
          const hy = t.vy / tv;
          const hz = t.vz / tv;
          const dp = ax * hx + ay * hy + az * hz;
          ax += (ax - hx * dp) * 0.9;
          ay += (ay - hy * dp) * 0.9;
          az += (az - hz * dp) * 0.9;
          const l = Math.sqrt(ax * ax + ay * ay + az * az) + 1e-6;
          ax /= l;
          ay /= l;
          az /= l;
        }
        const f = k1 * (0.4 + k1) * sp.burst * Math.min(1.6, t.strength);
        wx += ax * f;
        wy += ay * f * 0.7;
        wz += az * f;
        fear = Math.max(fear, Math.min(1, k1 * 1.4 * t.strength));
      }

      // ---- vertical limits ----
      if (py[i] < nearFloorY) {
        const floor = this._seabed(px[i], pz[i]) + 1.0;
        if (py[i] < floor + 1.0) wy += (floor + 1.0 - py[i]) * 2.5;
      }
      if (py[i] > surfaceLimit) wy -= (py[i] - surfaceLimit) * 2.5;

      // ---- steer ----
      const maxSp = sp.cruise * 1.8 + fear * sp.burst;
      let ws = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (ws > maxSp) {
        const k2 = maxSp / ws;
        wx *= k2;
        wy *= k2;
        wz *= k2;
      }
      const steer = 1 - Math.exp(-dt * (2.2 + 8 * fear));
      let ux = vx[i] + (wx - vx[i]) * steer;
      let uy = vy[i] + (wy - vy[i]) * steer;
      let uz = vz[i] + (wz - vz[i]) * steer;
      let speed = Math.sqrt(ux * ux + uy * uy + uz * uz);
      const minSp = sp.cruise * 0.35;
      if (speed < minSp) {
        const k3 = minSp / (speed + 1e-6);
        if (speed < 1e-4) {
          ux = Math.sin(sc.heading);
          uz = Math.cos(sc.heading);
          uy = 0;
        }
        ux *= k3;
        uy *= k3;
        uz *= k3;
        speed = minSp;
      } else if (speed > maxSp) {
        const k3 = maxSp / speed;
        ux *= k3;
        uy *= k3;
        uz *= k3;
        speed = maxSp;
      }
      vx[i] = ux;
      vy[i] = uy;
      vz[i] = uz;
      px[i] += ux * dt;
      py[i] += uy * dt;
      pz[i] += uz * dt;
      this.fear[i] = Math.max(0, fear - dt * 0.55);

      // school extent for next frame's culling sphere
      const ex = px[i] - c.x;
      const ey = py[i] - c.y;
      const ez = pz[i] - c.z;
      const e2 = ex * ex + ey * ey + ez * ez;
      if (e2 > ext2[si]) ext2[si] = e2;

      // ---- tail beat ----
      const len = this.scale[i];
      const hz = Math.min(11, 1.2 + (0.55 * speed) / len);
      let ph = this.phase[i] + dt * hz * Math.PI * 2 * this.rate[i];
      if (ph > 6283.18) ph -= 6283.18;
      this.phase[i] = ph;
      swim[i * 2] = ph;
      swim[i * 2 + 1] = clamp(speed / (sp.cruise * 2.2), 0.2, 1);

      // ---- instance matrix (basis from velocity; pitch clamped) ----
      let fx = ux / speed;
      let fy = uy / speed;
      let fz = uz / speed;
      if (fy > 0.65 || fy < -0.65) {
        fy = clamp(fy, -0.65, 0.65);
        const hl = Math.sqrt(fx * fx + fz * fz) + 1e-6;
        const hk = Math.sqrt(1 - fy * fy) / hl;
        fx *= hk;
        fz *= hk;
      }
      // right = up × f ; up' = f × right
      let rx = fz;
      let rz = -fx;
      const rl = Math.sqrt(rx * rx + rz * rz) + 1e-6;
      rx /= rl;
      rz /= rl;
      const upx = fy * rz;
      const upy = fz * rx - fx * rz;
      const upz = -fy * rx;
      const o = i * 16;
      arr[o] = rx * len;
      arr[o + 1] = 0;
      arr[o + 2] = rz * len;
      arr[o + 3] = 0;
      arr[o + 4] = upx * len;
      arr[o + 5] = upy * len;
      arr[o + 6] = upz * len;
      arr[o + 7] = 0;
      arr[o + 8] = fx * len;
      arr[o + 9] = fy * len;
      arr[o + 10] = fz * len;
      arr[o + 11] = 0;
      arr[o + 12] = px[i];
      arr[o + 13] = py[i];
      arr[o + 14] = pz[i];
      arr[o + 15] = 1;
    }
    for (let s = 0; s < this.schools.length; s++) {
      const sc = this.schools[s];
      sc.extent = Math.sqrt(ext2[s]) + sc.sp.length;
    }
    this._dirty = true; // packed for the render camera in prepareRender()
  }

  // Reflections fade with depth (the env map holds *surface* radiance) and the
  // far-fish silhouette colour follows the water.
  _updateLook(cam) {
    const depth = Math.max(0, WORLD.surfaceY - (cam ? cam.position.y : WORLD.playerSpawn[1]));
    this.material.envMapIntensity = ENV_INTENSITY * Math.exp(-depth / ENV_DEPTH_SCALE);
    const wc = this.game.env?.waterColor;
    if (wc?.isColor) this.uniforms.uFishWater.value.copy(wc);
  }

  // Re-pack the per-fish colours in visible-school order (only when the
  // visible set changes).
  _packColors() {
    const dst = this.mesh.instanceColor.array;
    const src = this.baseColor;
    let w = 0;
    for (let s = 0; s < this.schools.length; s++) {
      const sc = this.schools[s];
      if (!sc.visible) continue;
      const a = sc.start * 3;
      const n = sc.count * 3;
      for (let k = 0; k < n; k++) dst[w + k] = src[a + k];
      w += n;
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  /** Centre of school `i` (for tests / camera framing). */
  getSchoolCenter(i = 0) {
    return this.schools[i]?.center ?? null;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
