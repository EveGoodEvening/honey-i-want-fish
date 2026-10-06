// Browser-free preview of 老公's head (Node, no WebGL — no gate needed): software-rasterises the
// real head + eye geometry from src/player/head.js (plus the neck as PlayerModel lofts it) with
// the painted map / bump / AO textures, and an untextured clay row to judge the sculpt alone.
// Neutral studio light (key from above-front, sky/ground fill), not the underwater look — use it
// to iterate on the shape in seconds, then judge the result in game (close-ups through the gate).
//
//   node scripts/player-headview.mjs [out.png] [--q high|medium|low] [--tex 512] [--size 300]
//        [--views 0,1,2,3,4] [--module <path to a head.js variant, relative to this file>]
//
// Views: 0 front, 1 three-quarter, 2 profile, 3 low three-quarter, 4 follow-camera distance.
// Also prints the head geometry / texture build times (compare variants with --module).
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { buildLoft, pathRings } from '../src/player/loft.js';
import { gauss } from '../src/player/math.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = args[0] && !args[0].startsWith('--') ? args[0] : '.smoke/player-head.png';
const Q = opt('--q', 'high');
const TEX = +opt('--tex', 512);
const S = +opt('--size', 300);
const head = await import(opt('--module', '../src/player/head.js'));

let t0 = performance.now();
const geo = head.buildHeadGeometry(Q);
const tGeo = performance.now() - t0;
t0 = performance.now();
const tex = head.makeHeadTextures(TEX);
const tTex = performance.now() - t0;
console.log(`head geometry (${Q}) ${tGeo.toFixed(1)} ms, ${geo.attributes.position.count} verts; textures ${TEX} ${tTex.toFixed(1)} ms`);

const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin2srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** Bilinear, wrapping in u, sampler over a DataTexture's RGBA bytes → [0, 1]. */
function sampler(t) {
  const { data, width: w, height: h } = t.image;
  const g = (x, y) => (ch) => data[(Math.min(h - 1, Math.max(0, y)) * w + (((x % w) + w) % w)) * 4 + ch] / 255;
  return (u, v, ch) => {
    const x = u * w - 0.5;
    const y = v * h - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    return (g(x0, y0)(ch) * (1 - fx) + g(x0 + 1, y0)(ch) * fx) * (1 - fy) + (g(x0, y0 + 1)(ch) * (1 - fx) + g(x0 + 1, y0 + 1)(ch) * fx) * fy;
  };
}
const sMap = sampler(tex.map);
const sBump = sampler(tex.bumpMap);
const sRgh = sampler(tex.roughnessMap); // R = cavity AO, G = roughness
const sEye = sampler(head.makeEyeTexture());
const TW = tex.map.image.width;
const TH = tex.map.image.height;

const meshData = (g, kind) => ({ p: g.attributes.position.array, n: g.attributes.normal.array, uv: g.attributes.uv.array, idx: g.index.array, kind });
// the neck as PlayerModel._skinGeometry lofts it (bind pose), moved into head-local space
const O = new THREE.Vector3(0, 1.637, 0.006);
const neckPts = [[0, 1.4, -0.03], [0, 1.48, -0.022], [0, 1.55, -0.014], [0, 1.625, -0.004]].map((p) => new THREE.Vector3(...p).sub(O));
const neckProf = [
  { rx: 0.064, rzf: 0.058, rzb: 0.066 },
  { rx: 0.06, rzf: 0.056, rzb: 0.064 },
  { rx: 0.057, rzf: 0.054, rzb: 0.062 },
  { rx: 0.058, rzf: 0.05, rzb: 0.062 },
];
const neckGeo = buildLoft({
  rings: pathRings(neckPts, neckProf, new THREE.Vector3(0, 0, 1), 14),
  seg: 52,
  bump: (i, th, r) => 0.0055 * gauss(th, 0, 0.16) * gauss(r.c.y + O.y, 1.5, 0.014) + 0.003 * gauss(Math.abs(th), 0.75, 0.22) * gauss(r.c.y + O.y, 1.5, 0.05),
  uv: () => [0.5, 0.3],
});
const MESHES = [meshData(geo, 'head'), meshData(head.buildEyesGeometry(), 'eye'), meshData(neckGeo, 'neck')];
const NECK_ALBEDO = [0.54, 0.38, 0.295].map(srgb2lin); // PlayerModel skinColor

// [yaw° (+ = toward the character's left, +X), pitch° (+ = from above), distance m, fov°]
const ALL_VIEWS = [
  [0, 4, 0.75, 26],
  [38, 6, 0.75, 26],
  [88, 2, 0.75, 26],
  [-30, -12, 0.75, 26],
  [14, 16, 1.6, 40],
];
const VIEWS = opt('--views', '0,1,2,3,4').split(',').map((i) => ALL_VIEWS[+i]);
const W = S * VIEWS.length;
const H = S * 2;
const img = new Float32Array(W * H * 3);
for (let i = 0; i < W * H; i++) img.set([0.03, 0.12, 0.15], i * 3);
const key = new THREE.Vector3(0.55, 0.75, 0.6).normalize();
const cross = (A, B) => [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];

function render(vi, clay) {
  const [yawD, pitchD, dist, fov] = VIEWS[vi];
  const yaw = THREE.MathUtils.degToRad(yawD);
  const pitch = THREE.MathUtils.degToRad(pitchD);
  const target = new THREE.Vector3(0, -0.02, 0.025);
  const cam = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist).add(target);
  const fwd = target.clone().sub(cam).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const f = (S / 2) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  const ox = vi * S;
  const oy = clay ? S : 0;
  const zbuf = new Float32Array(S * S).fill(Infinity);
  const d = new THREE.Vector3();
  for (const { p, n, uv, idx, kind } of MESHES) {
    const sp = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      d.set(p[i] - cam.x, p[i + 1] - cam.y, p[i + 2] - cam.z);
      const z = d.dot(fwd);
      sp[i] = (d.dot(right) / z) * f + S / 2;
      sp[i + 1] = S / 2 - (d.dot(up) / z) * f;
      sp[i + 2] = z;
    }
    for (let t = 0; t < idx.length; t += 3) {
      const [i0, i1, i2] = [idx[t], idx[t + 1], idx[t + 2]];
      const [x0, y0, z0] = [sp[i0 * 3], sp[i0 * 3 + 1], sp[i0 * 3 + 2]];
      const [x1, y1, z1] = [sp[i1 * 3], sp[i1 * 3 + 1], sp[i1 * 3 + 2]];
      const [x2, y2, z2] = [sp[i2 * 3], sp[i2 * 3 + 1], sp[i2 * 3 + 2]];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;
      // per-triangle dP/du, dP/dv for the bump (skipped across the u seam)
      const du1 = uv[i1 * 2] - uv[i0 * 2];
      const dv1 = uv[i1 * 2 + 1] - uv[i0 * 2 + 1];
      const du2 = uv[i2 * 2] - uv[i0 * 2];
      const dv2 = uv[i2 * 2 + 1] - uv[i0 * 2 + 1];
      const det = du1 * dv2 - du2 * dv1;
      let Tu = null;
      let Tv = null;
      if (kind === 'head' && !clay && Math.abs(det) > 1e-12 && Math.abs(du1) < 0.5 && Math.abs(du2) < 0.5) {
        const e1 = [0, 1, 2].map((k) => p[i1 * 3 + k] - p[i0 * 3 + k]);
        const e2 = [0, 1, 2].map((k) => p[i2 * 3 + k] - p[i0 * 3 + k]);
        Tu = [0, 1, 2].map((k) => (e1[k] * dv2 - e2[k] * dv1) / det);
        Tv = [0, 1, 2].map((k) => (e2[k] * du1 - e1[k] * du2) / det);
      }
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(S - 1, Math.ceil(Math.max(x0, x1, x2)));
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
          const z = 1 / (w0 / z0 + w1 / z1 + w2 / z2); // perspective-correct
          const zi = py * S + px;
          if (z >= zbuf[zi]) continue;
          zbuf[zi] = z;
          const q = [(w0 / z0) * z, (w1 / z1) * z, (w2 / z2) * z];
          const lerp3 = (a, k) => a[i0 * 3 + k] * q[0] + a[i1 * 3 + k] * q[1] + a[i2 * 3 + k] * q[2];
          let N = [lerp3(n, 0), lerp3(n, 1), lerp3(n, 2)];
          const u = uv[i0 * 2] * q[0] + uv[i1 * 2] * q[1] + uv[i2 * 2] * q[2];
          const v = uv[i0 * 2 + 1] * q[0] + uv[i1 * 2 + 1] * q[1] + uv[i2 * 2 + 1] * q[2];
          const V = [cam.x - lerp3(p, 0), cam.y - lerp3(p, 1), cam.z - lerp3(p, 2)];
          let albedo = [0.42, 0.42, 0.42];
          let rough = 0.55;
          let ao = 1;
          if (kind === 'neck' && !clay) albedo = NECK_ALBEDO;
          else if (kind === 'eye') {
            albedo = [0, 1, 2].map((ch) => srgb2lin(sEye(u, v, ch)));
            rough = 0.15;
          } else if (kind === 'head' && !clay) {
            albedo = [0, 1, 2].map((ch) => srgb2lin(sMap(u, v, ch)));
            rough = sRgh(u, v, 1);
            ao = sRgh(u, v, 0);
            if (Tu) {
              // surface gradient of a ≈0.6 mm relief: ∇H = (Hu (Tv × N) + Hv (N × Tu)) / (N · (Tu × Tv))
              const hu = (sBump(u + 1 / TW, v, 0) - sBump(u - 1 / TW, v, 0)) * (TW / 2);
              const hv = (sBump(u, v + 1 / TH, 0) - sBump(u, v - 1 / TH, 0)) * (TH / 2);
              const a = cross(Tv, N);
              const b = cross(N, Tu);
              const c = cross(Tu, Tv);
              const dd = N[0] * c[0] + N[1] * c[1] + N[2] * c[2];
              if (Math.abs(dd) > 1e-12) N = N.map((x, k) => x - (0.0006 * (hu * a[k] + hv * b[k])) / dd);
            }
          }
          const nl = Math.hypot(...N);
          const vl = Math.hypot(...V);
          N = N.map((x) => x / nl);
          const Vn = V.map((x) => x / vl);
          if (N[0] * Vn[0] + N[1] * Vn[1] + N[2] * Vn[2] < 0) N = N.map((x) => -x);
          const ndl = Math.max(0, N[0] * key.x + N[1] * key.y + N[2] * key.z);
          const amb = (0.12 + 0.28 * (0.5 + 0.5 * N[1])) * ao;
          const Hh = [key.x + Vn[0], key.y + Vn[1], key.z + Vn[2]];
          const hl = Math.hypot(...Hh);
          const ndh = Math.max(0, (N[0] * Hh[0] + N[1] * Hh[1] + N[2] * Hh[2]) / hl);
          const shin = Math.min(400, 2 / Math.max(0.02, rough ** 4) - 2);
          const spec = clay ? 0 : 0.04 * ((shin + 8) / 8) * Math.pow(ndh, shin) * ndl;
          const o = ((oy + py) * W + ox + px) * 3;
          for (let ch = 0; ch < 3; ch++) img[o + ch] = albedo[ch] * (ndl * 1.6 + amb) + spec;
        }
      }
    }
  }
}
for (let vi = 0; vi < VIEWS.length; vi++) {
  render(vi, false);
  render(vi, true);
}

// tone map, sRGB, PNG (8-bit RGB, no filter)
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    for (let ch = 0; ch < 3; ch++) {
      const c = img[(y * W + x) * 3 + ch];
      raw[y * (W * 3 + 1) + 1 + x * 3 + ch] = Math.round(THREE.MathUtils.clamp(lin2srgb(c / (1 + c * 0.6)), 0, 1) * 255);
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
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // RGB
writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${OUT} (${W}x${H})`);
