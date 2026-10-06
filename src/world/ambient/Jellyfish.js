// Jellyfish — a few translucent jellies drifting at mid-depth.
//
// Bells: one InstancedMesh with a custom additive shader — pulsing
// contraction (fast squeeze, slow relax), fresnel rim, four lilac gonad
// horseshoes, radial canals and a faint bioluminescent margin that brightens
// with each pulse. Each contraction also thrusts the jelly along its axis.
// Tentacles + oral arms: verlet chains (follow-the-leader constraints) hanging
// from the bell rim, so they lag and trail behind every pulse; rendered as
// camera-facing ribbons expanded in the vertex shader (one draw call total).
// Jellies recycle around the player (never closer than MIN_SPAWN_DIST) so a
// few are always somewhere in the murk — background life, deliberately dim so
// they never out-shine a shark silhouette. The bioluminescent margin only
// comes alive in the darker water below ~30 m.
//
// Fog: the jellies are additive, so their light is attenuated by the same
// water transmittance curve as the global fog chunk (scene fog density,
// tau = 0.72x + 0.74x², reds absorbed 1.5x faster) — they sink into the murk
// with everything else.
//
// NaN safety: every pow() base is clamped to >= 0 and atan() never sees (0, 0).
// With MSAA, samples just outside a primitive extrapolate varyings (vAlong >
// 1); a NaN survives additive blending and shows up as a black speck after
// the PostFX resolve.
import * as THREE from 'three';
import { WORLD } from '../../core/config.js';
import { clamp, createRng, sceneFogDensity, smoothstep } from './util.js';

const QUALITY = {
  high: { count: 4, tentacles: 14, oral: 4, segs: 16 },
  medium: { count: 3, tentacles: 10, oral: 4, segs: 12 },
  low: { count: 3, tentacles: 8, oral: 3, segs: 9 },
};

const MIN_SPAWN_DIST = 15; // m from the player
const INTENSITY = 0.38;

// Shared GLSL: water transmittance of light travelling `dist` metres (the
// world-2 fog curve, per channel).
const WATER_TRANSMIT_GLSL = /* glsl */ `
  vec3 waterTransmit(float dist, float density) {
    float x = max(dist, 0.0) * density;
    return exp(-(0.72 * x + 0.74 * x * x) * vec3(1.5, 1.0, 0.9));
  }
`;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const CURRENT = new THREE.Vector3(0.11, 0, 0.05); // slow ambient drift, m/s

function createBellGeometry() {
  const pts = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const phi = s * Math.PI * 0.5;
    // slightly flattened dome
    pts.push(new THREE.Vector2(Math.sin(phi) * 1.0, Math.cos(phi) * 0.58 - 0.04 * s * s * s));
  }
  // inward-curling lip
  pts.push(new THREE.Vector2(0.985, -0.07));
  pts.push(new THREE.Vector2(0.93, -0.105));
  const geo = new THREE.LatheGeometry(pts, 32);
  geo.computeVertexNormals();
  return geo;
}

const BELL_VERT = /* glsl */ `
  attribute vec4 aJelly; // x contraction 0..1, y colour variant, z glow, w seed
  uniform float uTime;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  varying float vRim;
  varying float vFogDepth;
  varying vec4 vJelly;
  void main() {
    float c = aJelly.x;
    float rim = clamp(uv.y, 0.0, 1.0); // 0 apex .. 1 lip
    vec3 p = position;
    p.xz *= 1.0 - 0.25 * c * (0.3 + 0.7 * rim);
    p.y *= 1.0 + 0.16 * c;
    p.y -= 0.07 * c * rim * rim;
    // the apex ring is (0, y, 0): keep atan() away from (0, 0)
    float ang = rim > 0.0 ? atan(position.z, position.x) : 0.0;
    p.y += sin(ang * 8.0 + uTime * 1.7 + aJelly.w * 6.0) * 0.022 * rim * rim;
    vLocal = position;
    vRim = rim;
    vJelly = aJelly;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    vNormalV = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vViewDir = normalize(-mv.xyz);
    vFogDepth = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const BELL_FRAG = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uGonadColor;
  uniform vec3 uGlowColor;
  uniform float uFogDensity;
  uniform float uIntensity;
  uniform float uMarginGain;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying vec3 vLocal;
  varying float vRim;
  varying float vFogDepth;
  varying vec4 vJelly;
  ${WATER_TRANSMIT_GLSL}
  void main() {
    vec3 N = normalize(vNormalV);
    vec3 V = normalize(vViewDir);
    // |N.V| can exceed 1 by rounding: clamp before pow()
    float ndv = min(abs(dot(N, V)), 1.0);
    float fres = pow(max(1.0 - ndv, 0.0), 2.4);
    vec3 base = mix(uColorA, uColorB, vJelly.y);

    vec2 q = vLocal.xz;
    float rr = length(q);
    float ang = rr > 1e-5 ? atan(q.y, q.x) : 0.0;
    // four gonad horseshoes (open toward the centre, like a moon jelly)
    float gon = 0.0;
    for (int k = 0; k < 4; k++) {
      float a = float(k) * 1.5707963 + 0.785398;
      vec2 cp = vec2(cos(a), sin(a)) * 0.33;
      vec2 dq = q - cp;
      float d = length(dq);
      float rq = (d - 0.12) / 0.032; // signed: square it, never pow() it
      float ring = exp(-rq * rq);
      float open = smoothstep(-0.55, 0.1, dot(dq / max(d, 1e-4), normalize(cp)));
      gon += ring * open;
    }
    float canal = pow(abs(cos(ang * 8.0)), 70.0) * smoothstep(0.25, 0.95, rr);
    float margin = smoothstep(0.8, 0.96, vRim);
    float pulse = vJelly.x;

    vec3 col = base * (0.03 + 0.5 * fres);
    col += uGonadColor * gon * (0.16 + 0.1 * pulse);
    col += base * canal * 0.12;
    col += uGlowColor * margin * vJelly.z * (0.35 + 0.9 * pulse) * uMarginGain;

    gl_FragColor = vec4(col * waterTransmit(vFogDepth, uFogDensity) * uIntensity, 1.0);
  }
`;

const TENT_VERT = /* glsl */ `
  attribute vec3 aTangent;
  attribute float aSide;
  attribute float aAlong;
  attribute float aWidth;
  attribute float aKind;
  varying float vAlong;
  varying float vKind;
  varying float vSide;
  varying float vFogDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 t = normalize(mat3(modelViewMatrix) * aTangent + vec3(1e-5));
    vec3 viewDir = normalize(-mv.xyz);
    vec3 side = normalize(cross(t, viewDir) + vec3(1e-5));
    float w = aWidth * (1.0 - 0.7 * aAlong);
    mv.xyz += side * aSide * w;
    vAlong = aAlong;
    vKind = aKind;
    vSide = aSide;
    vFogDepth = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const TENT_FRAG = /* glsl */ `
  uniform vec3 uTentColor;
  uniform vec3 uOralColor;
  uniform float uFogDensity;
  uniform float uIntensity;
  varying float vAlong;
  varying float vKind;
  varying float vSide;
  varying float vFogDepth;
  ${WATER_TRANSMIT_GLSL}
  void main() {
    float core = 1.0 - smoothstep(0.15, 1.0, abs(vSide));
    // MSAA samples past the tip extrapolate vAlong > 1: clamp the pow() base
    float fade = pow(max(1.0 - vAlong, 0.0), 1.6) * (0.35 + 0.65 * smoothstep(0.0, 0.06, vAlong));
    vec3 c = mix(uTentColor, uOralColor, vKind) * core * fade;
    // stinging-cell banding on tentacles, frills on oral arms
    c *= 0.8 + 0.2 * sin(vAlong * mix(140.0, 60.0, vKind));
    gl_FragColor = vec4(c * waterTransmit(vFogDepth, uFogDensity) * uIntensity, 1.0);
  }
`;

export class Jellyfish {
  constructor(game, parent, { quality = 'high', seed = 99 } = {}) {
    this.game = game;
    const cfg = QUALITY[quality] ?? QUALITY.high;
    this.cfg = cfg;
    const rng = createRng(seed);
    this.rng = rng;
    this.time = 0;

    // ---- bells ----
    const count = cfg.count;
    this.count = count;
    const bellGeo = createBellGeometry();
    this.jellyAttr = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.jellyAttr.setUsage(THREE.DynamicDrawUsage);
    bellGeo.setAttribute('aJelly', this.jellyAttr);
    this.bellMaterial = new THREE.ShaderMaterial({
      name: 'AmbientLife.jellyBell',
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(0.5, 0.72, 0.95) },
        uColorB: { value: new THREE.Color(0.72, 0.6, 0.95) },
        uGonadColor: { value: new THREE.Color(0.85, 0.55, 0.95) },
        uGlowColor: { value: new THREE.Color(0.42, 1.5, 1.7) },
        uFogDensity: { value: 0.02 },
        uIntensity: { value: INTENSITY },
        uMarginGain: { value: 0.25 },
      },
      vertexShader: BELL_VERT,
      fragmentShader: BELL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.bells = new THREE.InstancedMesh(bellGeo, this.bellMaterial, count);
    this.bells.name = 'AmbientLife.jellyBells';
    this.bells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bells.frustumCulled = false;
    this.bells.renderOrder = 2;
    parent.add(this.bells);

    // ---- jelly state ----
    this.jellies = [];
    const chainsPer = cfg.tentacles + cfg.oral;
    for (let j = 0; j < count; j++) {
      const jelly = {
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        axis: new THREE.Vector3(0, 1, 0),
        quat: new THREE.Quaternion(),
        size: rng.range(0.32, 0.55),
        pulseRate: rng.range(0.42, 0.62),
        pulsePhase: rng(),
        c: 0,
        variant: rng(),
        glow: rng.range(0.5, 1.0),
        seed: rng(),
        chains: [],
      };
      for (let k = 0; k < chainsPer; k++) {
        const oral = k >= cfg.tentacles;
        const angle = oral ? (k - cfg.tentacles) / cfg.oral * Math.PI * 2 + 0.4 : (k / cfg.tentacles) * Math.PI * 2;
        jelly.chains.push({
          oral,
          angle,
          length: jelly.size * (oral ? rng.range(2.6, 3.6) : rng.range(4.0, 6.5)),
          width: oral ? jelly.size * 0.16 : 0.012 + jelly.size * 0.02,
          pts: new Float32Array(cfg.segs * 3),
          prev: new Float32Array(cfg.segs * 3),
          sway: rng() * Math.PI * 2,
        });
      }
      this.jellies.push(jelly);
    }

    // ---- tentacle ribbons (all jellies in one geometry) ----
    const S = cfg.segs;
    const chainCount = count * chainsPer;
    const vCount = chainCount * S * 2;
    const positions = new Float32Array(vCount * 3);
    const tangents = new Float32Array(vCount * 3);
    const side = new Float32Array(vCount);
    const along = new Float32Array(vCount);
    const width = new Float32Array(vCount);
    const kind = new Float32Array(vCount);
    const index = [];
    let v = 0;
    for (let j = 0; j < count; j++) {
      for (const ch of this.jellies[j].chains) {
        const base = v;
        for (let s = 0; s < S; s++) {
          for (let e = 0; e < 2; e++) {
            side[v] = e === 0 ? -1 : 1;
            along[v] = s / (S - 1);
            width[v] = ch.width;
            kind[v] = ch.oral ? 1 : 0;
            v++;
          }
          if (s < S - 1) {
            const a = base + s * 2;
            index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
      }
    }
    const tg = new THREE.BufferGeometry();
    this.tPos = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.tTan = new THREE.BufferAttribute(tangents, 3).setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('position', this.tPos);
    tg.setAttribute('aTangent', this.tTan);
    tg.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    tg.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    tg.setAttribute('aWidth', new THREE.BufferAttribute(width, 1));
    tg.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    tg.setIndex(index);
    this.tentMaterial = new THREE.ShaderMaterial({
      name: 'AmbientLife.jellyTentacles',
      uniforms: {
        uTentColor: { value: new THREE.Color(0.1, 0.17, 0.22) },
        uOralColor: { value: new THREE.Color(0.2, 0.13, 0.24) },
        uFogDensity: { value: 0.02 },
        uIntensity: { value: INTENSITY },
      },
      vertexShader: TENT_VERT,
      fragmentShader: TENT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.tentacles = new THREE.Mesh(tg, this.tentMaterial);
    this.tentacles.name = 'AmbientLife.jellyTentacles';
    this.tentacles.frustumCulled = false;
    this.tentacles.renderOrder = 1;
    parent.add(this.tentacles);

    this._placed = false;
  }

  _playerPos() {
    const p = this.game.player?.position;
    return p ?? _pp.fromArray(WORLD.playerSpawn);
  }

  _seabed(x, z) {
    const h = this.game.env?.getSeabedHeight?.(x, z);
    return Number.isFinite(h) ? h : WORLD.floorY;
  }

  // Put a jelly somewhere around the player (near = initial scatter;
  // otherwise recycle it out of sight, behind the camera, in the murk).
  // Never closer than MIN_SPAWN_DIST: a jelly popping up next to the player
  // would steal the eye from the sharks.
  _spawn(jelly, near) {
    const rng = this.rng;
    const p = this._playerPos();
    let a = rng() * Math.PI * 2;
    if (!near) {
      this.game.camera.getWorldDirection(_v);
      a = Math.atan2(-_v.z, -_v.x) + rng.range(-1.1, 1.1);
    }
    const d = near ? rng.range(MIN_SPAWN_DIST, 30) : rng.range(Math.max(MIN_SPAWN_DIST, 28), 38);
    const x = p.x + Math.cos(a) * d;
    const z = p.z + Math.sin(a) * d;
    const floor = this._seabed(x, z);
    const y = clamp(p.y + rng.range(-5, 9), Math.max(floor + 6, WORLD.floorY + 8), WORLD.surfaceY - 5);
    jelly.pos.set(x, y, z);
    jelly.vel.set(0, 0, 0);
    this._resetChains(jelly);
  }

  _resetChains(jelly) {
    const S = this.cfg.segs;
    for (const ch of jelly.chains) {
      const seg = ch.length / (S - 1);
      const r = (ch.oral ? 0.12 : 0.92) * jelly.size;
      const ax = jelly.pos.x + Math.cos(ch.angle) * r;
      const az = jelly.pos.z + Math.sin(ch.angle) * r;
      for (let s = 0; s < S; s++) {
        const o = s * 3;
        ch.pts[o] = ax;
        ch.pts[o + 1] = jelly.pos.y - s * seg;
        ch.pts[o + 2] = az;
        ch.prev[o] = ch.pts[o];
        ch.prev[o + 1] = ch.pts[o + 1];
        ch.prev[o + 2] = ch.pts[o + 2];
      }
    }
  }

  update(dt, threats) {
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 20);
    this.time += dt;
    const t = this.time;
    if (!this._placed) {
      for (const j of this.jellies) this._spawn(j, true);
      this._placed = true;
    }
    // Same water as everything else (see the header): scene density, no bonus.
    const fogD = sceneFogDensity(this.game.scene) || 0.02;
    this.bellMaterial.uniforms.uFogDensity.value = fogD;
    this.tentMaterial.uniforms.uFogDensity.value = fogD;
    this.bellMaterial.uniforms.uTime.value = t;
    // Bioluminescence only reads in the dark: a faint margin in the sunlit
    // mid-water, full glow below ~45 m.
    const camDepth = WORLD.surfaceY - this.game.camera.position.y;
    this.bellMaterial.uniforms.uMarginGain.value = 0.25 + 0.75 * smoothstep(30, 45, camDepth);

    const p = this._playerPos();
    const ja = this.jellyAttr.array;
    const S = this.cfg.segs;
    const T = threats.list;
    const TC = threats.count;

    for (let i = 0; i < this.count; i++) {
      const j = this.jellies[i];

      // recycle when far away
      const dx = j.pos.x - p.x;
      const dz = j.pos.z - p.z;
      if (dx * dx + dz * dz > 44 * 44 || j.pos.y > WORLD.surfaceY - 2) this._spawn(j, false);

      // pulse: fast contraction, slow relaxation
      j.pulsePhase += dt * j.pulseRate;
      const ph = j.pulsePhase % 1;
      const prevC = j.c;
      if (ph < 0.22) {
        const k = ph / 0.22;
        j.c = k * k * (3 - 2 * k);
      } else {
        const k = (ph - 0.22) / 0.78;
        j.c = 1 - k * k * (3 - 2 * k);
      }
      const dc = j.c - prevC;
      // thrust on contraction, slow sink between pulses: roughly neutral
      // buoyancy, so each jelly bobs up and settles back instead of drifting
      // to the surface
      if (dc > 0) j.vel.addScaledVector(j.axis, dc * 0.3);
      j.vel.multiplyScalar(Math.exp(-dt * 0.8));
      j.vel.y -= 0.16 * dt;

      // pushed by the wake of passing sharks
      for (let k = 0; k < TC; k++) {
        const th = T[k];
        if (th.kind !== 1) continue;
        const ex = j.pos.x - th.x;
        const ey = j.pos.y - th.y;
        const ez = j.pos.z - th.z;
        const R = th.radius * 0.6;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > R * R) continue;
        const d = Math.sqrt(d2) + 1e-3;
        const f = (1 - d / R) * 0.8 * dt;
        j.vel.x += (ex / d) * f + th.vx * f * 0.15;
        j.vel.y += (ey / d) * f + th.vy * f * 0.15;
        j.vel.z += (ez / d) * f + th.vz * f * 0.15;
      }

      j.pos.x += (j.vel.x + CURRENT.x) * dt;
      j.pos.y += (j.vel.y + CURRENT.y) * dt;
      j.pos.z += (j.vel.z + CURRENT.z) * dt;
      const floor = this._seabed(j.pos.x, j.pos.z);
      if (j.pos.y < floor + 4) j.vel.y += (floor + 4 - j.pos.y) * dt * 0.5;

      // gentle tumbling of the bell axis
      j.axis.set(Math.sin(t * 0.31 + j.seed * 20) * 0.28, 1, Math.cos(t * 0.23 + j.seed * 13) * 0.28).normalize();
      j.quat.setFromUnitVectors(_up, j.axis);
      _s.setScalar(j.size);
      _m.compose(j.pos, j.quat, _s);
      this.bells.setMatrixAt(i, _m);
      ja[i * 4] = j.c;
      ja[i * 4 + 1] = j.variant;
      ja[i * 4 + 2] = j.glow;
      ja[i * 4 + 3] = j.seed;

      this._updateChains(j, dt, t);
    }
    this.bells.instanceMatrix.needsUpdate = true;
    this.jellyAttr.needsUpdate = true;
    this._writeRibbons(S);
  }

  _updateChains(j, dt, t) {
    const S = this.cfg.segs;
    const squeeze = 1 - 0.25 * j.c;
    const damping = Math.exp(-dt * 2.2);
    const sink = -0.35 * dt * dt;
    for (let c = 0; c < j.chains.length; c++) {
      const ch = j.chains[c];
      // anchor on the (contracting) rim, in world space
      const r = (ch.oral ? 0.12 : 0.92 * squeeze) * j.size;
      _v.set(Math.cos(ch.angle) * r, ch.oral ? -0.02 * j.size : -0.06 * j.size, Math.sin(ch.angle) * r);
      _v.applyQuaternion(j.quat).add(j.pos);
      const P = ch.pts;
      const Q = ch.prev;
      P[0] = _v.x;
      P[1] = _v.y;
      P[2] = _v.z;
      Q[0] = _v.x;
      Q[1] = _v.y;
      Q[2] = _v.z;
      const seg = ch.length / (S - 1);
      const swayX = Math.sin(t * 0.9 + ch.sway) * 0.05 * dt * dt;
      const swayZ = Math.cos(t * 0.7 + ch.sway * 1.3) * 0.05 * dt * dt;
      for (let s = 1; s < S; s++) {
        const o = s * 3;
        const px = P[o];
        const py = P[o + 1];
        const pz = P[o + 2];
        const k = s / (S - 1);
        P[o] += (px - Q[o]) * damping + swayX * k * 6;
        P[o + 1] += (py - Q[o + 1]) * damping + sink;
        P[o + 2] += (pz - Q[o + 2]) * damping + swayZ * k * 6;
        Q[o] = px;
        Q[o + 1] = py;
        Q[o + 2] = pz;
        // follow-the-leader length constraint
        const ax = P[o] - P[o - 3];
        const ay = P[o + 1] - P[o - 2];
        const az = P[o + 2] - P[o - 1];
        const l = Math.sqrt(ax * ax + ay * ay + az * az) + 1e-6;
        const f = seg / l;
        P[o] = P[o - 3] + ax * f;
        P[o + 1] = P[o - 2] + ay * f;
        P[o + 2] = P[o - 1] + az * f;
      }
    }
  }

  _writeRibbons(S) {
    const pos = this.tPos.array;
    const tan = this.tTan.array;
    let v = 0;
    for (let i = 0; i < this.count; i++) {
      const chains = this.jellies[i].chains;
      for (let c = 0; c < chains.length; c++) {
        const P = chains[c].pts;
        for (let s = 0; s < S; s++) {
          const o = s * 3;
          const a = s > 0 ? o - 3 : o;
          const b = s < S - 1 ? o + 3 : o;
          const tx = P[b] - P[a];
          const ty = P[b + 1] - P[a + 1];
          const tz = P[b + 2] - P[a + 2];
          for (let e = 0; e < 2; e++) {
            const w = v * 3;
            pos[w] = P[o];
            pos[w + 1] = P[o + 1];
            pos[w + 2] = P[o + 2];
            tan[w] = tx;
            tan[w + 1] = ty;
            tan[w + 2] = tz;
            v++;
          }
        }
      }
    }
    this.tPos.needsUpdate = true;
    this.tTan.needsUpdate = true;
  }

  dispose() {
    this.bells.geometry.dispose();
    this.bellMaterial.dispose();
    this.tentacles.geometry.dispose();
    this.tentMaterial.dispose();
    this.bells.removeFromParent();
    this.tentacles.removeFromParent();
  }
}
