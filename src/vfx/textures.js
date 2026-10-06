// Procedural textures for VFX. Generated once at startup (a few ms).
import * as THREE from 'three';

// Deterministic integer hash -> [0, 1)
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function valueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// fbm with a rotation + offset between octaves: plain value-noise octaves
// share one axis-aligned lattice, which shows up as straight grid-aligned
// edges once a sprite is magnified.
const ROT_C = Math.cos(0.83);
const ROT_S = Math.sin(0.83);
function fbm(x, y, seed, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y, seed + o * 31) * amp;
    norm += amp;
    amp *= 0.5;
    const nx = (x * ROT_C - y * ROT_S) * 2.03 + 17.3;
    y = (x * ROT_S + y * ROT_C) * 2.03 + 5.1;
    x = nx;
  }
  return sum / norm;
}

/** Separable [1 4 6 4 1] blur of a w*h float field, in place (uses tmp). */
function blur5(field, tmp, w, h) {
  const k0 = 6 / 16;
  const k1 = 4 / 16;
  const k2 = 1 / 16;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l1 = field[y * w + Math.max(0, x - 1)];
      const l2 = field[y * w + Math.max(0, x - 2)];
      const r1 = field[y * w + Math.min(w - 1, x + 1)];
      const r2 = field[y * w + Math.min(w - 1, x + 2)];
      tmp[i] = field[i] * k0 + (l1 + r1) * k1 + (l2 + r2) * k2;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u1 = tmp[Math.max(0, y - 1) * w + x];
      const u2 = tmp[Math.max(0, y - 2) * w + x];
      const d1 = tmp[Math.min(h - 1, y + 1) * w + x];
      const d2 = tmp[Math.min(h - 1, y + 2) * w + x];
      field[i] = tmp[i] * k0 + (u1 + d1) * k1 + (u2 + d2) * k2;
    }
  }
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * 2x2 atlas of billowing cloud puffs.
 *   R = density (alpha), G = fine detail used to modulate brightness.
 * Each puff is a cluster of overlapping soft lobes (cauliflower billows),
 * domain-warped and eroded by fbm so the edges curl into wisps. Each tile
 * fades to exactly zero at its border so mip levels never bleed between
 * tiles.
 */
export function createCloudAtlas(size = 512) {
  const tile = size / 2;
  const data = new Uint8Array(size * size * 4);
  const dens = new Float32Array(tile * tile);
  const detail = new Float32Array(tile * tile);
  const tmp = new Float32Array(tile * tile);
  for (let t = 0; t < 4; t++) {
    const ox = (t % 2) * tile;
    const oy = Math.floor(t / 2) * tile;
    const seed = 17 + t * 101;
    // lobes: [x, y, r, weight]
    const lobes = [];
    const nl = 6 + t;
    for (let i = 0; i < nl; i++) {
      const a = hash2(i, 1, seed) * Math.PI * 2;
      const rr = Math.sqrt(hash2(i, 2, seed)) * 0.36;
      lobes.push([Math.cos(a) * rr, Math.sin(a) * rr, 0.4 + hash2(i, 3, seed) * 0.22, 0.5 + hash2(i, 4, seed) * 0.5]);
    }
    // Frequencies are capped so the finest noise cell still spans ~4+ texels;
    // anything finer aliases into texel-sized steps that read as hard edges
    // when a puff is magnified on screen.
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const u = ((x + 0.5) / tile) * 2 - 1;
        const v = ((y + 0.5) / tile) * 2 - 1;
        // domain warp → curling edges
        const wx = (fbm(u * 2.1 + 7.1, v * 2.1 + 1.7, seed + 5, 3) - 0.5) * 0.34;
        const wy = (fbm(u * 2.1 + 3.3, v * 2.1 + 9.2, seed + 9, 3) - 0.5) * 0.34;
        const pu = u + wx;
        const pv = v + wy;
        let L = 0;
        for (let i = 0; i < nl; i++) {
          const lb = lobes[i];
          const dx = (pu - lb[0]) / lb[2];
          const dy = (pv - lb[1]) / lb[2];
          L += Math.exp(-(dx * dx + dy * dy) * 1.4) * lb[3];
        }
        const n = fbm(pu * 3.0 + 11, pv * 3.0 + 4, seed, 4);
        let d = smoothstep(0.02, 2.6, L * 0.62 + (n - 0.5) * 0.95);
        d = Math.min(1, d * 1.15) * (0.62 + 0.5 * n);
        dens[y * tile + x] = d;
        detail[y * tile + x] = fbm(pu * 4.5 + 3, pv * 4.5 + 5, seed + 77, 3);
      }
    }
    // blur width scales with resolution (in texels) so the result is the same
    // smooth field at any atlas size
    const passes = Math.max(1, Math.round(tile / 64));
    for (let k = 0; k < passes + 1; k++) blur5(dens, tmp, tile, tile);
    for (let k = 0; k < passes; k++) blur5(detail, tmp, tile, tile);
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const u = ((x + 0.5) / tile) * 2 - 1;
        const v = ((y + 0.5) / tile) * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        // radial window → exactly zero at the tile border (no mip bleeding)
        const d = Math.min(1, Math.max(0, dens[y * tile + x] * smoothstep(1.0, 0.78, r)));
        const i = ((oy + y) * size + ox + x) * 4;
        data[i] = Math.round(d * 255);
        data[i + 1] = Math.round(Math.min(1, Math.max(0, detail[y * tile + x])) * 255);
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Small tileable noise texture (R,G independent) for streaks/distortion looks. */
export function createNoiseTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // tileable by sampling on a torus-ish wrap (period = 8 lattice cells)
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const a = tileNoise(u, v, 8, 3);
      const b = tileNoise(u + 3.7, v + 1.3, 8, 11);
      data[i] = Math.round(a * 255);
      data[i + 1] = Math.round(b * 255);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function tileNoise(x, y, period, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const p = (n) => ((n % period) + period) % period;
  const a = hash2(p(ix), p(iy), seed);
  const b = hash2(p(ix + 1), p(iy), seed);
  const c = hash2(p(ix), p(iy + 1), seed);
  const d = hash2(p(ix + 1), p(iy + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
