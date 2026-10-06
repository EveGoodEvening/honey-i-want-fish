// Browser-free preview of the sharks (Node, no WebGL — no gate needed): software-rasterises the
// real skinned geometry in its rest pose (SharkGeometry: body, fins, mouth, rest-pose teeth, eyes)
// with the painted skin (SharkTextures.paintSkin: albedo × vertex colour, normal map, AO) under a
// rough underwater light (sun from above, blue-green hemisphere fill, distance fog). Not the game's
// look — use it to iterate on the silhouette, countershading, gills and markings in seconds,
// then judge the result in game (frozen shots through the gate).
//
//   node scripts/enemies-sharkview.mjs [out.png] [--species megalodon,greatWhite]
//        [--views 0,1,2,3,4,5] [--tex 1024] [--size 360] [--fov 55] [--clay]
//
// One row per species, one column per view. The camera sits at mouth + forward·a + right·b +
// up·h and looks at mouth − forward·back + up·lh (metres for the 16 m megalodon, scaled by
// body length for the others — the great white is seen at 6/16 of the distances):
//   0 head-on 8 m · 1 three-quarter front 8 m · 2 three-quarter from below (9 m) ·
//   3 from below, ahead of the jaws (the roar / corpse view) · 4 pectoral close-up (6 m) ·
//   5 side at 20 m · 6 head profile (11 m abeam, at mouth level).
// --clay drops the textures (shape only).
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { getSpecies } from '../src/enemies/species.js';
import { buildSharkGeometry } from '../src/enemies/SharkGeometry.js';
import { paintSkin } from '../src/enemies/SharkTextures.js';
import { BONE } from '../src/enemies/SharkAnatomy.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : '.smoke/sharkview.png';
const SPECIES = opt('--species', 'megalodon,greatWhite').split(',');
const TEX = +opt('--tex', 1024);
const S = +opt('--size', 360);
const CLAY = args.includes('--clay');
const ALL_VIEWS = [
  // [a, b, h, back, lh]
  [8, 0, 0.8, 2, 0],
  [5.7, 5.7, 1.2, 3, 0],
  [6.4, 6.4, -4, 3, 0],
  [3.5, 1.2, -7, 1.5, 0],
  [-4.8, 6.5, 0.2, 5, -1],
  [-7, 20, 1, 7, 0],
  [-2, 11, 0, 2, 0],
];
const VIEWS = opt('--views', '0,1,2,3,4,5').split(',').map((i) => ALL_VIEWS[+i]);
const SW = Math.round((S * 16) / 9);
const W = SW * VIEWS.length;
const H = S * SPECIES.length;
const FOV = +opt('--fov', 55);

const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin2srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const LUT = new Float32Array(256).map((_, i) => srgb2lin(i / 255));
function sampler(tex, lin) {
  const { data, width: w, height: h } = tex.image;
  const at = (x, y, ch) => {
    const v = data[(Math.min(h - 1, Math.max(0, y < 0 ? y + h : y >= h ? y - h : y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + ch];
    return lin ? LUT[v] : v / 255;
  };
  return (u, v, ch) => {
    const x = u * w - 0.5;
    const y = v * h - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    return (at(x0, y0, ch) * (1 - fx) + at(x0 + 1, y0, ch) * fx) * (1 - fy) + (at(x0, y0 + 1, ch) * (1 - fx) + at(x0 + 1, y0 + 1, ch) * fx) * fy;
  };
}

const WATER = [0.012, 0.055, 0.07];
const SUN = new THREE.Vector3(0.25, 0.9, 0.3).normalize();
const img = new Float32Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const k = 1.5 - (y % S) / S;
    for (let ch = 0; ch < 3; ch++) img[(y * W + x) * 3 + ch] = WATER[ch] * k;
  }
}

function buildShark(type) {
  const spec = getSpecies(type);
  let t0 = performance.now();
  const b = buildSharkGeometry(spec, 'high');
  const tGeo = performance.now() - t0;
  t0 = performance.now();
  const tex = {};
  const gen = paintSkin(b.anatomy, spec, TEX, tex, 1);
  while (!gen.next().done);
  console.log(`${type}: geometry ${tGeo.toFixed(0)} ms, ${b.geometry.index.count / 3} tris; skin ${TEX} ${(performance.now() - t0).toFixed(0)} ms`);
  const g = b.geometry;
  const meshes = [];
  const skinEnd = g.groups[0].count;
  meshes.push({ p: g.attributes.position.array, n: g.attributes.normal.array, uv: g.attributes.uv.array, col: g.attributes.color.array, idx: g.index.array.subarray(0, skinEnd), kind: 'skin' });
  meshes.push({ p: g.attributes.position.array, n: g.attributes.normal.array, uv: g.attributes.uv.array, col: g.attributes.color.array, idx: g.index.array.subarray(skinEnd), kind: 'mouth' });
  // Rest-pose teeth (instance matrix relative to their jaw bone's rest position).
  const tg = b.teeth.geometry;
  const tp = tg.attributes.position.array;
  const tn = tg.attributes.normal.array;
  const ti = tg.index.array;
  const v = new THREE.Vector3();
  const m3 = new THREE.Matrix3();
  for (const [list, bone] of [[b.teeth.upper, BONE.upperJaw], [b.teeth.lower, BONE.jaw]]) {
    const pos = [];
    const nrm = [];
    const idx = [];
    for (const m of list) {
      const mm = m.clone().premultiply(new THREE.Matrix4().makeTranslation(b.restWorld[bone]));
      m3.getNormalMatrix(mm);
      const base = pos.length / 3;
      for (let i = 0; i < tp.length; i += 3) {
        v.fromArray(tp, i).applyMatrix4(mm);
        pos.push(v.x, v.y, v.z);
        v.fromArray(tn, i).applyMatrix3(m3).normalize();
        nrm.push(v.x, v.y, v.z);
      }
      for (const k of ti) idx.push(base + k);
    }
    meshes.push({ p: new Float32Array(pos), n: new Float32Array(nrm), uv: null, col: null, idx, kind: 'teeth' });
  }
  // Eyes: dark glossy spheres at the rest-pose eye centres (head-bone space).
  const eg = new THREE.SphereGeometry(b.eyeRadius, 16, 12);
  for (const e of b.eyes) {
    const c = e.position.clone().add(b.restWorld[BONE.head]);
    const ep = eg.attributes.position.array.slice();
    for (let i = 0; i < ep.length; i += 3) {
      ep[i] += c.x;
      ep[i + 1] += c.y;
      ep[i + 2] += c.z;
    }
    meshes.push({ p: ep, n: eg.attributes.normal.array, uv: null, col: null, idx: eg.index.array, kind: 'eye' });
  }
  const mouth = b.points.grab.clone().add(b.restWorld[BONE.head]);
  return {
    spec,
    meshes,
    mouth,
    L: spec.length,
    map: sampler(tex.map, true),
    nrm: sampler(tex.normalMap, false),
    orm: sampler(tex.ormMap, false),
  };
}

function render(sh, vi, row) {
  const [a, b, h, back, lh] = VIEWS[vi].map((x) => (x * sh.L) / 16);
  const F = new THREE.Vector3(0, 0, 1);
  const R = new THREE.Vector3(1, 0, 0);
  const U = new THREE.Vector3(0, 1, 0);
  const cam = sh.mouth.clone().addScaledVector(F, a).addScaledVector(R, b).addScaledVector(U, h);
  const target = sh.mouth.clone().addScaledVector(F, -back).addScaledVector(U, lh);
  const fwd = target.clone().sub(cam).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, U).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const f = S / 2 / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  const ox = vi * SW;
  const oy = row * S;
  const zbuf = new Float32Array(SW * S).fill(Infinity);
  const d = new THREE.Vector3();
  for (const { p, n, uv, col, idx, kind } of sh.meshes) {
    const sp = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      d.set(p[i] - cam.x, p[i + 1] - cam.y, p[i + 2] - cam.z);
      const z = d.dot(fwd);
      sp[i] = (d.dot(right) / z) * f + SW / 2;
      sp[i + 1] = S / 2 - (d.dot(up) / z) * f;
      sp[i + 2] = z;
    }
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t];
      const i1 = idx[t + 1];
      const i2 = idx[t + 2];
      const z0 = sp[i0 * 3 + 2];
      const z1 = sp[i1 * 3 + 2];
      const z2 = sp[i2 * 3 + 2];
      if (z0 < 0.05 || z1 < 0.05 || z2 < 0.05) continue;
      const x0 = sp[i0 * 3];
      const y0 = sp[i0 * 3 + 1];
      const x1 = sp[i1 * 3];
      const y1 = sp[i1 * 3 + 1];
      const x2 = sp[i2 * 3];
      const y2 = sp[i2 * 3 + 1];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;
      // Tangent frame for the normal map (u along the body, v around it).
      let Tu = null;
      let Tv = null;
      if (uv && kind === 'skin' && !CLAY) {
        const du1 = uv[i1 * 2] - uv[i0 * 2];
        const dv1 = uv[i1 * 2 + 1] - uv[i0 * 2 + 1];
        const du2 = uv[i2 * 2] - uv[i0 * 2];
        const dv2 = uv[i2 * 2 + 1] - uv[i0 * 2 + 1];
        const det = du1 * dv2 - du2 * dv1;
        if (Math.abs(det) > 1e-12 && Math.abs(dv1) < 0.5 && Math.abs(dv2) < 0.5) {
          const e1 = [0, 1, 2].map((k) => p[i1 * 3 + k] - p[i0 * 3 + k]);
          const e2 = [0, 1, 2].map((k) => p[i2 * 3 + k] - p[i0 * 3 + k]);
          Tu = [0, 1, 2].map((k) => (e1[k] * dv2 - e2[k] * dv1) / det);
          Tv = [0, 1, 2].map((k) => (e2[k] * du1 - e1[k] * du2) / det);
        }
      }
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(SW - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1, y2)));
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5;
          const cy = py + 0.5;
          const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
          const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = 1 / (w0 / z0 + w1 / z1 + w2 / z2);
          const zi = py * SW + px;
          if (z >= zbuf[zi]) continue;
          zbuf[zi] = z;
          const q0 = (w0 / z0) * z;
          const q1 = (w1 / z1) * z;
          const q2 = (w2 / z2) * z;
          const L3 = (A, k) => A[i0 * 3 + k] * q0 + A[i1 * 3 + k] * q1 + A[i2 * 3 + k] * q2;
          let N = [L3(n, 0), L3(n, 1), L3(n, 2)];
          const P = [L3(p, 0), L3(p, 1), L3(p, 2)];
          let albedo = [0.45, 0.46, 0.47];
          let rough = 0.5;
          let ao = 1;
          if (kind === 'teeth') {
            albedo = [0.78, 0.75, 0.66];
            rough = 0.38;
          } else if (kind === 'eye') {
            albedo = [0.01, 0.01, 0.012];
            rough = 0.08;
          } else if (kind === 'mouth') {
            albedo = [L3(col, 0), L3(col, 1), L3(col, 2)];
            rough = 0.7;
            ao = 0.6;
          } else if (!CLAY) {
            const u = uv[i0 * 2] * q0 + uv[i1 * 2] * q1 + uv[i2 * 2] * q2;
            const v = uv[i0 * 2 + 1] * q0 + uv[i1 * 2 + 1] * q1 + uv[i2 * 2 + 1] * q2;
            albedo = [0, 1, 2].map((ch) => sh.map(u, v, ch) * L3(col, ch));
            ao = sh.orm(u, v, 0);
            rough = sh.orm(u, v, 1);
            if (Tu) {
              const nl0 = Math.hypot(...N);
              const Nn = N.map((x) => x / nl0);
              const t = Tu.map((x, k) => x - Nn[k] * (Tu[0] * Nn[0] + Tu[1] * Nn[1] + Tu[2] * Nn[2]));
              const tl = Math.hypot(...t) || 1;
              const bb = Tv.map((x, k) => x - Nn[k] * (Tv[0] * Nn[0] + Tv[1] * Nn[1] + Tv[2] * Nn[2]));
              const bl = Math.hypot(...bb) || 1;
              const mx = sh.nrm(u, v, 0) * 2 - 1;
              const my = sh.nrm(u, v, 1) * 2 - 1;
              const mz = sh.nrm(u, v, 2) * 2 - 1;
              N = [0, 1, 2].map((k) => (t[k] / tl) * mx + (bb[k] / bl) * my + Nn[k] * mz);
            }
          }
          const V = [cam.x - P[0], cam.y - P[1], cam.z - P[2]];
          const vl = Math.hypot(...V);
          const nl = Math.hypot(...N) || 1;
          N = N.map((x) => x / nl);
          const Vn = V.map((x) => x / vl);
          if (N[0] * Vn[0] + N[1] * Vn[1] + N[2] * Vn[2] < 0) N = N.map((x) => -x);
          const ndl = Math.max(0, N[0] * SUN.x + N[1] * SUN.y + N[2] * SUN.z);
          const hemi = 0.5 + 0.5 * N[1];
          const Hh = [SUN.x + Vn[0], SUN.y + Vn[1], SUN.z + Vn[2]];
          const hl = Math.hypot(...Hh);
          const ndh = Math.max(0, (N[0] * Hh[0] + N[1] * Hh[1] + N[2] * Hh[2]) / hl);
          const shin = Math.min(400, 2 / Math.max(0.02, rough ** 4) - 2);
          const spec = CLAY ? 0 : 0.04 * ((shin + 8) / 8) * Math.pow(ndh, shin) * ndl;
          const fog = 1 - Math.exp(-vl / 45);
          const o = ((oy + py) * W + ox + px) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const sky = [0.16, 0.34, 0.38][ch];
            const gnd = [0.025, 0.06, 0.07][ch];
            const sun = [0.95, 1.0, 0.95][ch];
            const lit = albedo[ch] * (ndl * sun * 0.9 + (gnd + (sky - gnd) * hemi) * ao * 1.6) + spec * sun;
            img[o + ch] = lit * (1 - fog) + WATER[ch] * 1.1 * fog;
          }
        }
      }
    }
  }
}

SPECIES.forEach((type, row) => {
  const sh = buildShark(type);
  const t0 = performance.now();
  for (let vi = 0; vi < VIEWS.length; vi++) render(sh, vi, row);
  console.log(`${type}: ${VIEWS.length} views ${(performance.now() - t0).toFixed(0)} ms`);
});

// tone map, sRGB, PNG (8-bit RGB, no filter)
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) {
      const c = img[(y * W + x) * 3 + ch] * 1.6;
      raw[y * (W * 3 + 1) + 1 + x * 3 + ch] = Math.round(THREE.MathUtils.clamp(lin2srgb(c / (1 + c * 0.5)), 0, 1) * 255);
    }
  }
}
const CRC = new Int32Array(256).map((_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc = (b) => {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const td = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${OUT} (${W}x${H})`);
