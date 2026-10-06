// Procedural sperm whale (Physeter) geometry, ~16 m.
//
// Local frame: nose at +Z (z ≈ +8.1), flukes at -Z (z ≈ -8.6), +Y up. Forward
// axis is +Z, so Object3D.lookAt(pointAhead) orients it correctly.
// Built from superellipse cross-sections lofted along Z (Catmull-Rom between
// stations): the enormous, nearly box-shaped spermaceti head with a blunt
// front, the narrow underslung lower jaw, a dorsal hump followed by the
// "knuckles" along the tail stock, small paddle flippers, and broad
// triangular flukes with a median notch.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// [z, halfWidth, halfHeight, yCentre, superellipse exponent]
const BODY_STATIONS = [
  [8.08, 0.62, 0.95, 0.3, 3.0],
  [7.98, 1.0, 1.36, 0.25, 3.2],
  [7.7, 1.18, 1.56, 0.18, 3.2],
  [7.0, 1.28, 1.66, 0.12, 3.0],
  [5.5, 1.33, 1.7, 0.08, 2.8],
  [4.0, 1.36, 1.72, 0.05, 2.6],
  [2.8, 1.38, 1.72, 0.0, 2.4],
  [1.6, 1.42, 1.7, -0.05, 2.2],
  [0.0, 1.4, 1.65, -0.08, 2.1],
  [-1.6, 1.25, 1.5, -0.05, 2.0],
  [-3.0, 1.0, 1.28, 0.0, 2.0],
  [-4.4, 0.68, 0.98, 0.05, 2.0],
  [-5.6, 0.44, 0.72, 0.08, 2.0],
  [-6.6, 0.28, 0.48, 0.08, 2.0],
  [-7.3, 0.17, 0.26, 0.06, 2.0],
  [-7.62, 0.08, 0.12, 0.05, 2.0],
];

const JAW_STATIONS = [
  [7.02, 0.1, 0.07, -1.44, 2.0],
  [6.75, 0.26, 0.15, -1.5, 2.0],
  [5.5, 0.33, 0.2, -1.53, 2.0],
  [4.0, 0.38, 0.22, -1.55, 2.0],
  [2.9, 0.45, 0.24, -1.52, 2.0],
  [2.3, 0.3, 0.14, -1.45, 2.0],
];

// dorsal hump + knuckles: [z, height, halfWidthAlongZ]
const DORSAL_BUMPS = [
  [-2.55, 0.34, 0.55],
  [-3.55, 0.13, 0.2],
  [-4.15, 0.11, 0.18],
  [-4.7, 0.09, 0.16],
  [-5.2, 0.07, 0.14],
  [-5.65, 0.05, 0.12],
];

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function resample(stations, perSegment) {
  const out = [];
  const n = stations.length;
  for (let i = 0; i < n - 1; i++) {
    const s0 = stations[Math.max(0, i - 1)];
    const s1 = stations[i];
    const s2 = stations[i + 1];
    const s3 = stations[Math.min(n - 1, i + 2)];
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      const row = [];
      for (let c = 0; c < 5; c++) row.push(catmull(s0[c], s1[c], s2[c], s3[c], t));
      out.push(row);
    }
  }
  out.push(stations[n - 1].slice());
  return out;
}

function sgnPow(x, p) {
  return Math.sign(x) * Math.pow(Math.abs(x), p);
}

/**
 * Loft superellipse rings into an indexed geometry with end caps.
 * uv.x runs around the body (0 at the right flank, 0.25 on top), uv.y along it
 * (0 at the first station). `bumpFn(z, s)` adds height to the upper surface.
 */
function loft(stations, { perSegment = 4, radial = 32, bumpFn = null, vScale = 1, frontCapBulge = 0.08, backCapBulge = 0.05 }) {
  const rings = resample(stations, perSegment);
  const R = rings.length;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i < R; i++) {
    const [z, w, h, yc, n] = rings[i];
    const e = 2 / n;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      let y = yc + h * sgnPow(s, e);
      if (bumpFn && s > 0) y += bumpFn(z) * Math.pow(s, 4);
      pos.push(w * sgnPow(c, e), y, z);
      uv.push(j / radial, (i / (R - 1)) * vScale);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      // rings go from +Z (front) toward -Z: this winding faces outward
      idx.push(a, d, b, a, c, d);
    }
  }
  // front cap
  const f = rings[0];
  const fc = pos.length / 3;
  pos.push(0, f[3], f[0] + frontCapBulge);
  uv.push(0.5, 0);
  for (let j = 0; j < radial; j++) idx.push(fc, j, j + 1);
  // back cap
  const l = rings[R - 1];
  const bc = pos.length / 3;
  pos.push(0, l[3], l[0] - backCapBulge);
  uv.push(0.5, vScale);
  const lastRow = (R - 1) * row;
  for (let j = 0; j < radial; j++) idx.push(bc, lastRow + j + 1, lastRow + j);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // weld the UV seam's normals so the flank shows no crease
  const nrm = geo.attributes.normal;
  for (let i = 0; i < R; i++) {
    const a = i * row;
    const b = a + radial;
    const nx = nrm.getX(a) + nrm.getX(b);
    const ny = nrm.getY(a) + nrm.getY(b);
    const nz = nrm.getZ(a) + nrm.getZ(b);
    const len = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / len, ny / len, nz / len);
    nrm.setXYZ(b, nx / len, ny / len, nz / len);
  }
  return geo;
}

function dorsalBump(z) {
  let y = 0;
  for (const [bz, bh, bw] of DORSAL_BUMPS) {
    const d = (z - bz) / bw;
    y += bh * Math.exp(-d * d);
  }
  return y;
}

function createFlukes() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(0.55, 0.06, 1.55, 0.4, 2.4, 1.18);
  s.bezierCurveTo(2.05, 1.42, 1.05, 1.36, 0.32, 1.48);
  s.lineTo(0, 1.3);
  s.lineTo(-0.32, 1.48);
  s.bezierCurveTo(-1.05, 1.36, -2.05, 1.42, -2.4, 1.18);
  s.bezierCurveTo(-1.55, 0.4, -0.55, 0.06, 0, 0);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.08,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.07,
    bevelSegments: 2,
    curveSegments: 10,
  });
  // shape XY → whale XZ (shape +Y runs backward along -Z), extrusion → Y
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.02, -7.32);
  // scale UVs (metres) into texture space
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.12 + 0.5, 0.97 + uv.getY(i) * 0.01);
  return geo;
}

function createRightFlipper() {
  const geo = new THREE.SphereGeometry(1, 16, 10);
  geo.scale(0.78, 0.07, 0.34);
  // hinge at the inner end, swept back and drooping
  geo.translate(0.7, 0, -0.12);
  geo.rotateY(0.55);
  geo.rotateZ(-0.5);
  geo.translate(1.22, -1.05, 2.35);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), 0.3 + uv.getY(i) * 0.05);
  return geo;
}

function mirrorX(src) {
  const geo = src.clone();
  geo.scale(-1, 1, 1);
  // mirroring flips the winding; swap two indices per triangle to restore it
  const index = geo.index.array;
  for (let i = 0; i < index.length; i += 3) {
    const t = index[i + 1];
    index[i + 1] = index[i + 2];
    index[i + 2] = t;
  }
  geo.index.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function createWhaleGeometry({ quality = 'high' } = {}) {
  const radial = quality === 'low' ? 18 : 32;
  const per = quality === 'low' ? 2 : 4;
  const body = loft(BODY_STATIONS, { perSegment: per, radial, bumpFn: dorsalBump });
  const jaw = loft(JAW_STATIONS, { perSegment: per, radial: Math.max(12, radial / 2), vScale: 0.28, frontCapBulge: 0.04 });
  const flipper = createRightFlipper();
  const parts = [body, jaw, flipper, mirrorX(flipper), createFlukes()].map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    // keep only the attributes every part has
    for (const name of Object.keys(ng.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) ng.deleteAttribute(name);
    }
    ng.clearGroups();
    return ng;
  });
  const merged = mergeGeometries(parts, false);
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

export const WHALE_LENGTH = 16.7;
