// Pressure rings: a flat expanding ring of displaced water (a body landing on
// the seabed, a mid-sized shockwave). Without access to the scene colour
// buffer the "refraction" is faked with a faint, noisy band of scattered
// light, fogged like everything else.
//
// No fresnel shells any more: a pressure globe read as a glass ball around
// the shark (or around the lens) at every distance, and a ring seen edge-on
// collapses into a hard line across the frame — so the ring fades out as it
// turns edge-on and has a soft, wide rim. Big waves (tail slam, roar) read
// through bubbles, particulate and PostFX's screen-space distortion (VFX).
import * as THREE from 'three';
import { WATER_LIGHT_PARS, FOG_FACTOR } from './shaderChunks.js';

const RING_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vRingN;
#include <fog_pars_vertex>
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vRingN = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const RING_FRAG = /* glsl */ `
uniform float uAlpha;
uniform float uTime;
uniform float uWidth;
uniform sampler2D uNoise;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vRingN;
#include <fog_pars_fragment>
${WATER_LIGHT_PARS}
${FOG_FACTOR}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // edge-on, the disc collapses into a straight line across the frame: fade it
  float facing = abs(dot(normalize(vRingN), normalize(cameraPosition - vWorldPos)));
  float view = smoothstep(0.2, 0.5, facing);
  if (view <= 0.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float nz = textureLod(uNoise, vec2(ang * 1.2732, r * 0.6 - uTime * 0.4), 0.0).r;
  // soft rim: a wide gaussian band, broken up by the noise
  float band = exp(-pow((r - 0.9) / uWidth, 2.0));
  float wake = smoothstep(0.35, 0.9, r) * (1.0 - smoothstep(0.9, 1.0, r)) * 0.3;
  float a = (band * (0.15 + nz * 0.8) + wake * nz * 0.6) * uAlpha * view;
  vec3 col = highlightLight(vWorldPos.y) * 1.1;
  a *= 1.0 - vfxFogFactor();
  gl_FragColor = vec4(col * a, a * 0.25);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BLEND = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

const _q = new THREE.Quaternion();
const _z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();

export class PressureFX {
  constructor({ scene, shared, noise, rings = 4 }) {
    this.rings = [];
    this.group = new THREE.Group();
    this.group.name = 'vfx-pressure';
    scene.add(this.group);

    const ringGeo = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < rings; i++) {
      const mat = new THREE.ShaderMaterial({
        name: 'vfx-ring',
        uniforms: {
          ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
          uAlpha: { value: 0 },
          uTime: { value: 0 },
          uWidth: { value: 0.1 },
          uNoise: { value: noise },
          ...shared,
        },
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        side: THREE.DoubleSide,
        fog: true,
        ...BLEND,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 12;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, t: 0, dur: 1, radius: 1, strength: 1, active: false, seed: 0 });
    }
    this._nextRing = 0;
  }

  /**
   * Flat expanding ring lying in the plane perpendicular to `normal`; fades
   * out edge-on. `width` is the rim's gaussian half-width (fraction of radius).
   */
  ring(position, normal, radius, duration, strength = 1, width = 0.1) {
    const r = this.rings[this._nextRing];
    this._nextRing = (this._nextRing + 1) % this.rings.length;
    r.mesh.position.copy(position);
    _n.copy(normal);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    _q.setFromUnitVectors(_z, _n);
    r.mesh.quaternion.copy(_q);
    r.t = 0;
    r.dur = duration;
    r.radius = radius;
    r.strength = strength;
    r.active = true;
    r.seed = Math.random() * 10;
    r.mat.uniforms.uWidth.value = width;
    r.mesh.visible = true;
    this._apply(r, 0);
  }

  _apply(fx, k) {
    // ease-out expansion, alpha falls off as the wave weakens
    const e = 1 - Math.pow(1 - k, 3);
    const rad = Math.max(0.02, fx.radius * (0.08 + 0.92 * e));
    fx.mesh.scale.setScalar(rad);
    fx.mat.uniforms.uAlpha.value = fx.strength * Math.pow(1 - k, 1.6) * Math.min(1, k * 14 + 0.15);
    fx.mat.uniforms.uTime.value = fx.seed + k * fx.dur;
  }

  update(dt) {
    for (let i = 0; i < this.rings.length; i++) this._step(this.rings[i], dt);
  }

  _step(fx, dt) {
    if (!fx.active) return;
    fx.t += dt;
    const k = fx.t / fx.dur;
    if (k >= 1) {
      fx.active = false;
      fx.mesh.visible = false;
      return;
    }
    this._apply(fx, k);
  }
}
