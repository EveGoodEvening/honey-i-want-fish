// Analytic description of a shark body: lofted superellipse cross-sections
// along a spine, the jaw sector, gill grooves and the bone layout used for
// skinning. Shared by the geometry builder, the texture painter (so painted
// gill slits / mouth lines land exactly on the geometry) and the runtime rig.
//
// Model space (metres): +Z = forward (snout), +Y = up, X = lateral. The
// object origin sits at s = spec.sOrigin on the body axis, so
// z(s) = (sOrigin - s) * L.
import * as THREE from 'three';
import { clamp, smoothstep } from './noise.js';

const DEG = Math.PI / 180;
const LUT_N = 2048;

// Monotone cubic (PCHIP) interpolation: smooth like a spline but never
// overshoots the keyframes, so body outlines stay fair.
function pchip(xs, ys) {
  const n = xs.length;
  const h = new Float64Array(n - 1);
  const d = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    h[k] = xs[k + 1] - xs[k];
    d[k] = (ys[k + 1] - ys[k]) / h[k];
  }
  const m = new Float64Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) m[k] = 0;
    else {
      const w1 = 2 * h[k] + h[k - 1];
      const w2 = h[k] + 2 * h[k - 1];
      m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    const t = (x - xs[k]) / h[k];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k]
      + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1];
  };
}

// Bone indices shared by geometry (skin weights), rig and hurtboxes.
export const BONE = {
  root: 0,
  sp1: 1, sp2: 2, sp3: 3, sp4: 4, sp5: 5, sp6: 6, sp7: 7, sp8: 8,
  head: 9,
  snout: 10,
  upperJaw: 11,
  jaw: 12,
  throat: 13,
  pecN: 14,
  pecP: 15,
};
export const BONE_COUNT = 16;
export const SPINE_BONES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

export class SharkAnatomy {
  constructor(spec) {
    this.spec = spec;
    this.L = spec.length;
    const P = spec.profile;
    const xs = P.map((r) => r[0]);
    const fTop = pchip(xs, P.map((r) => r[1]));
    const fBot = pchip(xs, P.map((r) => r[2]));
    const fW = pchip(xs, P.map((r) => r[3]));
    this.sEnd = xs[xs.length - 1];

    // Dense lookup tables (fast per-texel / per-vertex queries). The snout
    // gets a cap over its first sCap: elliptical (a rounded dome) by default;
    // with spec.noseCone a parabolic tip that meets the profile's slope at
    // sCap (r = rC·√q·(1 + (½ − m)(1 − q)), m its log-slope there) and a
    // straight mid line — a small rounded point flowing into the head. The
    // dome ends flat while the head keeps widening behind it: a crease ring
    // that read as a dolphin's beak head-on.
    this.lutTop = new Float32Array(LUT_N);
    this.lutBot = new Float32Array(LUT_N);
    this.lutW = new Float32Array(LUT_N);
    const sCap = spec.noseCap ?? 0.014;
    const topC = fTop(sCap);
    const botC = fBot(sCap);
    const wC = fW(sCap);
    const midTip = (P[0][1] + P[0][2]) * 0.5;
    const midC = (topC + botC) * 0.5;
    const hC = (topC - botC) * 0.5;
    const cone = !!spec.noseCone;
    const eps = 1e-4;
    const dS = (f) => (f(sCap + eps) - f(sCap - eps)) / (2 * eps);
    const mW = clamp((dS(fW) * sCap) / Math.max(1e-6, wC), 0.3, 1.2);
    const mH = clamp((0.5 * (dS(fTop) - dS(fBot)) * sCap) / Math.max(1e-6, hC), 0.3, 1.2);
    const midSlope = 0.5 * (dS(fTop) + dS(fBot));
    for (let i = 0; i < LUT_N; i++) {
      const s = (i / (LUT_N - 1)) * this.sEnd;
      if (s < sCap) {
        const q = s / sCap;
        let kW;
        let kH;
        let mid;
        if (cone) {
          const rq = Math.sqrt(q);
          kW = rq * (1 + (0.5 - mW) * (1 - q));
          kH = rq * (1 + (0.5 - mH) * (1 - q));
          mid = midC - midSlope * sCap * (1 - q);
        } else {
          kW = kH = Math.sqrt(Math.max(0, 1 - (1 - q) * (1 - q)));
          mid = midTip + (midC - midTip) * q;
        }
        this.lutTop[i] = mid + hC * kH;
        this.lutBot[i] = mid - hC * kH;
        this.lutW[i] = wC * kW;
      } else {
        this.lutTop[i] = fTop(s);
        this.lutBot[i] = fBot(s);
        this.lutW[i] = Math.max(0, fW(s));
      }
    }
    this._p = { top: 0, bot: 0, w: 0, mid: 0, h: 0 };

    const m = spec.mouth;
    this.mouth = {
      sFront: m.sFront,
      sHinge: m.sHinge,
      sClose: m.sClose,
      deltaMax: m.deltaMax * DEG,
    };

    // Joint blending for axial skinning. Bone k (spine chain) owns the body
    // segment behind its pivot; weights blend smoothly across each pivot.
    const spineS = spec.spineS;
    this.joints = [{ s: spec.headS, a: BONE.head, b: BONE.root, hw: 0.04 }];
    for (let k = 1; k < spineS.length; k++) {
      const segPrev = spineS[k] - spineS[k - 1];
      const segNext = k + 1 < spineS.length ? spineS[k + 1] - spineS[k] : segPrev;
      this.joints.push({ s: spineS[k], a: SPINE_BONES[k - 1], b: SPINE_BONES[k], hw: 0.42 * Math.min(segPrev, segNext) });
    }
  }

  /** Normalised profile at s (shared object, overwritten by the next call). */
  profile(s) {
    const f = clamp(s / this.sEnd, 0, 1) * (LUT_N - 1);
    const i = Math.min(LUT_N - 2, Math.floor(f));
    const t = f - i;
    const p = this._p;
    p.top = this.lutTop[i] + (this.lutTop[i + 1] - this.lutTop[i]) * t;
    p.bot = this.lutBot[i] + (this.lutBot[i + 1] - this.lutBot[i]) * t;
    p.w = this.lutW[i] + (this.lutW[i + 1] - this.lutW[i]) * t;
    p.mid = (p.top + p.bot) * 0.5;
    p.h = (p.top - p.bot) * 0.5;
    return p;
  }

  z(s) {
    return (this.spec.sOrigin - s) * this.L;
  }

  /** Inverse of z(): body parameter for a model-space z. */
  sFromZ(z) {
    return this.spec.sOrigin - z / this.L;
  }

  /** Point on the body axis (model space). */
  center(s, out) {
    const p = this.profile(s);
    return out.set(0, p.mid * this.L, this.z(s));
  }

  /** Half-angle (radians) of the lower-jaw sector around the ventral midline. */
  delta(s) {
    const m = this.mouth;
    if (s <= m.sFront) return 0;
    if (s <= m.sHinge) return m.deltaMax * Math.sqrt((s - m.sFront) / (m.sHinge - m.sFront));
    if (s < m.sClose) {
      const t = (s - m.sHinge) / (m.sClose - m.sHinge);
      return m.deltaMax * (1 - t * t * (3 - 2 * t));
    }
    return 0;
  }

  /** Normalised inward displacement of the gill grooves at (s, theta). */
  gillDepth(s, theta) {
    const g = this.spec.gills;
    if (!g) return 0;
    const sLast = g.s0 + (g.count - 1) * g.spacing;
    if (s < g.s0 - 0.03 || s > sLast + 0.03) return 0;
    const sn = Math.sin(theta);
    const lat = Math.asin(clamp(sn, -1, 1));
    let best = 0;
    for (let i = 0; i < g.count; i++) {
      const a0 = g.bottom * DEG * (1 - 0.1 * i);
      const a1 = g.top * DEG * (1 - 0.07 * i);
      if (lat < a0 - 0.05 || lat > a1 + 0.05) continue;
      const vfade = smoothstep(a0 - 0.02, a0 + 0.14, lat) * (1 - smoothstep(a1 - 0.14, a1 + 0.02, lat));
      // Slits lean backward toward the belly and curve slightly.
      const si = g.s0 + i * g.spacing + g.slant * (-sn) - 0.006 * (1 - sn * sn);
      const d = s - si;
      const w = g.width;
      let v = 0;
      // Soft anterior wall, sharp posterior flap (the gill septum overlaps).
      if (d < 0 && d > -w * 2.2) v = Math.exp(-((d / (w * 0.95)) ** 2));
      else if (d >= 0 && d < w) v = Math.exp(-((d / (w * 0.32)) ** 2));
      v *= vfade;
      if (v > best) best = v;
    }
    return best * g.depth;
  }

  /** Signed distance (in s units) to the nearest gill slit centre line, for painting. */
  gillSlit(s, theta) {
    const g = this.spec.gills;
    if (!g) return null;
    const sn = Math.sin(theta);
    const lat = Math.asin(clamp(sn, -1, 1));
    let bestD = 1;
    let bestFade = 0;
    for (let i = 0; i < g.count; i++) {
      const a0 = g.bottom * DEG * (1 - 0.1 * i);
      const a1 = g.top * DEG * (1 - 0.07 * i);
      if (lat < a0 - 0.02 || lat > a1 + 0.02) continue;
      const fade = smoothstep(a0 - 0.02, a0 + 0.1, lat) * (1 - smoothstep(a1 - 0.1, a1 + 0.02, lat));
      const si = g.s0 + i * g.spacing + g.slant * (-sn) - 0.006 * (1 - sn * sn);
      const d = s - si;
      if (Math.abs(d) < Math.abs(bestD)) {
        bestD = d;
        bestFade = fade;
      }
    }
    return bestFade > 0 ? { d: bestD, fade: bestFade } : null;
  }

  /**
   * Point on the body surface (model space, metres).
   * theta: radians, 0 = +x flank, PI/2 = dorsal, -PI/2 = ventral.
   */
  surface(s, theta, out, detail = true) {
    const sp = this.spec;
    s = clamp(s, 0, this.sEnd);
    const p = this.profile(s);
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    let n = sn >= 0 ? sp.expTop : sp.expBottom;
    if (sp.headSquare) n += sp.headSquare * (1 - smoothstep(0.0, 0.24, s));
    const e = 2 / n;
    let x = p.w * Math.sign(c) * Math.pow(Math.abs(c), e);
    let y = p.h * Math.sign(sn) * Math.pow(Math.abs(sn), e);
    const k = sp.keel;
    if (k && s > k.s0 && s < k.s1) {
      x += Math.sign(c) * k.amount * Math.sin(Math.PI * (s - k.s0) / (k.s1 - k.s0)) * Math.exp(-((sn / 0.22) ** 2));
    }
    if (detail) {
      const g = this.gillDepth(s, theta);
      if (g > 0) {
        const r = Math.hypot(x, y) || 1;
        x -= (x / r) * g;
        y -= (y / r) * g;
      }
    }
    return out.set(x * this.L, (p.mid + y) * this.L, this.z(s));
  }

  /** Outward surface normal via central differences of the analytic surface. */
  surfaceNormal(s, theta, out, detail = true) {
    const es = 0.0012;
    const et = 0.01;
    const s0 = Math.max(0, s - es);
    const s1 = Math.min(this.sEnd, s + es);
    this.surface(s1, theta, _a, detail);
    this.surface(s0, theta, _b, detail);
    this.surface(s, theta + et, _c, detail);
    this.surface(s, theta - et, _d, detail);
    _a.sub(_b); // d/ds (points backward, -z)
    _c.sub(_d); // d/dtheta
    out.crossVectors(_a, _c);
    if (out.lengthSq() < 1e-14) {
      if (s < 0.5) out.set(0, 0, 1);
      else out.set(0, 0, -1);
      return out;
    }
    return out.normalize();
  }

  /** Lip point on side `side` (+1 = +x, -1 = -x) at s. */
  lip(s, side, out) {
    const theta = side > 0 ? -Math.PI / 2 + this.delta(s) : (3 * Math.PI) / 2 - this.delta(s);
    return this.surface(s, theta, out, false);
  }

  /** Skin weights for the axial chain at s → fills idx[0..1], w[0..1]. */
  axialWeights(s, idx, w) {
    const J = this.joints;
    let owner = BONE.head;
    for (let k = 0; k < J.length; k++) if (s >= J[k].s) owner = J[k].b;
    idx[0] = owner;
    w[0] = 1;
    idx[1] = owner;
    w[1] = 0;
    for (let k = 0; k < J.length; k++) {
      const j = J[k];
      if (Math.abs(s - j.s) < j.hw) {
        const t = smoothstep(j.s - j.hw, j.s + j.hw, s);
        idx[0] = j.a;
        w[0] = 1 - t;
        idx[1] = j.b;
        w[1] = t;
        break;
      }
    }
  }

  /** The bone that dominates the skin at s (used for hurtbox attachment). */
  dominantBone(s) {
    const idx = [0, 0];
    const w = [0, 0];
    this.axialWeights(s, idx, w);
    return w[0] >= w[1] ? idx[0] : idx[1];
  }
}
