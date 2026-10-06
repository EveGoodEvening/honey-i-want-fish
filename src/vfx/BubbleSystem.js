// Rising, wobbling air bubbles.
//
// Shading is analytic (no texture): a thin bright rim (total internal
// reflection), a specular glint toward the light, a faint caustic glow on the
// lower inside and an almost clear centre. Tiny bubbles (a few px on screen)
// collapse into soft glints so they never alias into squares. Large bubbles
// flatten into wobbling caps and zig-zag as they rise. Bubbles pop when their
// life ends or when they reach the surface.
import { BillboardBatch, PREMULTIPLIED_BLEND } from './BillboardBatch.js';
import { WATER_LIGHT_PARS, FOG_FACTOR } from './shaderChunks.js';

const FRAG = /* glsl */ `
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
  vec2 p = vUv * 2.0 - 1.0;
  p.y *= vParams.y;              // squash (>1 flattens into a cap)
  p.y -= (vParams.y - 1.0) * 0.35;
  float r = length(p);
  if (r > 1.0) discard;

  float detail = smoothstep(2.5, 7.0, vPx);
  float rim = smoothstep(0.62, 0.94, r) * (1.0 - smoothstep(0.94, 1.0, r));
  vec2 hp = p - vec2(-0.34, 0.40);
  float spec = exp(-dot(hp, hp) * 38.0);
  vec2 hp2 = p - vec2(0.28, -0.42);
  float spec2 = exp(-dot(hp2, hp2) * 60.0) * 0.35;
  float lower = smoothstep(0.3, 0.95, r) * smoothstep(0.1, -0.9, p.y) * 0.35;
  float body = rim * 0.85 + spec * 1.3 + spec2 + lower + 0.05;
  float glint = exp(-r * r * 3.2) * 0.9;
  float m = mix(glint, body, detail);

  float a = m * vColor.a;
  vec3 col = highlightLight(vWorldY) * 1.7;

  float fogF = vfxFogFactor();
  a *= 1.0 - fogF;
  // premultiplied, mostly additive (alpha scaled down)
  gl_FragColor = vec4(col * a, a * 0.45);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class BubbleSystem {
  constructor({ capacity, shared, surfaceY = 0 }) {
    this.capacity = capacity;
    const n = capacity;
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.r = new Float32Array(n);
    this.rise = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.freq = new Float32Array(n);
    this.wob = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.next = 0;
    this.live = 0;
    this.surfaceY = surfaceY;

    this.batch = new BillboardBatch({
      capacity,
      name: 'vfx-bubbles',
      fragmentShader: FRAG,
      shared,
      blend: PREMULTIPLIED_BLEND,
      renderOrder: 13,
    });
    this.mesh = this.batch.mesh;
  }

  get count() {
    return this.live;
  }

  /** radius in metres (≈0.002..0.05) */
  spawn(x, y, z, vx, vy, vz, radius, life = 4, alpha = 1) {
    if (y > this.surfaceY - 0.3) return -1;
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.alive[i] = 1;
    const i3 = i * 3;
    this.p[i3] = x;
    this.p[i3 + 1] = y;
    this.p[i3 + 2] = z;
    this.v[i3] = vx;
    this.v[i3 + 1] = vy;
    this.v[i3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.r[i] = radius;
    // terminal rise speed grows with size (games exaggerate it a little)
    this.rise[i] = Math.min(1.5, 0.38 + radius * 26) * (0.85 + Math.random() * 0.3);
    this.phase[i] = Math.random() * 6.283;
    this.freq[i] = 5 + Math.random() * 5 - Math.min(3, radius * 60);
    this.wob[i] = Math.min(0.09, 0.004 + radius * 2.2);
    this.a0[i] = alpha;
    return i;
  }

  update(dt) {
    const { p, v, age, life, alive } = this;
    const ps = this.batch.posSize;
    const cs = this.batch.color;
    const pr = this.batch.params;
    const top = this.surfaceY - 0.3;
    const lateral = Math.exp(-2.6 * dt);
    const kRise = 1 - Math.exp(-3.2 * dt);
    let w = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!alive[i]) continue;
      const a = age[i] + dt;
      const i3 = i * 3;
      if (a >= life[i] || p[i3 + 1] > top) {
        alive[i] = 0;
        continue;
      }
      age[i] = a;
      v[i3] *= lateral;
      v[i3 + 2] *= lateral;
      v[i3 + 1] += (this.rise[i] - v[i3 + 1]) * kRise;
      p[i3] += v[i3] * dt;
      p[i3 + 1] += v[i3 + 1] * dt;
      p[i3 + 2] += v[i3 + 2] * dt;

      const ph = this.phase[i] + a * this.freq[i];
      const wob = this.wob[i];
      const rad = this.r[i];
      // pop: swell and vanish over the final 0.1 s
      const rem = life[i] - a;
      const pop = rem < 0.1 ? rem / 0.1 : 1;
      const fin = Math.min(1, a * 12);
      const o = w * 4;
      ps[o] = p[i3] + Math.sin(ph) * wob;
      ps[o + 1] = p[i3 + 1];
      ps[o + 2] = p[i3 + 2] + Math.cos(ph * 0.83) * wob;
      ps[o + 3] = rad * (1 + (1 - pop) * 0.35);
      cs[o] = 1;
      cs[o + 1] = 1;
      cs[o + 2] = 1;
      cs[o + 3] = this.a0[i] * pop * fin;
      pr[o] = 0;
      // big bubbles flatten and wobble
      pr[o + 1] = 1 + Math.min(0.55, Math.max(0, rad - 0.012) * 18) * (0.75 + 0.25 * Math.sin(ph * 1.7));
      pr[o + 2] = 0;
      pr[o + 3] = 0;
      w++;
    }
    this.live = w;
    this.batch.commit(w);
  }

  clear() {
    this.alive.fill(0);
    this.live = 0;
    this.batch.commit(0);
  }
}
