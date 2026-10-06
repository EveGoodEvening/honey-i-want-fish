// Loft geometry builder: sweeps superellipse cross-sections ("rings") along a
// path to make smooth organic parts (torso, sleeves, trouser legs, fingers,
// head). Supports open arcs (the open front of the jacket), a cloth shell
// thickness with rims, flat end caps, per-vertex skin weights and colours.
import * as THREE from 'three';
import { clamp } from './math.js';

/** Collects bone influences for one vertex and keeps the strongest four. */
export class WeightAcc {
  constructor() {
    this.idx = new Int32Array(12);
    this.w = new Float32Array(12);
    this.n = 0;
  }

  reset() {
    this.n = 0;
    return this;
  }

  add(bone, weight) {
    if (!(weight > 1e-4) || bone < 0) return this;
    for (let i = 0; i < this.n; i++) {
      if (this.idx[i] === bone) {
        this.w[i] += weight;
        return this;
      }
    }
    if (this.n < 12) {
      this.idx[this.n] = bone;
      this.w[this.n] = weight;
      this.n++;
    }
    return this;
  }

  /** Writes the top-4 normalized influences into flat arrays at offset o. */
  write(outIdx, outW, o) {
    // selection sort the top 4
    const n = this.n;
    for (let k = 0; k < Math.min(4, n); k++) {
      let best = k;
      for (let i = k + 1; i < n; i++) if (this.w[i] > this.w[best]) best = i;
      if (best !== k) {
        const ti = this.idx[k];
        this.idx[k] = this.idx[best];
        this.idx[best] = ti;
        const tw = this.w[k];
        this.w[k] = this.w[best];
        this.w[best] = tw;
      }
    }
    let sum = 0;
    for (let k = 0; k < Math.min(4, n); k++) sum += this.w[k];
    for (let k = 0; k < 4; k++) {
      if (k < n && sum > 0) {
        outIdx[o + k] = this.idx[k];
        outW[o + k] = this.w[k] / sum;
      } else {
        outIdx[o + k] = 0;
        outW[o + k] = 0;
      }
    }
    if (n === 0) outW[o] = 1; // bone 0 fallback
  }
}

const sgnpow = (x, p) => (x < 0 ? -Math.pow(-x, p) : Math.pow(x, p));

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * @param {object} o
 *  rings: [{ c:Vector3, ax:Vector3, az:Vector3, rx, rzf, rzb?, e? }]
 *         θ = 0 points along az ("front"), θ = +π/2 along ax.
 *  seg: segments around each ring
 *  arc?: (i, ring) => [a0, a1]   open arc per ring (default full circle −π..π)
 *  thetaFn?: (t∈[0,1]) => θ        custom angular spacing for closed rings
 *                                   (must map 0 → −π and 1 → π)
 *  bump?: (i, θ, ring, P) => radial offset (m)
 *  weights?: (P, i, θ, acc:WeightAcc) => void
 *  color?: (P, i, θ) => [r,g,b] (linear)
 *  uv?: (i, θ, P) => [u, v]        default: u = θ/2π·uScale, v = length·vScale
 *  uScale?, vScale?
 *  thickness?: shell thickness (adds inner surface)
 *  rimStart?, rimEnd?: close the shell at the first/last ring (needs thickness)
 *  capStart?, capEnd?: flat caps (closed tubes without thickness)
 *  flip?: invert the outward orientation test
 */
export function buildLoft(o) {
  const rings = o.rings;
  const R = rings.length;
  const S = o.seg;
  const cols = S + 1;
  const open = !!o.arc;
  const N = R * cols;
  const P = new Float32Array(N * 3);
  const NR = new Float32Array(N * 3);
  const TH = new Float32Array(N);
  const UV = new Float32Array(N * 2);

  // --- positions ----------------------------------------------------------
  let lenAcc = 0;
  for (let i = 0; i < R; i++) {
    const ring = rings[i];
    if (i > 0) lenAcc += ring.c.distanceTo(rings[i - 1].c);
    const [a0, a1] = open ? o.arc(i, ring) : [-Math.PI, Math.PI];
    const ex = 2 / (ring.e ?? 2);
    const rzb = ring.rzb ?? ring.rzf;
    for (let j = 0; j <= S; j++) {
      const th = o.thetaFn ? o.thetaFn(j / S) : a0 + ((a1 - a0) * j) / S;
      const s = Math.sin(th);
      const c = Math.cos(th);
      const px = ring.rx * sgnpow(s, ex);
      const pz = (c >= 0 ? ring.rzf : rzb) * sgnpow(c, ex);
      _p.copy(ring.c).addScaledVector(ring.ax, px).addScaledVector(ring.az, pz);
      if (o.bump) {
        const b = o.bump(i, th, ring, _p);
        if (b) {
          _r.copy(ring.ax).multiplyScalar(px).addScaledVector(ring.az, pz);
          const l = _r.length();
          if (l > 1e-6) _p.addScaledVector(_r, b / l);
        }
      }
      const k = i * cols + j;
      P[k * 3] = _p.x;
      P[k * 3 + 1] = _p.y;
      P[k * 3 + 2] = _p.z;
      TH[k] = th;
      if (o.uv) {
        const uv = o.uv(i, th, _p);
        UV[k * 2] = uv[0];
        UV[k * 2 + 1] = uv[1];
      } else {
        UV[k * 2] = ((th - (open ? a0 : -Math.PI)) / (Math.PI * 2)) * (o.uScale ?? 1);
        UV[k * 2 + 1] = lenAcc * (o.vScale ?? 1);
      }
    }
  }

  const get = (i, j, out) => {
    const k = (i * cols + j) * 3;
    return out.set(P[k], P[k + 1], P[k + 2]);
  };

  // --- normals (finite differences on the grid; wraps around closed rings) --
  let orient = 0;
  const TS = new Float32Array(N * 3); // along-length tangents (for rims)
  const TT = new Float32Array(N * 3); // around tangents
  for (let i = 0; i < R; i++) {
    const im = Math.max(0, i - 1);
    const ip = Math.min(R - 1, i + 1);
    for (let j = 0; j <= S; j++) {
      let jm = j - 1;
      let jp = j + 1;
      if (!open) {
        if (j === 0) jm = S - 1;
        if (j === S) jp = 1;
      } else {
        jm = Math.max(0, jm);
        jp = Math.min(S, jp);
      }
      get(i, jp, _a).sub(get(i, jm, _b)); // Tθ
      get(ip, j, _c).sub(get(im, j, _b)); // Ts
      const k = (i * cols + j) * 3;
      TT[k] = _a.x;
      TT[k + 1] = _a.y;
      TT[k + 2] = _a.z;
      TS[k] = _c.x;
      TS[k + 1] = _c.y;
      TS[k + 2] = _c.z;
      _r.crossVectors(_c, _a);
      if (_r.lengthSq() < 1e-16) {
        _r.copy(_c).multiplyScalar(i === 0 ? -1 : 1);
      }
      _r.normalize();
      NR[k] = _r.x;
      NR[k + 1] = _r.y;
      NR[k + 2] = _r.z;
      get(i, j, _p).sub(rings[i].c);
      orient += _p.dot(_r);
    }
  }
  const sign = (orient >= 0 ? 1 : -1) * (o.flip ? -1 : 1);
  if (sign < 0) for (let k = 0; k < NR.length; k++) NR[k] = -NR[k];
  // Fix up degenerate tip normals so they point away from the body.
  for (const i of [0, R - 1]) {
    for (let j = 0; j <= S; j++) {
      const k = (i * cols + j) * 3;
      _r.set(NR[k], NR[k + 1], NR[k + 2]);
      _c.set(TS[k], TS[k + 1], TS[k + 2]);
      const ringR = Math.max(rings[i].rx, rings[i].rzf);
      if (ringR < 0.002 && _c.lengthSq() > 0) {
        _c.normalize().multiplyScalar(i === 0 ? -1 : 1);
        NR[k] = _c.x;
        NR[k + 1] = _c.y;
        NR[k + 2] = _c.z;
      }
    }
  }

  // --- assemble ----------------------------------------------------------
  const pos = [];
  const nor = [];
  const uvs = [];
  const col = o.color ? [] : null;
  const skI = o.weights ? [] : null;
  const skW = o.weights ? [] : null;
  const idx = [];
  const acc = new WeightAcc();
  const tmpI = [0, 0, 0, 0];
  const tmpW = [0, 0, 0, 0];
  const wCache = o.weights ? new Array(N) : null;
  const cCache = o.color ? new Array(N) : null;

  if (o.weights) {
    for (let k = 0; k < N; k++) {
      const i = Math.floor(k / cols);
      _p.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
      acc.reset();
      o.weights(_p, i, TH[k], acc);
      acc.write(tmpI, tmpW, 0);
      wCache[k] = [tmpI[0], tmpI[1], tmpI[2], tmpI[3], tmpW[0], tmpW[1], tmpW[2], tmpW[3]];
    }
  }
  if (o.color) {
    for (let k = 0; k < N; k++) {
      const i = Math.floor(k / cols);
      _p.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
      cCache[k] = o.color(_p, i, TH[k]);
    }
  }

  const pushVert = (k, px, py, pz, nx, ny, nz, u, v) => {
    pos.push(px, py, pz);
    nor.push(nx, ny, nz);
    uvs.push(u, v);
    if (col) col.push(cCache[k][0], cCache[k][1], cCache[k][2]);
    if (skI) {
      const w = wCache[k];
      skI.push(w[0], w[1], w[2], w[3]);
      skW.push(w[4], w[5], w[6], w[7]);
    }
    return pos.length / 3 - 1;
  };

  // outer surface
  const base = 0;
  for (let k = 0; k < N; k++) {
    pushVert(k, P[k * 3], P[k * 3 + 1], P[k * 3 + 2], NR[k * 3], NR[k * 3 + 1], NR[k * 3 + 2], UV[k * 2], UV[k * 2 + 1]);
  }
  const quad = (a, b, c, d, flip) => {
    if (flip) idx.push(a, d, b, b, d, c);
    else idx.push(a, b, d, b, c, d);
  };
  // Triangle (a,b,d) normal = Ts × Tθ which matches NR when sign > 0.
  const outerFlip = sign < 0;
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < S; j++) {
      const a = base + i * cols + j;
      quad(a, a + cols, a + cols + 1, a + 1, outerFlip);
    }
  }

  // Adds a quad whose winding faces along `ref` (used for rims and caps).
  const quadFacing = (a, b, c, d, rx, ry, rz) => {
    _a.set(pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]);
    _b.set(pos[d * 3] - pos[a * 3], pos[d * 3 + 1] - pos[a * 3 + 1], pos[d * 3 + 2] - pos[a * 3 + 2]);
    _c.crossVectors(_a, _b);
    const flip = _c.x * rx + _c.y * ry + _c.z * rz < 0;
    quad(a, b, c, d, flip);
  };

  if (o.thickness) {
    const t = o.thickness;
    const innerBase = pos.length / 3;
    for (let k = 0; k < N; k++) {
      pushVert(
        k,
        P[k * 3] - NR[k * 3] * t,
        P[k * 3 + 1] - NR[k * 3 + 1] * t,
        P[k * 3 + 2] - NR[k * 3 + 2] * t,
        -NR[k * 3],
        -NR[k * 3 + 1],
        -NR[k * 3 + 2],
        UV[k * 2],
        UV[k * 2 + 1],
      );
    }
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < S; j++) {
        const a = innerBase + i * cols + j;
        quad(a, a + cols, a + cols + 1, a + 1, !outerFlip);
      }
    }
    // rim strips: duplicated verts with the rim's own normal (crisp edge)
    const rimAlongRing = (i, dirSign) => {
      const start = pos.length / 3;
      for (let j = 0; j <= S; j++) {
        const k = i * cols + j;
        _c.set(TS[k * 3], TS[k * 3 + 1], TS[k * 3 + 2]).normalize().multiplyScalar(dirSign);
        pushVert(k, P[k * 3], P[k * 3 + 1], P[k * 3 + 2], _c.x, _c.y, _c.z, UV[k * 2], UV[k * 2 + 1]);
        pushVert(k, P[k * 3] - NR[k * 3] * t, P[k * 3 + 1] - NR[k * 3 + 1] * t, P[k * 3 + 2] - NR[k * 3 + 2] * t, _c.x, _c.y, _c.z, UV[k * 2], UV[k * 2 + 1] + t);
      }
      for (let j = 0; j < S; j++) {
        const a = start + j * 2;
        const k = i * cols + j;
        _c.set(TS[k * 3], TS[k * 3 + 1], TS[k * 3 + 2]).multiplyScalar(dirSign);
        quadFacing(a, a + 1, a + 3, a + 2, _c.x, _c.y, _c.z);
      }
    };
    if (o.rimStart) rimAlongRing(0, -1);
    if (o.rimEnd) rimAlongRing(R - 1, 1);
    if (open) {
      const rimAlongLength = (j, dirSign) => {
        const start = pos.length / 3;
        for (let i = 0; i < R; i++) {
          const k = i * cols + j;
          _c.set(TT[k * 3], TT[k * 3 + 1], TT[k * 3 + 2]).normalize().multiplyScalar(dirSign);
          pushVert(k, P[k * 3], P[k * 3 + 1], P[k * 3 + 2], _c.x, _c.y, _c.z, UV[k * 2], UV[k * 2 + 1]);
          pushVert(k, P[k * 3] - NR[k * 3] * t, P[k * 3 + 1] - NR[k * 3 + 1] * t, P[k * 3 + 2] - NR[k * 3 + 2] * t, _c.x, _c.y, _c.z, UV[k * 2] + t, UV[k * 2 + 1]);
        }
        for (let i = 0; i < R - 1; i++) {
          const a = start + i * 2;
          const k = i * cols + j;
          _c.set(TT[k * 3], TT[k * 3 + 1], TT[k * 3 + 2]).multiplyScalar(dirSign);
          quadFacing(a, a + 1, a + 3, a + 2, _c.x, _c.y, _c.z);
        }
      };
      rimAlongLength(0, -1);
      rimAlongLength(S, 1);
    }
  }

  const cap = (i, dirSign) => {
    const ring = rings[i];
    // cap normal: along the path direction
    const k0 = i * cols;
    _c.set(TS[k0 * 3], TS[k0 * 3 + 1], TS[k0 * 3 + 2]);
    for (let j = 1; j < S; j++) {
      const k = (i * cols + j) * 3;
      _c.x += TS[k];
      _c.y += TS[k + 1];
      _c.z += TS[k + 2];
    }
    _c.normalize().multiplyScalar(dirSign);
    const nx = _c.x;
    const ny = _c.y;
    const nz = _c.z;
    const start = pos.length / 3;
    for (let j = 0; j <= S; j++) {
      const k = i * cols + j;
      pushVert(k, P[k * 3], P[k * 3 + 1], P[k * 3 + 2], nx, ny, nz, UV[k * 2], UV[k * 2 + 1]);
    }
    // centre (average of ring) — uses first ring vertex's weights/colour
    _p.set(0, 0, 0);
    for (let j = 0; j < S; j++) {
      const k = i * cols + j;
      _p.x += P[k * 3];
      _p.y += P[k * 3 + 1];
      _p.z += P[k * 3 + 2];
    }
    _p.multiplyScalar(1 / S);
    if (!open) _p.lerp(ring.c, 0.5);
    const ci = pushVert(i * cols, _p.x, _p.y, _p.z, nx, ny, nz, UV[i * cols * 2], UV[i * cols * 2 + 1]);
    for (let j = 0; j < S; j++) {
      const a = start + j;
      const b = start + j + 1;
      _a.set(pos[a * 3] - pos[ci * 3], pos[a * 3 + 1] - pos[ci * 3 + 1], pos[a * 3 + 2] - pos[ci * 3 + 2]);
      _b.set(pos[b * 3] - pos[ci * 3], pos[b * 3 + 1] - pos[ci * 3 + 1], pos[b * 3 + 2] - pos[ci * 3 + 2]);
      _r.crossVectors(_a, _b);
      if (_r.x * nx + _r.y * ny + _r.z * nz >= 0) idx.push(ci, a, b);
      else idx.push(ci, b, a);
    }
  };
  if (o.capStart) cap(0, -1);
  if (o.capEnd) cap(R - 1, 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (skI) {
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skW, 4));
  }
  g.setIndex(idx);
  return g;
}

/**
 * Builds rings along a smooth path through `points`, with a per-control-point
 * profile [{rx, rzf, rzb?, e?}] interpolated along the curve. Frames are
 * parallel-transported starting from `front` (the az axis), ax = az × tangent.
 * Each returned ring also carries `s` (arc length from the start) and `t`.
 */
export function pathRings(points, profiles, front, samples) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  const rings = [];
  const az = front.clone();
  let s = 0;
  let prev = null;
  const n = points.length;
  for (let k = 0; k <= samples; k++) {
    const t = k / samples;
    const c = curve.getPoint(t);
    const tan = curve.getTangent(t).normalize();
    az.addScaledVector(tan, -az.dot(tan));
    if (az.lengthSq() < 1e-10) {
      // front hint parallel to the path: pick any perpendicular
      az.set(0, 1, 0).addScaledVector(tan, -tan.y);
      if (az.lengthSq() < 1e-10) az.set(1, 0, 0).addScaledVector(tan, -tan.x);
    }
    az.normalize();
    const ax = new THREE.Vector3().crossVectors(az, tan).normalize();
    if (prev) s += c.distanceTo(prev);
    prev = c;
    const f = t * (n - 1);
    const i0 = Math.min(n - 2, Math.floor(f));
    const u = clamp(f - i0, 0, 1);
    const su = u * u * (3 - 2 * u) * 0.5 + u * 0.5; // softened interpolation
    const p0 = profiles[i0];
    const p1 = profiles[i0 + 1];
    const mix = (a, b) => a + (b - a) * su;
    rings.push({
      c,
      ax,
      az: az.clone(),
      tan,
      rx: mix(p0.rx, p1.rx),
      rzf: mix(p0.rzf, p1.rzf),
      rzb: mix(p0.rzb ?? p0.rzf, p1.rzb ?? p1.rzf),
      e: mix(p0.e ?? 2, p1.e ?? 2),
      s,
      t,
    });
  }
  return rings;
}

/** Merge several non-indexed/indexed geometries that share attribute sets. */
export function mergeParts(parts) {
  const names = Object.keys(parts[0].attributes);
  let vCount = 0;
  let iCount = 0;
  for (const g of parts) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const a0 = parts[0].attributes[name];
    const Ctor = a0.array.constructor;
    const arr = new Ctor(vCount * a0.itemSize);
    let off = 0;
    for (const g of parts) {
      const a = g.attributes[name];
      if (!a) throw new Error(`mergeParts: missing attribute ${name}`);
      arr.set(a.array, off);
      off += a.array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized));
  }
  const index = new Uint32Array(iCount);
  let io = 0;
  let vo = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) index[io++] = src[i] + vo;
    } else {
      for (let i = 0; i < n; i++) index[io++] = i + vo;
    }
    vo += n;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}
