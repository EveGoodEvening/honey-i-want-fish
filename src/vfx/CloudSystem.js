// Billowing volumetric-looking clouds: blood and sediment.
//
// CPU-simulated, depth-sorted (back to front) alpha-blended sprites drawn from
// a procedural 2x2 puff atlas. Each puff expands with an ease-out curve,
// rotates slowly, drifts with a cheap turbulence field and is stirred by fast
// moving bodies (player / sharks) passing through it. Lighting is the shared
// depth-absorption model, with fake self-shadowing from a second texture
// sample offset toward the sun — so clouds read as dense, lit-from-above
// volumes rather than flat cards.
import { BillboardBatch, ALPHA_BLEND } from './BillboardBatch.js';
import { WATER_LIGHT_PARS, FOG_FACTOR } from './shaderChunks.js';

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uSelfShadow;
uniform float uTileHalf;   // texels per puff radius (tile size / 2)

varying vec2 vUv;
varying vec4 vColor;
varying vec4 vParams;
varying float vWorldY;
varying vec2 vSunUv;
varying float vPx;

#include <fog_pars_fragment>
${WATER_LIGHT_PARS}
${FOG_FACTOR}

void main() {
  float tile = vParams.y;
  vec2 tileOff = vec2(mod(tile, 2.0), floor(tile * 0.5)) * 0.5;
  // Explicit LOD from the sprite's projected size: derivative-based mip
  // selection breaks on the thin triangles produced when big quads are
  // clipped (visible as straight-edged blurry wedges on some GPUs).
  // A puff spans 2 * uTileHalf texels across 2 * vPx pixels.
  float lod = max(0.0, log2(uTileHalf / max(vPx, 1e-3)));
  vec4 s = textureLod(uMap, tileOff + vUv * 0.5, lod);
  float d = s.r;
  // analytic round window: lower mip levels bleed across atlas tiles, which
  // would otherwise make small / distant puffs look square
  float win = 1.0 - smoothstep(0.72, 1.0, length(vUv * 2.0 - 1.0));
  float a = d * vColor.a * win;
  if (a < 0.004) discard;

  // self shadowing: density between this texel and the sun
  float occ = 0.0;
  if (uSelfShadow > 0.5) {
    vec2 uv2 = clamp(vUv + vSunUv * 0.12, 0.0, 1.0);
    occ = textureLod(uMap, tileOff + uv2 * 0.5, lod + 0.5).r;
  } else {
    occ = d * 0.7;
  }
  // brighter toward the lit rim, darker in the core. Blood is a thin medium
  // that forward-scatters: its core keeps some sunlight (dark green-black
  // rather than neutral black); silt is opaque grains and can go dark.
  float lit = clamp(1.1 - occ * 1.05 + (d - occ) * 0.8, vParams.z > 0.5 ? 0.06 : 0.16, 1.0);
  float sunTerm = 0.08 + 1.25 * lit * (0.55 + 0.45 * clamp(vSunUv.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 light = waterLight(vWorldY, sunTerm);
  vec3 col = vColor.rgb * light * (0.7 + 0.6 * s.g);
  if (vParams.z > 0.5) {
    // sediment: silt lit mostly by in-scattered water light, so it takes the
    // water's teal rather than going grey (grey would bring back the red the
    // depth absorbed) — and never much brighter than the bed it came from
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, lum * normalize(uAmbient + 1e-4) * 1.7, 0.45) * 0.8;
  } else {
    // blood: a little greyer still (a dark green-black shadow in the water,
    // not a tinted stain), and thinner at its edges than in its core
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(lum), 0.25);
    a *= 0.6 + 0.4 * smoothstep(0.15, 0.6, d);
  }
  // detail erodes the thin parts so edges read as curling billows, not blur
  a *= smoothstep(0.0, 0.55, d + (s.g - 0.5) * 0.35);

  float fogF = vfxFogFactor();
  col = mix(col, vfxFogColor(), fogF);
  // the flat fog colour is not the view-dependent water behind the puff, so
  // distant puffs also thin out instead of standing out as flat discs
  a *= 1.0 - fogF * fogF;

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const CLOUD_KIND = { blood: 0, sediment: 1 };

export class CloudSystem {
  constructor({ capacity, atlas, shared, selfShadow = true }) {
    this.capacity = capacity;
    const n = capacity;
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.fadeAt = new Float32Array(n); // age (s) the dissipation starts at
    this.r0 = new Float32Array(n);
    this.r1 = new Float32Array(n);
    this.growK = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.rotSpd = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.tile = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.fadeIn = new Float32Array(n);
    this.buoy = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.alive = new Uint8Array(n);
    this.order = new Int32Array(n);
    this.key = new Float32Array(n);
    this.orderCount = 0;
    this.next = 0;
    this.time = 0;
    this.overwrites = 0; // live puffs recycled early (diagnostics)

    this.batch = new BillboardBatch({
      capacity,
      name: 'vfx-clouds',
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: atlas },
        uSelfShadow: { value: selfShadow ? 1 : 0 },
        uTileHalf: { value: (atlas.image?.width ?? 512) / 4 },
      },
      shared,
      blend: ALPHA_BLEND,
      renderOrder: 10,
      depthBias: 0.75,
    });
    this.mesh = this.batch.mesh;
  }

  get count() {
    return this.orderCount;
  }

  /**
   * Spawn one puff.
   * r0 → r1 radius growth with rate growK (1/s), life in seconds. It
   * dissipates from age `fadeAt` (s; default: over the last 55 % of its life).
   */
  spawn(x, y, z, vx, vy, vz, r0, r1, growK, life, alpha, cr, cg, cb, kind = 0, drag = 1.6, buoy = 0, fadeAt = -1) {
    // Ring buffer, but never overwrite a live puff (it would vanish abruptly)
    // while a dead slot exists: old puffs die first, so the scan is short.
    let i = this.next;
    const cap = this.capacity;
    if (this.alive[i] && this.orderCount < cap) {
      for (let k = 1; k < cap && this.alive[i]; k++) i = (i + 1) % cap;
    }
    if (this.alive[i]) {
      i = this.next; // pool full: recycle the slot the ring points at
      this.overwrites++;
    }
    this.next = (i + 1) % cap;
    if (!this.alive[i]) {
      this.order[this.orderCount++] = i;
      this.alive[i] = 1;
    }
    const i3 = i * 3;
    this.p[i3] = x;
    this.p[i3 + 1] = y;
    this.p[i3 + 2] = z;
    this.v[i3] = vx;
    this.v[i3 + 1] = vy;
    this.v[i3 + 2] = vz;
    this.col[i3] = cr;
    this.col[i3 + 1] = cg;
    this.col[i3 + 2] = cb;
    this.age[i] = 0;
    this.life[i] = life;
    this.fadeAt[i] = fadeAt >= 0 && fadeAt < life * 0.9 ? fadeAt : life * 0.45;
    this.r0[i] = r0;
    this.r1[i] = r1;
    this.growK[i] = growK;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.rotSpd[i] = (Math.random() - 0.5) * 0.5;
    this.a0[i] = alpha;
    this.tile[i] = Math.floor(Math.random() * 4);
    this.drag[i] = drag;
    this.fadeIn[i] = 0.06 + Math.random() * 0.12;
    this.buoy[i] = buoy;
    this.seed[i] = Math.random() * 100;
    this.kind[i] = kind;
    return i;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} camPos
   * @param {THREE.Vector3} camDir  unit view direction
   * @param {Float32Array} stir     packed [x,y,z,vx,vy,vz,radius,_] per body
   * @param {number} stirCount
   * @param {Float32Array} solids   packed [x,y,z,radius] spheres clouds are pushed out of
   * @param {number} solidCount
   */
  update(dt, camPos, camDir, stir, stirCount, solids = null, solidCount = 0) {
    this.time += dt;
    const t = this.time;
    const { p, v, age, life, order, key, alive } = this;
    let w = 0;
    for (let k = 0; k < this.orderCount; k++) {
      const i = order[k];
      if (!alive[i]) continue;
      const a = age[i] + dt;
      if (a >= life[i]) {
        alive[i] = 0;
        continue;
      }
      age[i] = a;
      const i3 = i * 3;
      let vx = v[i3];
      let vy = v[i3 + 1];
      let vz = v[i3 + 2];
      const damp = Math.exp(-this.drag[i] * dt);
      vx *= damp;
      vy *= damp;
      vz *= damp;
      // slow turbulent drift (cheap analytic field, varies in space & time)
      const px = p[i3];
      const py = p[i3 + 1];
      const pz = p[i3 + 2];
      const sd = this.seed[i];
      vx += Math.sin(py * 0.63 + t * 0.31 + sd) * 0.07 * dt;
      vy += (Math.sin(pz * 0.51 + t * 0.23 + sd * 1.3) * 0.035 + this.buoy[i]) * dt;
      vz += Math.cos(px * 0.57 - t * 0.27 + sd * 0.7) * 0.07 * dt;
      // stirring by bodies moving through the cloud
      for (let s = 0; s < stirCount; s++) {
        const o = s * 8;
        const dx = px - stir[o];
        const dy = py - stir[o + 1];
        const dz = pz - stir[o + 2];
        const rr = stir[o + 6];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < rr * rr) {
          const f = (1 - Math.sqrt(d2) / rr) * 2.2 * dt;
          vx += stir[o + 3] * f;
          vy += stir[o + 4] * f;
          vz += stir[o + 5] * f;
          // and a little outward push so the body carves a hole through it
          const inv = 1 / (Math.sqrt(d2) + 0.2);
          vx += dx * inv * f * 0.8;
          vy += dy * inv * f * 0.8;
          vz += dz * inv * f * 0.8;
        }
      }
      // keep puff centres out of solid bodies (they would slice through them)
      let qx = px + vx * dt;
      let qy = py + vy * dt;
      let qz = pz + vz * dt;
      for (let s = 0; s < solidCount; s++) {
        const o = s * 4;
        const dx = qx - solids[o];
        const dy = qy - solids[o + 1];
        const dz = qz - solids[o + 2];
        const rr = solids[o + 3] + 0.15;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < rr * rr && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = Math.min(rr - d, 3 * dt + (rr - d) * 0.2) / d;
          qx += dx * push;
          qy += dy * push;
          qz += dz * push;
          vx += dx * push * 2;
          vy += dy * push * 2;
          vz += dz * push * 2;
        }
      }
      v[i3] = vx;
      v[i3 + 1] = vy;
      v[i3 + 2] = vz;
      p[i3] = qx;
      p[i3 + 1] = qy;
      p[i3 + 2] = qz;
      key[i] = (p[i3] - camPos.x) * camDir.x + (p[i3 + 1] - camPos.y) * camDir.y + (p[i3 + 2] - camPos.z) * camDir.z;
      order[w++] = i;
    }
    this.orderCount = w;

    // Insertion sort, far → near. The order persists between frames so it is
    // almost sorted already and this is ~O(n).
    for (let k = 1; k < w; k++) {
      const i = order[k];
      const kk = key[i];
      let j = k - 1;
      while (j >= 0 && key[order[j]] < kk) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = i;
    }

    const ps = this.batch.posSize;
    const cs = this.batch.color;
    const pr = this.batch.params;
    for (let k = 0; k < w; k++) {
      const i = order[k];
      const i3 = i * 3;
      const o = k * 4;
      const a = age[i];
      const L = life[i];
      const grow = 1 - Math.exp(-a * this.growK[i]);
      const r = this.r0[i] + (this.r1[i] - this.r0[i]) * grow;
      // fade in quickly, hold, then dissipate (from fadeAt: by default over
      // the last ~55 % of life)
      const fi = Math.min(1, a / this.fadeIn[i]);
      const fa = this.fadeAt[i];
      const fo = 1 - smooth01((a - fa) / (L - fa));
      // mass conservation: an expanding puff gets thinner
      const dens = Math.min(1, Math.max(0.28, Math.sqrt((this.r0[i] * 1.7) / r)));
      ps[o] = this.p[i3];
      ps[o + 1] = this.p[i3 + 1];
      ps[o + 2] = this.p[i3 + 2];
      ps[o + 3] = r;
      cs[o] = this.col[i3];
      cs[o + 1] = this.col[i3 + 1];
      cs[o + 2] = this.col[i3 + 2];
      cs[o + 3] = this.a0[i] * fi * fo * dens;
      pr[o] = this.rot[i] + this.rotSpd[i] * a;
      pr[o + 1] = this.tile[i];
      pr[o + 2] = this.kind[i];
      pr[o + 3] = 0;
    }
    this.batch.commit(w);
  }

  clear() {
    this.alive.fill(0);
    this.orderCount = 0;
    this.batch.commit(0);
  }
}

function smooth01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
