// Displaced particulate: silt, sand grains and torn-off flesh specks kicked up
// by impacts, shockwaves and bodies hitting the seabed. Small soft lit specks
// with strong water drag and slow settling.
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
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.6) * (1.0 - r2) * vColor.a;
  // tiny sun glint on the upper side
  float glint = 1.0 + 0.6 * smoothstep(0.0, 1.0, dot(p, vSunUv));
  vec3 col = vColor.rgb * mix(highlightLight(vWorldY), waterLight(vWorldY, 1.0), 0.5) * glint;
  float fogF = vfxFogFactor();
  a *= 1.0 - fogF;
  gl_FragColor = vec4(col * a, a * vParams.y);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class DustSystem {
  constructor({ capacity, shared }) {
    this.capacity = capacity;
    const n = capacity;
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.r = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.sink = new Float32Array(n);
    this.opacity = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.next = 0;
    this.live = 0;

    this.batch = new BillboardBatch({
      capacity,
      name: 'vfx-dust',
      fragmentShader: FRAG,
      shared,
      blend: PREMULTIPLIED_BLEND,
      renderOrder: 11,
    });
    this.mesh = this.batch.mesh;
  }

  get count() {
    return this.live;
  }

  /**
   * opacity: 0 = purely additive glint, 1 = solid (occluding) speck.
   */
  spawn(x, y, z, vx, vy, vz, radius, life, alpha, cr, cg, cb, drag = 3, sink = 0.05, opacity = 0.6) {
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
    this.col[i3] = cr;
    this.col[i3 + 1] = cg;
    this.col[i3 + 2] = cb;
    this.age[i] = 0;
    this.life[i] = life;
    this.r[i] = radius;
    this.a0[i] = alpha;
    this.drag[i] = drag;
    this.sink[i] = sink;
    this.opacity[i] = opacity;
    return i;
  }

  update(dt) {
    const { p, v, age, life, alive } = this;
    const ps = this.batch.posSize;
    const cs = this.batch.color;
    const pr = this.batch.params;
    let w = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (!alive[i]) continue;
      const a = age[i] + dt;
      if (a >= life[i]) {
        alive[i] = 0;
        continue;
      }
      age[i] = a;
      const i3 = i * 3;
      const damp = Math.exp(-this.drag[i] * dt);
      v[i3] *= damp;
      v[i3 + 1] = v[i3 + 1] * damp - this.sink[i] * dt;
      v[i3 + 2] *= damp;
      p[i3] += v[i3] * dt;
      p[i3 + 1] += v[i3 + 1] * dt;
      p[i3 + 2] += v[i3 + 2] * dt;
      const L = life[i];
      const fade = Math.min(1, a * 10) * (1 - smooth01((a - L * 0.4) / (L * 0.6)));
      const o = w * 4;
      ps[o] = p[i3];
      ps[o + 1] = p[i3 + 1];
      ps[o + 2] = p[i3 + 2];
      ps[o + 3] = this.r[i];
      cs[o] = this.col[i3];
      cs[o + 1] = this.col[i3 + 1];
      cs[o + 2] = this.col[i3 + 2];
      cs[o + 3] = this.a0[i] * fade;
      pr[o] = 0;
      pr[o + 1] = this.opacity[i];
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

function smooth01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
