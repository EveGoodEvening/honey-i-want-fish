// Browser-free preview of the ambient school fish (Node, no WebGL — no gate needed):
// software-rasterises each species' shape exactly as FishSchools draws it (the per-species
// vertex data of src/world/ambient/fishGeometry.js on the shared topology, the painted pattern
// atlas, fin colours, metalness and the fry's see-through body) under a rough underwater light:
// sun from above, blue-green hemisphere fill, a bright-up / dark-down reflection for the
// metallic flanks. Not the game's look — use it to judge silhouettes and markings in seconds.
//
//   node scripts/fish-view.mjs [out.png] [--species sardine,scad,jack,fry] [--views 0,1,2,3]
//        [--size 260] [--low] [--clay] [--scale]
//
// One row per species, one column per view (camera distances in fish lengths):
//   0 side (right flank) · 1 top-down · 2 three-quarter front, from above ·
//   3 three-quarter rear, from below · 4 head-on
// --low uses the low-quality ring counts; --clay drops colours (shape only); --scale draws
// every species at its in-game length relative to the jack (else each fills its cell).
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { buildFishSpecies, paintFishPatterns, FISH_SPECIES } from '../src/world/ambient/fishGeometry.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : '.smoke/fishview.png';
const SPECIES = opt('--species', FISH_SPECIES.join(',')).split(',');
const S = +opt('--size', 260);
const CLAY = args.includes('--clay');
const SCALE = args.includes('--scale');
const LENGTH = { sardine: 0.22, scad: 0.34, jack: 0.62, fry: 0.13 }; // FishSchools SPECIES lengths
const ALL_VIEWS = [
  // camera direction (from the fish), up hint
  [[1, 0, 0], [0, 1, 0]],
  [[0, 1, 0.0001], [-1, 0, 0]],
  [[0.75, 0.45, 0.75], [0, 1, 0]],
  [[0.8, -0.5, -0.7], [0, 1, 0]],
  [[0.0001, 0.05, 1], [0, 1, 0]],
];
const VIEWS = opt('--views', '0,1,2,3').split(',').map((i) => ALL_VIEWS[+i]);
const SW = Math.round(S * 1.5);
const W = SW * VIEWS.length;
const H = S * SPECIES.length;

const built = buildFishSpecies(args.includes('--low') ? { rings: 9, radial: 7 } : {});
const atlas = paintFishPatterns();
console.log(`${built.vertexCount} verts, ${built.triangles} tris per fish (shared topology)`);

const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin2srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const LUT = new Float32Array(256).map((_, i) => srgb2lin(i / 255));
function sample(u, v, ch) {
  const { data, width: w, height: h } = atlas;
  const x = u * w - 0.5;
  const y = v * h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx, yy) => {
    const o = (Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))) * 4 + ch;
    return ch < 3 ? LUT[data[o]] : data[o] / 255;
  };
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
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

function render(name, vi, row) {
  const sp = built.species[name];
  const idx = built.index;
  const n = built.vertexCount;
  const [dir, upHint] = VIEWS[vi];
  const scale = SCALE ? LENGTH[name] / LENGTH.jack : 1;
  const fwd = new THREE.Vector3(...dir).normalize().negate();
  const cam = fwd.clone().multiplyScalar(-1.6);
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(...upHint)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const f = (S * 0.5) / Math.tan(THREE.MathUtils.degToRad(16));
  const ox = vi * SW;
  const oy = row * S;
  const zbuf = new Float32Array(SW * S).fill(Infinity);
  const scr = new Float32Array(n * 3);
  const d = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    d.set(sp.pos[k * 4] * scale - cam.x, sp.pos[k * 4 + 1] * scale - cam.y, sp.pos[k * 4 + 2] * scale - cam.z);
    const z = d.dot(fwd);
    scr[k * 3] = (d.dot(right) / z) * f + SW / 2;
    scr[k * 3 + 1] = S / 2 - (d.dot(up) / z) * f;
    scr[k * 3 + 2] = z;
  }
  const A4 = (arr, q, c) => arr[idx[q[0]] * 4 + c] * q[3] + arr[idx[q[1]] * 4 + c] * q[4] + arr[idx[q[2]] * 4 + c] * q[5];
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t];
    const i1 = idx[t + 1];
    const i2 = idx[t + 2];
    const x0 = scr[i0 * 3];
    const y0 = scr[i0 * 3 + 1];
    const z0 = scr[i0 * 3 + 2];
    const x1 = scr[i1 * 3];
    const y1 = scr[i1 * 3 + 1];
    const z1 = scr[i1 * 3 + 2];
    const x2 = scr[i2 * 3];
    const y2 = scr[i2 * 3 + 1];
    const z2 = scr[i2 * 3 + 2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(SW - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1, y2)));
    const q = [t, t + 1, t + 2, 0, 0, 0];
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
        q[3] = (w0 / z0) * z;
        q[4] = (w1 / z1) * z;
        q[5] = (w2 / z2) * z;
        let N = [A4(sp.nrm, q, 0), A4(sp.nrm, q, 1), A4(sp.nrm, q, 2)];
        const body = A4(sp.pos, q, 3) > 0.5;
        let albedo = [0.5, 0.5, 0.5];
        let metal = 0;
        let trans = 0;
        if (!CLAY) {
          const u = A4(sp.aux, q, 0);
          const v = A4(sp.aux, q, 1);
          const pat = body ? [sample(u, v, 0), sample(u, v, 1), sample(u, v, 2), sample(u, v, 3)] : [1, 1, 1, 1];
          albedo = [0, 1, 2].map((c) => A4(sp.col, q, c) * pat[c]);
          metal = 0.6 * A4(sp.col, q, 3) * (body ? pat[3] : 1);
          trans = A4(sp.aux, q, 2) * (body ? 1 - pat[3] : 1);
        }
        const nl = Math.hypot(...N) || 1;
        N = N.map((x) => x / nl);
        // world position (scaled) → view vector
        const P = [0, 1, 2].map((c) => A4(sp.pos, q, c) * scale);
        const V = [cam.x - P[0], cam.y - P[1], cam.z - P[2]];
        const vl = Math.hypot(...V);
        const Vn = V.map((x) => x / vl);
        let ndv = N[0] * Vn[0] + N[1] * Vn[1] + N[2] * Vn[2];
        if (ndv < 0) {
          N = N.map((x) => -x);
          ndv = -ndv;
        }
        const ndl = Math.max(0, N[0] * SUN.x + N[1] * SUN.y + N[2] * SUN.z);
        const hemi = 0.5 + 0.5 * N[1];
        // reflection: bright above (Snell's window), dark below
        const Ry = 2 * ndv * N[1] - Vn[1];
        const env = 0.08 + 1.1 * Math.max(0, Ry) ** 2;
        const fres = 0.04 + 0.96 * (1 - ndv) ** 5;
        const o = ((oy + py) * W + ox + px) * 3;
        for (let ch = 0; ch < 3; ch++) {
          const sky = [0.16, 0.34, 0.38][ch];
          const gnd = [0.025, 0.06, 0.07][ch];
          const sun = [0.95, 1.0, 0.95][ch];
          const a = albedo[ch];
          const F0 = 0.04 * (1 - metal) + a * metal;
          const F = F0 + (1 - F0) * fres * (1 - metal * 0.7);
          const diffuse = a * (1 - metal) * (ndl * sun * 0.9 + (gnd + (sky - gnd) * hemi) * 1.6);
          const lit = diffuse + F * env * [0.5, 0.8, 0.85][ch];
          img[o + ch] = lit * (1 - trans) + WATER[ch] * 1.3 * trans;
        }
      }
    }
  }
}

SPECIES.forEach((name, row) => {
  for (let vi = 0; vi < VIEWS.length; vi++) render(name, vi, row);
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
