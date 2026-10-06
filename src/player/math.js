// Small math / noise helpers shared by the player module. Everything here is
// allocation-free so it can be used from per-frame code.
import * as THREE from 'three';

export const TAU = Math.PI * 2;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function smoothstep(e0, e1, x) {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. */
export function damp(a, b, lambda, dt) {
  return a + (b - a) * (1 - Math.exp(-lambda * dt));
}

export function gauss(x, mu, sigma) {
  const d = (x - mu) / sigma;
  return Math.exp(-0.5 * d * d);
}

export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInCubic = (t) => t * t * t;
export const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * saturate(t));
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

/** Soft saturation: ~linear for small x, approaches ±limit. */
export function softClamp(x, limit) {
  return limit * Math.tanh(x / limit);
}

// ---------------------------------------------------------------------------
// Hash-based value noise
// ---------------------------------------------------------------------------

function hash3i(i, j, k) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** 3D value noise in [-1, 1]. */
export function noise3(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);
  const c000 = hash3i(xi, yi, zi);
  const c100 = hash3i(xi + 1, yi, zi);
  const c010 = hash3i(xi, yi + 1, zi);
  const c110 = hash3i(xi + 1, yi + 1, zi);
  const c001 = hash3i(xi, yi, zi + 1);
  const c101 = hash3i(xi + 1, yi, zi + 1);
  const c011 = hash3i(xi, yi + 1, zi + 1);
  const c111 = hash3i(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

export function fbm3(x, y, z, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise3(x, y, z) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    z *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Tileable 2D value noise with integer periods (px, py) in lattice units. */
export function pnoise2(x, y, px, py, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = hash3i(x0, y0, seed);
  const b = hash3i(x1, y0, seed);
  const c = hash3i(x0, y1, seed);
  const d = hash3i(x1, y1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 2 - 1;
}

/** Tileable fBm on the unit square; `freq` must be an integer. */
export function pfbm2(u, v, freq, octaves = 4, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += pnoise2(u * f, v * f, f, f, seed + o * 17) * amp;
    norm += amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Smooth 1D noise in [-1, 1] for procedural animation jitter. */
export function noise1(x, seed = 0) {
  const xi = Math.floor(x);
  const t = fade(x - xi);
  const a = hash3i(xi, seed, 7);
  const b = hash3i(xi + 1, seed, 7);
  return (a + (b - a) * t) * 2 - 1;
}

/** Deterministic pseudo random in [0,1) from an integer seed. */
export function rand1(i) {
  return hash3i(i, 91, 13);
}

// ---------------------------------------------------------------------------
// Orientation helpers
// ---------------------------------------------------------------------------

const _m4 = new THREE.Matrix4();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();

/** Quaternion from three orthonormal basis vectors (columns). */
export function quatFromBasis(out, x, y, z) {
  _m4.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m4);
}

/**
 * Quaternion whose local +Y maps to `up` and local +Z maps to (the part of)
 * `front` orthogonal to `up`. Model convention used across the player:
 * +Y = head direction, +Z = chest direction, +X = character's left.
 */
export function quatFromUpFront(out, up, front) {
  _by.copy(up).normalize();
  _bx.crossVectors(_by, front);
  if (_bx.lengthSq() < 1e-10) {
    // front parallel to up: pick any perpendicular
    _bx.set(1, 0, 0).cross(_by);
    if (_bx.lengthSq() < 1e-10) _bx.set(0, 0, 1).cross(_by);
  }
  _bx.normalize();
  _bz.crossVectors(_bx, _by).normalize();
  return quatFromBasis(out, _bx, _by, _bz);
}

/**
 * Quaternion that maps local axis A (primary) to `primary` and local axis B
 * (secondary) toward `secondary`. Used for hands: primary = fingers/knife
 * direction, secondary = palm/edge direction. Returns rotation of the frame
 * (primary, secondary, primary×secondary).
 */
export function quatFromPrimarySecondary(out, primary, secondary) {
  _bx.copy(primary).normalize();
  _by.copy(secondary).addScaledVector(_bx, -_bx.dot(secondary));
  if (_by.lengthSq() < 1e-10) {
    _by.set(0, 1, 0).addScaledVector(_bx, -_bx.y);
    if (_by.lengthSq() < 1e-10) _by.set(1, 0, 0).addScaledVector(_bx, -_bx.x);
  }
  _by.normalize();
  _bz.crossVectors(_bx, _by);
  return quatFromBasis(out, _bx, _by, _bz);
}

/** Angle of the twist component of `q` around unit `axis` (swing-twist split). */
export function twistAngle(q, axis) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  let a = 2 * Math.atan2(d, q.w);
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}

// ---------------------------------------------------------------------------
// Keyframe sampling (Catmull-Rom). Keys: arrays [t, x, y, z] sorted by t.
// ---------------------------------------------------------------------------

function cr(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function findSeg(keys, t) {
  const n = keys.length;
  if (t <= keys[0][0]) return 0;
  for (let i = 0; i < n - 1; i++) if (t < keys[i + 1][0]) return i;
  return n - 2;
}

/** Non-looping vec3 spline (clamped at the ends). */
export function sampleVec3(keys, t, out) {
  const n = keys.length;
  if (n === 1 || t <= keys[0][0]) return out.set(keys[0][1], keys[0][2], keys[0][3]);
  if (t >= keys[n - 1][0]) return out.set(keys[n - 1][1], keys[n - 1][2], keys[n - 1][3]);
  const i = findSeg(keys, t);
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(n - 1, i + 2)];
  const s = (t - k1[0]) / (k2[0] - k1[0]);
  return out.set(cr(k0[1], k1[1], k2[1], k3[1], s), cr(k0[2], k1[2], k2[2], k3[2], s), cr(k0[3], k1[3], k2[3], k3[3], s));
}

/** Looping vec3 spline over t in [0,1); keys hold unique points in [0,1). */
export function sampleLoopVec3(keys, t, out) {
  const n = keys.length;
  t -= Math.floor(t);
  let i = n - 1;
  for (let j = 0; j < n; j++) {
    if (t < keys[j][0]) {
      i = j - 1;
      break;
    }
  }
  if (i < 0) i = n - 1;
  const k1 = keys[i];
  const k2 = keys[(i + 1) % n];
  const k0 = keys[(i - 1 + n) % n];
  const k3 = keys[(i + 2) % n];
  let t1 = k1[0];
  let t2 = k2[0];
  if (t2 <= t1) t2 += 1;
  let tt = t;
  if (tt < t1) tt += 1;
  const s = (tt - t1) / (t2 - t1);
  return out.set(cr(k0[1], k1[1], k2[1], k3[1], s), cr(k0[2], k1[2], k2[2], k3[2], s), cr(k0[3], k1[3], k2[3], k3[3], s));
}

/** Non-looping scalar spline, keys: [t, v]. */
export function sampleScalar(keys, t) {
  const n = keys.length;
  if (n === 1 || t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  const i = findSeg(keys, t);
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(n - 1, i + 2)];
  const s = (t - k1[0]) / (k2[0] - k1[0]);
  return cr(k0[1], k1[1], k2[1], k3[1], s);
}

/** Looping scalar spline over [0,1). */
export function sampleLoopScalar(keys, t) {
  const n = keys.length;
  t -= Math.floor(t);
  let i = n - 1;
  for (let j = 0; j < n; j++) {
    if (t < keys[j][0]) {
      i = j - 1;
      break;
    }
  }
  if (i < 0) i = n - 1;
  const k1 = keys[i];
  const k2 = keys[(i + 1) % n];
  const k0 = keys[(i - 1 + n) % n];
  const k3 = keys[(i + 2) % n];
  let t1 = k1[0];
  let t2 = k2[0];
  if (t2 <= t1) t2 += 1;
  let tt = t;
  if (tt < t1) tt += 1;
  const s = (tt - t1) / (t2 - t1);
  return cr(k0[1], k1[1], k2[1], k3[1], s);
}
