// Knife swing ribbon. Reads player.getActiveAttack() every frame and draws a
// faint water-disturbance sheet swept by the BLADE, Catmull-Rom subdivided
// so low frame rates still give a smooth arc. Two ribbons alternate so a new
// swing never bridges onto the previous one. Fast tips shed cavitation
// micro-bubbles.
//
// attack.tip is the hit-test tip, extended past the blade by the attack's
// reach (attack.reach, optional; falls back to the Player's REACH table), so
// the ribbon pulls it back to the real ~0.25 m blade and never spans more
// than RIBBON_MAX metres. Only light slashes draw a ribbon: a heavy thrust
// moves along its own axis (a ribbon degenerates into a long wedge), so it is
// sold by cavitation bubbles plus a small pressure pop at release (onThrust).
import * as THREE from 'three';
import { WATER_LIGHT_PARS, FOG_FACTOR } from './shaderChunks.js';

const MAX_SAMPLES = 40;
const RIBBON_MAX = 0.3; // metres from the tip toward the hilt
// Fallback when attack.reach is absent — keep in sync with REACH in Player.js.
const REACH_FALLBACK = { light: 0.5, heavy: 0.9, grabStab: 0.35 };
// Per attack type: ribbon look (strength 0 = no ribbon) and cavitation rate.
const STYLE = {
  light: { strength: 0.3, edge: 0.25, gain: 0.27, fade: 0.11, cav: 28 },
  heavy: { strength: 0, edge: 0, gain: 0, fade: 0.2, cav: 60 },
  grabStab: { strength: 0, edge: 0, gain: 0, fade: 0.12, cav: 20 },
};
const MAX_ALPHA = 0.25;

const VERT = /* glsl */ `
attribute vec3 aData; // x = age 0..1, y = v (0 base .. 1 tip), z = along-trail coord
varying vec3 vData;
varying float vWorldY;
#include <fog_pars_vertex>
void main() {
  vData = aData;
  vWorldY = position.y;
  vec4 mvPosition = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform float uStrength;
uniform float uEdge;
uniform float uGain;
uniform sampler2D uNoise;
varying vec3 vData;
varying float vWorldY;
#include <fog_pars_fragment>
${WATER_LIGHT_PARS}
${FOG_FACTOR}
void main() {
  float age = clamp(vData.x, 0.0, 1.0);
  float v = vData.y;
  float fade = pow(1.0 - age, 1.7);
  float prof = smoothstep(0.05, 0.75, v) * (0.25 + 0.75 * v);
  float edge = smoothstep(0.82, 0.975, v) * (1.0 - smoothstep(0.975, 1.0, v));
  float nz = textureLod(uNoise, vec2(vData.z * 0.35, v * 0.5 + vData.z * 0.05), 0.0).r;
  float a = (prof * 0.42 * (0.4 + 1.2 * nz) + edge * uEdge) * fade * uStrength;
  // feather the leading edge right at the blade
  a *= smoothstep(0.0, 0.05, age + 0.02);
  a = min(a, ${MAX_ALPHA.toFixed(3)});
  vec3 col = highlightLight(vWorldY) * uGain;
  a *= 1.0 - vfxFogFactor();
  gl_FragColor = vec4(col * a, a * 0.22);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _b0 = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _b3 = new THREE.Vector3();
const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _ob = new THREE.Vector3();
const _ot = new THREE.Vector3();
const _tipVel = new THREE.Vector3();
const _base = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _axis = new THREE.Vector3();

function catmull(out, p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  out.x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  out.y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  out.z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
  return out;
}

class Ribbon {
  constructor(subdiv, material) {
    this.subdiv = subdiv;
    this.samples = new Float32Array(MAX_SAMPLES * 7); // base xyz, tip xyz, time
    this.n = 0;
    this.id = -1;
    this.style = STYLE.light;
    this.fade = 0.15;
    const maxCross = (MAX_SAMPLES - 1) * subdiv + 1;
    this.positions = new Float32Array(maxCross * 2 * 3);
    this.data = new Float32Array(maxCross * 2 * 3);
    const indices = new Uint16Array((maxCross - 1) * 6);
    for (let i = 0; i < maxCross - 1; i++) {
      const a = i * 2;
      indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    // ring of GPU buffers sharing the CPU arrays (see BillboardBatch: avoid
    // overwriting a buffer the previous frame's draw may still be reading)
    const index = new THREE.BufferAttribute(indices, 1);
    this._sets = [];
    for (let b = 0; b < 3; b++) {
      const geo = new THREE.BufferGeometry();
      const aPos = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
      const aData = new THREE.BufferAttribute(this.data, 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', aPos);
      geo.setAttribute('aData', aData);
      geo.setIndex(index);
      geo.setDrawRange(0, 0);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      this._sets.push({ geo, aPos, aData });
    }
    this._cur = 0;
    this.material = material;
    this.mesh = new THREE.Mesh(this._sets[0].geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  reset(id, type) {
    this.n = 0;
    this.id = id;
    const st = STYLE[type] ?? STYLE.light;
    this.style = st;
    this.fade = st.fade;
    const u = this.material.uniforms;
    u.uStrength.value = st.strength;
    u.uEdge.value = st.edge;
    u.uGain.value = st.gain;
  }

  get draws() {
    return this.style.strength > 0;
  }

  push(base, tip, time) {
    const s = this.samples;
    if (this.n > 0) {
      const o = (this.n - 1) * 7;
      const dx = tip.x - s[o + 3];
      const dy = tip.y - s[o + 4];
      const dz = tip.z - s[o + 5];
      if (dx * dx + dy * dy + dz * dz < 1e-4) {
        // barely moved (e.g. hitstop) — refresh the head sample only
        s[o] = base.x; s[o + 1] = base.y; s[o + 2] = base.z;
        s[o + 3] = tip.x; s[o + 4] = tip.y; s[o + 5] = tip.z;
        return;
      }
    }
    if (this.n === MAX_SAMPLES) {
      s.copyWithin(0, 7);
      this.n--;
    }
    const o = this.n * 7;
    s[o] = base.x; s[o + 1] = base.y; s[o + 2] = base.z;
    s[o + 3] = tip.x; s[o + 4] = tip.y; s[o + 5] = tip.z;
    s[o + 6] = time;
    this.n++;
  }

  build(time) {
    const s = this.samples;
    // drop samples that have fully faded (oldest first)
    let drop = 0;
    while (drop < this.n && time - s[drop * 7 + 6] > this.fade) drop++;
    if (drop > 0) {
      s.copyWithin(0, drop * 7, this.n * 7);
      this.n -= drop;
    }
    if (this.n < 2) {
      this.mesh.visible = false;
      return;
    }
    const P = this.positions;
    const D = this.data;
    const sub = this.subdiv;
    let c = 0;
    const n = this.n;
    for (let k = 0; k < n - 1; k++) {
      const k0 = Math.max(0, k - 1) * 7;
      const k1 = k * 7;
      const k2 = (k + 1) * 7;
      const k3 = Math.min(n - 1, k + 2) * 7;
      _b0.set(s[k0], s[k0 + 1], s[k0 + 2]);
      _b1.set(s[k1], s[k1 + 1], s[k1 + 2]);
      _b2.set(s[k2], s[k2 + 1], s[k2 + 2]);
      _b3.set(s[k3], s[k3 + 1], s[k3 + 2]);
      _t0.set(s[k0 + 3], s[k0 + 4], s[k0 + 5]);
      _t1.set(s[k1 + 3], s[k1 + 4], s[k1 + 5]);
      _t2.set(s[k2 + 3], s[k2 + 4], s[k2 + 5]);
      _t3.set(s[k3 + 3], s[k3 + 4], s[k3 + 5]);
      const time1 = s[k1 + 6];
      const time2 = s[k2 + 6];
      const last = k === n - 2;
      const steps = last ? sub + 1 : sub;
      for (let j = 0; j < steps; j++) {
        const t = j / sub;
        catmull(_ob, _b0, _b1, _b2, _b3, t);
        catmull(_ot, _t0, _t1, _t2, _t3, t);
        const st = time1 + (time2 - time1) * t;
        const age = (time - st) / this.fade;
        const along = st * 9.0;
        const o = c * 6;
        P[o] = _ob.x; P[o + 1] = _ob.y; P[o + 2] = _ob.z;
        P[o + 3] = _ot.x; P[o + 4] = _ot.y; P[o + 5] = _ot.z;
        D[o] = age; D[o + 1] = 0; D[o + 2] = along;
        D[o + 3] = age; D[o + 4] = 1; D[o + 5] = along;
        c++;
      }
    }
    this._cur = (this._cur + 1) % this._sets.length;
    const set = this._sets[this._cur];
    set.aPos.clearUpdateRanges();
    set.aPos.addUpdateRange(0, c * 6);
    set.aPos.needsUpdate = true;
    set.aData.clearUpdateRanges();
    set.aData.addUpdateRange(0, c * 6);
    set.aData.needsUpdate = true;
    set.geo.setDrawRange(0, (c - 1) * 6);
    this.mesh.geometry = set.geo;
    this.mesh.visible = true;
  }
}

export class KnifeTrail {
  /**
   * @param {object} o
   * @param {(x, y, z, vel) => void} o.onCavitate  micro-bubble at a fast blade tip
   * @param {(tip, axis, type) => void} o.onThrust  heavy thrust released (tip, unit blade axis)
   */
  constructor({ scene, shared, noise, quality, onCavitate, onThrust }) {
    const subdiv = quality === 'low' ? 1 : quality === 'medium' ? 2 : 4;
    const makeMat = () => new THREE.ShaderMaterial({
      name: 'vfx-knife-trail',
      uniforms: {
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        uStrength: { value: 0.3 },
        uEdge: { value: 0.25 },
        uGain: { value: 0.7 },
        uNoise: { value: noise },
        ...shared,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.ribbons = [new Ribbon(subdiv, makeMat()), new Ribbon(subdiv, makeMat())];
    for (const r of this.ribbons) scene.add(r.mesh);
    this.current = 0;
    this.time = 0;
    this.onCavitate = onCavitate;
    this.onThrust = onThrust;
    this._prevTip = new THREE.Vector3();
    this._hasPrev = false;
    this._lastId = -1;
    this._cavAccum = 0;
  }

  /** Real blade (hilt → tip) of an attack into _base / _tip; false if degenerate. */
  _blade(attack) {
    _axis.subVectors(attack.tip, attack.base);
    const len = _axis.length();
    if (len < 0.05) return false;
    _axis.multiplyScalar(1 / len);
    const reach = attack.reach ?? REACH_FALLBACK[attack.type] ?? 0.5;
    // never pull the tip back past the hilt (stub knives without a reach)
    const blade = Math.max(Math.min(len, 0.12), len - reach);
    _tip.copy(attack.base).addScaledVector(_axis, blade);
    _base.copy(_tip).addScaledVector(_axis, -Math.min(blade, RIBBON_MAX));
    return true;
  }

  update(dt, attack) {
    this.time += dt;
    if (attack && attack.base && attack.tip && this._blade(attack)) {
      let r = this.ribbons[this.current];
      const fresh = attack.id !== this._lastId;
      if (fresh) {
        this.current = 1 - this.current;
        r = this.ribbons[this.current];
        r.reset(attack.id, attack.type);
        this._lastId = attack.id;
        this._hasPrev = false;
        if (attack.type === 'heavy') this.onThrust?.(_tip, _axis, attack.type);
      }
      if (r.draws) r.push(_base, _tip, this.time);

      // cavitation micro-bubbles behind a fast moving tip
      if (this._hasPrev && dt > 1e-5) {
        _tipVel.subVectors(_tip, this._prevTip).divideScalar(dt);
        const speed = _tipVel.length();
        if (speed > 4) {
          const rate = r.style.cav * Math.min(1, (speed - 4) / 8);
          this._cavAccum += rate * dt;
          while (this._cavAccum >= 1) {
            this._cavAccum -= 1;
            const t = Math.random();
            this.onCavitate?.(
              this._prevTip.x + (_tip.x - this._prevTip.x) * t,
              this._prevTip.y + (_tip.y - this._prevTip.y) * t,
              this._prevTip.z + (_tip.z - this._prevTip.z) * t,
              _tipVel,
            );
          }
        }
      }
      this._prevTip.copy(_tip);
      this._hasPrev = true;
    } else {
      this._hasPrev = false;
    }
    this.ribbons[0].build(this.time);
    this.ribbons[1].build(this.time);
  }
}
