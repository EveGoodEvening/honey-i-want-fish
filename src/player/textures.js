// Procedural textures for the player: woven fabric (normal + albedo/roughness
// variation), wood grain, brushed steel, and a tiny HDR underwater environment
// used for the knife's reflections. Generated once at start-up.
import * as THREE from 'three';
import { pfbm2, pnoise2, clamp, saturate } from './math.js';

function dataTexture(data, size, { srgb = false, repeat = 1 } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  return tex;
}

/** Converts a tileable height field into a tangent-space normal map. */
function heightToNormal(height, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size;
    const yp = ((y + 1) % size) * size;
    const yc = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = (height[yc + xp] - height[yc + xm]) * strength;
      const dy = (height[yp + x] - height[ym + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (yc + x) * 4;
      out[i] = (-dx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Woven cloth. `threads` threads across the tile; kind 'twill' (work jacket,
 * trousers) or 'jersey' (knit shirt). Returns { normalMap, map, roughnessMap }.
 * The albedo is a near-white modulation (the material colour tints it):
 * thread-level jitter, faded/worn patches and grime.
 */
export function makeFabric(size, opts) {
  const gen = paintFabric(size, opts);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/** Generator version of makeFabric: yields every few rows (idle-time painting). */
export function* paintFabric(size, { threads = 64, kind = 'twill', seed = 1, wear = 0.5, strength = 2.2 } = {}) {
  const ROWS_PER_SLICE = Math.max(1, Math.round(4096 / size));
  const height = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const cell = size / threads;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const gx = x / cell;
      const gy = y / cell;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const fx = gx - ix;
      const fy = gy - iy;
      let h;
      if (kind === 'twill') {
        // 2/2 twill: which thread is on top shifts by one every row → diagonal ribs.
        const warpUp = ((ix + iy) & 3) < 2;
        const slubW = pnoise2(gx * 0.25, iy, threads / 4, threads, seed) * 0.15;
        const slubF = pnoise2(ix, gy * 0.25, threads, threads / 4, seed + 3) * 0.15;
        const warp = Math.sin(Math.PI * fx) * (0.85 + slubW);
        const weft = Math.sin(Math.PI * fy) * (0.85 + slubF);
        h = warpUp ? 0.55 + 0.45 * warp - 0.1 * (1 - weft) : 0.55 + 0.45 * weft - 0.1 * (1 - warp);
      } else {
        // jersey knit: rows of little V loops
        const row = fy;
        const loop = Math.abs(fx - 0.5) * 2;
        const vshape = Math.sin(Math.PI * saturate(1 - Math.abs(loop - (1 - row) * 0.8) * 1.6));
        h = 0.4 + 0.6 * vshape * (0.85 + 0.15 * pnoise2(gx, gy, threads, threads, seed));
      }
      // fibre fuzz
      h += pfbm2(u, v, threads * 2, 2, seed + 11) * 0.12;
      const i = y * size + x;
      height[i] = h;

      // albedo: thread jitter + worn/faded patches + grime
      const jitter = pnoise2(ix, iy, threads, threads, seed + 5) * 0.035;
      const fade = pfbm2(u, v, 3, 4, seed + 21);
      const grime = pfbm2(u, v, 6, 3, seed + 33);
      let a = 0.86 + jitter + h * 0.12;
      a += saturate(fade * 1.6) * 0.16 * wear; // faded lighter patches
      a -= saturate(-grime * 1.8) * 0.12 * wear; // darker grime
      const c = clamp(a, 0, 1) * 255;
      albedo[i * 4] = c;
      albedo[i * 4 + 1] = c;
      albedo[i * 4 + 2] = clamp(a * 1.01, 0, 1) * 255;
      albedo[i * 4 + 3] = 255;

      const r = clamp(0.84 + (1 - h) * 0.1 - saturate(-grime) * 0.12 * wear + fade * 0.04, 0, 1) * 255;
      rough[i * 4] = r;
      rough[i * 4 + 1] = r; // three reads roughness from G
      rough[i * 4 + 2] = r;
      rough[i * 4 + 3] = 255;
    }
    if ((y + 1) % ROWS_PER_SLICE === 0) yield;
  }
  yield;
  return {
    normalMap: dataTexture(heightToNormal(height, size, strength), size),
    map: dataTexture(albedo, size, { srgb: true }),
    roughnessMap: dataTexture(rough, size),
  };
}

/** Dark, oiled wood grain for the knife handle (u along the handle). */
export function makeWood(size) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const warp = pfbm2(u, v, 2, 3, 41) * 0.25;
      const rings = Math.sin((v + warp) * 70 + pfbm2(u, v, 4, 2, 43) * 6);
      const fine = pnoise2(u * 4, v * 128, 4, 128, 47);
      const g = 0.5 + 0.5 * rings;
      const base = 0.2 + g * 0.1 + fine * 0.05;
      const wear = saturate(pfbm2(u, v, 3, 3, 53) * 2) * 0.08;
      const i = (y * size + x) * 4;
      data[i] = clamp(base * 1.55 + wear, 0, 1) * 255;
      data[i + 1] = clamp(base * 0.98 + wear * 0.8, 0, 1) * 255;
      data[i + 2] = clamp(base * 0.62 + wear * 0.6, 0, 1) * 255;
      data[i + 3] = 255;
    }
  }
  return dataTexture(data, size, { srgb: true });
}

/** Brushed-steel roughness variation (streaks along u) for the blade. */
export function makeBrushed(size) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const streak = pnoise2(u * 2, v * 96, 2, 96, 61) * 0.5 + pnoise2(u * 4, v * 192, 4, 192, 62) * 0.3;
      const smudge = pfbm2(u, v, 4, 3, 67);
      const r = clamp(0.2 + streak * 0.07 + saturate(smudge) * 0.18, 0.05, 1) * 255;
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = r;
      data[i + 2] = r;
      data[i + 3] = 255;
    }
  }
  return dataTexture(data, size);
}

/**
 * A small HDR equirect "underwater sky": bright Snell's window overhead,
 * teal water column around the horizon, near-black below; prefiltered with
 * PMREM so metal (the knife) has something to reflect and glint with.
 */
export function makeUnderwaterEnvMap(renderer) {
  const w = 128;
  const h = 64;
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    // DataTexture row 0 is the bottom (v = 0 → direction down)
    const elev = (y / (h - 1) - 0.5) * Math.PI; // -π/2 .. π/2
    const s = Math.sin(elev);
    for (let x = 0; x < w; x++) {
      const az = (x / w) * Math.PI * 2;
      let r;
      let g;
      let b;
      if (s > 0) {
        const window = Math.pow(saturate((s - 0.66) / 0.34), 1.5); // Snell's window (~48°)
        const sun = Math.pow(saturate((s - 0.9) / 0.1), 6) * (0.7 + 0.3 * Math.cos(az * 3));
        r = 0.05 + window * 2.2 + sun * 8;
        g = 0.2 + s * 0.25 + window * 3.2 + sun * 9;
        b = 0.26 + s * 0.3 + window * 3.4 + sun * 9;
      } else {
        const d = 1 + s; // 1 at horizon → 0 straight down
        r = 0.01 + 0.03 * d * d;
        g = 0.03 + 0.15 * d * d;
        b = 0.05 + 0.2 * d * d;
      }
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    tex.dispose();
    return rt.texture;
  } catch (err) {
    console.warn('[Player] PMREM env map unavailable, using raw equirect', err);
    return tex;
  }
}
