// Procedural, tileable textures generated once at start-up (typed arrays →
// DataTexture). Albedo maps are sRGB; normal/data maps are linear. Normal
// maps store the source height in alpha.
import * as THREE from 'three';
import { pfbm2, pnoise2, mulberry32, hash2, smoothstep } from './noise.js';

function makeTexture(data, size, { srgb = false, anisotropy = 4 } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Mean colour of an RGBA8 DataTexture as a linear THREE.Color (sRGB maps are
 * decoded first), i.e. what its 1×1 mip level holds. Lets far-LOD shaders
 * use a uniform instead of a texture fetch.
 */
export function textureMeanLinear(tex) {
  const data = tex.image.data;
  const srgb = tex.colorSpace === THREE.SRGBColorSpace;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = !srgb ? c : c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
  }
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += lut[data[i]];
    g += lut[data[i + 1]];
    b += lut[data[i + 2]];
  }
  const n = data.length / 4;
  return new THREE.Color().setRGB(r / n, g / n, b / n);
}

/** Height (Float32Array, wraps) → tangent-space normal map RGBA (height in A). */
function heightToNormals(H, size, strength, out) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < H.length; i++) {
    if (H[i] < min) min = H[i];
    if (H[i] > max) max = H[i];
  }
  const range = max - min || 1;
  for (let j = 0; j < size; j++) {
    const jm = ((j - 1 + size) % size) * size;
    const jp = ((j + 1) % size) * size;
    const jr = j * size;
    for (let i = 0; i < size; i++) {
      const im = (i - 1 + size) % size;
      const ip = (i + 1) % size;
      const dx = (H[jr + ip] - H[jr + im]) * strength;
      const dy = (H[jp + i] - H[jm + i]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (jr + i) * 4;
      out[o] = (-dx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = ((H[jr + i] - min) / range) * 255;
    }
  }
  return out;
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Rippled sand: asymmetric wave ripples with bifurcations, grain, shell grit.
 * World tile ≈ 5 m.
 */
export function makeSandTextures(size, anisotropy) {
  const rand = mulberry32(101);
  const H = new Float32Array(size * size);
  const alb = new Uint8Array(size * size * 4);
  const ripples = 11;
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const warp = pfbm2(u, v, 3, 3, 0.5, 1.3);
      const warp2 = pfbm2(u, v, 7, 2, 0.5, 7.7);
      // Crests run roughly along V, wandering with the warp noise.
      const ph = (u + warp * 0.085 + warp2 * 0.012) * ripples;
      const fr = ph - Math.floor(ph);
      // Gentle stoss side, steeper lee side.
      const prof = fr < 0.68 ? smoothstep(0, 1, fr / 0.68) : smoothstep(0, 1, (1 - fr) / 0.32);
      const amp = 0.45 + 0.55 * smoothstep(-0.35, 0.45, pfbm2(u, v, 4, 2, 0.5, 3.1));
      const grainN = pfbm2(u, v, 48, 2, 0.5, 9.2);
      const speck = rand();
      const gritN = pfbm2(u, v, 36, 1, 0.5, 2.2);
      const grit = smoothstep(0.38, 0.5, gritN);
      const h = prof * amp + grainN * 0.1 + (speck - 0.5) * 0.05 + grit * 0.18;
      H[j * size + i] = h;

      // Albedo: pale grey-beige, organic detritus collects in the troughs.
      const trough = 1 - prof;
      let s = 0.92 + grainN * 0.16 + (speck - 0.5) * 0.14 - trough * amp * 0.16;
      let r = 176 * s;
      let g = 168 * s;
      let b = 146 * s;
      // darker detritus flecks
      if (speck > 0.985) {
        r *= 0.55;
        g *= 0.55;
        b *= 0.5;
      }
      // shell grit: brighter, slightly cooler
      r += grit * 30;
      g += grit * 30;
      b += grit * 32;
      const o = (j * size + i) * 4;
      alb[o] = clampByte(r);
      alb[o + 1] = clampByte(g);
      alb[o + 2] = clampByte(b);
      alb[o + 3] = 255;
    }
  }
  const nrm = heightToNormals(H, size, size / 140, new Uint8Array(size * size * 4));
  return {
    albedo: makeTexture(alb, size, { srgb: true, anisotropy }),
    normal: makeTexture(nrm, size, { anisotropy }),
  };
}

/** Weathered rock: lumpy fbm, fractures, faint strata. World tile ≈ 8 m. */
export function makeRockTextures(size, anisotropy) {
  const rand = mulberry32(202);
  const H = new Float32Array(size * size);
  const alb = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const lump = pfbm2(u, v, 4, 6, 0.55, 0.0);
      const fine = pfbm2(u, v, 24, 3, 0.5, 5.5);
      const crackN = Math.abs(pfbm2(u, v, 5, 3, 0.5, 4.4));
      const crack = smoothstep(0.06, 0.0, crackN) * smoothstep(-0.2, 0.3, pfbm2(u, v, 3, 2, 0.5, 17.0));
      const crack2 = smoothstep(0.035, 0.0, Math.abs(pfbm2(u, v, 11, 2, 0.5, 8.8))) * 0.6;
      const strata = Math.sin((v * 9 + lump * 0.6) * Math.PI * 2) * 0.05;
      const pit = smoothstep(0.55, 0.7, pfbm2(u, v, 20, 2, 0.5, 6.1));
      const h = lump * 0.7 + fine * 0.26 - crack * 0.22 - crack2 * 0.1 + strata - pit * 0.15;
      H[j * size + i] = h;

      const speck = rand();
      const tone = 0.86 + lump * 0.25 + fine * 0.18 + (speck - 0.5) * 0.12;
      const warm = pfbm2(u, v, 3, 3, 0.5, 12.3);
      let r = (128 + warm * 22) * tone;
      let g = (124 + warm * 10) * tone;
      let b = (114 - warm * 6) * tone;
      const dark = 1 - crack * 0.28 - crack2 * 0.15 - pit * 0.2;
      r *= dark;
      g *= dark;
      b *= dark;
      if (speck > 0.992) {
        r += 50;
        g += 50;
        b += 46;
      }
      const o = (j * size + i) * 4;
      alb[o] = clampByte(r);
      alb[o + 1] = clampByte(g);
      alb[o + 2] = clampByte(b);
      alb[o + 3] = 255;
    }
  }
  const nrm = heightToNormals(H, size, size / 55, new Uint8Array(size * size * 4));
  return {
    albedo: makeTexture(alb, size, { srgb: true, anisotropy }),
    normal: makeTexture(nrm, size, { anisotropy }),
  };
}

/**
 * Skin of reef animals (sponges, corals): knobbly fbm bumps pitted with small
 * pores (jittered-cell distance) and a few larger oscula. Tileable, world
 * tile 0.6 m. Normal map only (height in alpha, used to darken the pits).
 */
export function makeReefTextures(size, anisotropy) {
  const H = new Float32Array(size * size);
  // Pits: distance to the nearest jittered point of a periodic grid of cells
  // (per-cell jitter and size tabulated once: this runs at boot).
  const pitGrid = (cells, seed) => {
    const n = cells * cells;
    const g = { cells, h: new Float32Array(n), pu: new Float32Array(n), pv: new Float32Array(n) };
    for (let wv = 0; wv < cells; wv++) {
      for (let wu = 0; wu < cells; wu++) {
        const c = wv * cells + wu;
        g.h[c] = hash2(wu * 7 + seed, wv * 13 - seed);
        g.pu[c] = 0.15 + 0.7 * hash2(wu + seed * 3, wv + 101);
        g.pv[c] = 0.15 + 0.7 * hash2(wu - 57, wv + seed * 5);
      }
    }
    return g;
  };
  const pits = (u, v, g, rad) => {
    const cells = g.cells;
    const cu = u * cells;
    const cv = v * cells;
    const iu = Math.floor(cu);
    const iv = Math.floor(cv);
    let best2 = 81;
    let bestH = 0;
    for (let dv = -1; dv <= 1; dv++) {
      const gv = iv + dv;
      const wv = (gv + cells) % cells;
      for (let du = -1; du <= 1; du++) {
        const gu = iu + du;
        const c = wv * cells + ((gu + cells) % cells);
        const dx = cu - gu - g.pu[c];
        const dy = cv - gv - g.pv[c];
        const d2 = dx * dx + dy * dy;
        if (d2 < best2) {
          best2 = d2;
          bestH = g.h[c];
        }
      }
    }
    // Pore size varies per cell; some cells have none.
    const r = rad * (0.55 + 0.6 * bestH);
    return bestH < 0.15 ? 0 : smoothstep(r, r * 0.35, Math.sqrt(best2));
  };
  const poreGrid = pitGrid(18, 11);
  const oscGrid = pitGrid(5, 29);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const knob = pfbm2(u, v, 5, 3, 0.5, 31.0);
      const fine = pfbm2(u, v, 24, 2, 0.5, 9.3);
      const pore = pits(u, v, poreGrid, 0.32);
      const osc = pits(u, v, oscGrid, 0.22);
      H[j * size + i] = knob * 0.7 + fine * 0.15 - pore * 0.12 - osc * 0.3;
    }
  }
  const nrm = heightToNormals(H, size, size / 40, new Uint8Array(size * size * 4));
  return { normal: makeTexture(nrm, size, { anisotropy }) };
}

/** Four independent tileable low-frequency noises (linear data) for variation. */
export function makeVariationTexture(size) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = (j * size + i) * 4;
      data[o] = clampByte((pfbm2(u, v, 4, 5, 0.55, 0.3) * 0.9 + 0.5) * 255);
      data[o + 1] = clampByte((pfbm2(u, v, 6, 4, 0.5, 21.7) * 0.9 + 0.5) * 255);
      data[o + 2] = clampByte((pfbm2(u, v, 12, 3, 0.5, 44.1) * 0.9 + 0.5) * 255);
      data[o + 3] = clampByte((pfbm2(u, v, 2, 4, 0.5, 63.9) * 0.9 + 0.5) * 255);
    }
  }
  return makeTexture(data, size, { anisotropy: 1 });
}

/**
 * Old ship planking: 8 planks across V, grain along U, butt joints, nail
 * holes, rot. Tile ≈ 3 m along the planks × 1.6 m across.
 */
export function makeWoodTextures(size, anisotropy) {
  const rand = mulberry32(303);
  const H = new Float32Array(size * size);
  const alb = new Uint8Array(size * size * 4);
  const planks = 8;
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const pv = v * planks;
    const plank = Math.floor(pv);
    const fv = pv - plank;
    const pr = hash2(plank, 7);
    const pr2 = hash2(plank, 19);
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const ju = (u + pr * 0.73) % 1;
      const grain = pnoise2(u * 3 + pr * 10, v * 96, 3, 96) * 0.6 + pnoise2(u * 6, v * 192 + 3.3, 6, 192) * 0.4;
      const knotN = pfbm2(u, v, 8, 2, 0.5, pr * 50);
      const rot = smoothstep(0.1, 0.5, pfbm2(u, v, 5, 4, 0.55, 9.9));
      const seam = smoothstep(0.06, 0.0, Math.min(fv, 1 - fv));
      const joint = smoothstep(0.006, 0.0, Math.min(ju, 1 - ju));
      // nail heads near the joints
      const nailU = Math.min(Math.abs(ju - 0.02), Math.abs(ju - 0.98));
      const nail = smoothstep(0.012, 0.004, Math.hypot(nailU * 3, (fv - 0.5) / planks));
      const h = 0.5 + grain * 0.18 + knotN * 0.1 - seam * 0.5 - joint * 0.45 - rot * 0.2 - nail * 0.2;
      H[j * size + i] = h;

      const speck = rand();
      const tone = (0.78 + pr2 * 0.38) * (0.9 + grain * 0.22 + (speck - 0.5) * 0.06);
      let r = 128 * tone;
      let g = 110 * tone;
      let b = 88 * tone;
      // rot and algae stains: darker, greener
      r = r * (1 - rot * 0.45);
      g = g * (1 - rot * 0.32);
      b = b * (1 - rot * 0.4);
      const dark = 1 - seam * 0.55 - joint * 0.5;
      r *= dark;
      g *= dark;
      b *= dark;
      if (nail > 0.3) {
        r = 70;
        g = 52;
        b = 40;
      }
      const o = (j * size + i) * 4;
      alb[o] = clampByte(r);
      alb[o + 1] = clampByte(g);
      alb[o + 2] = clampByte(b);
      alb[o + 3] = 255;
    }
  }
  const nrm = heightToNormals(H, size, size / 90, new Uint8Array(size * size * 4));
  return {
    albedo: makeTexture(alb, size, { srgb: true, anisotropy }),
    normal: makeTexture(nrm, size, { anisotropy }),
  };
}

/** Diamond-mesh fishing net (alpha mask), knotted, slightly irregular. */
export function makeNetTexture(size) {
  const data = new Uint8Array(size * size * 4);
  const cells = 8;
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const wob = pfbm2(u, v, 4, 2, 0.5, 5.0) * 0.06;
      const a = (u + v) * cells + wob;
      const b = (u - v) * cells - wob;
      const da = Math.abs((a - Math.floor(a)) - 0.5) * 2; // 1 on the twine
      const db = Math.abs((b - Math.floor(b)) - 0.5) * 2;
      const twA = smoothstep(0.83, 0.92, da);
      const twB = smoothstep(0.83, 0.92, db);
      const knot = smoothstep(0.7, 0.8, Math.min(da, db));
      const alpha = Math.max(twA, twB, knot);
      const o = (j * size + i) * 4;
      const shade = 0.75 + 0.25 * Math.max(da, db);
      data[o] = 92 * shade;
      data[o + 1] = 96 * shade;
      data[o + 2] = 84 * shade;
      data[o + 3] = alpha * 255;
    }
  }
  return makeTexture(data, size, { srgb: true, anisotropy: 4 });
}

/** Wind-wave normal map for the surface seen from below. */
export function makeWaveNormalTexture(size) {
  const H = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      // Slightly sharpened crests.
      const n = pfbm2(u, v, 4, 5, 0.5, 2.5);
      H[j * size + i] = n - Math.abs(pfbm2(u, v, 8, 3, 0.5, 31.0)) * 0.35;
    }
  }
  const nrm = heightToNormals(H, size, size / 18, new Uint8Array(size * size * 4));
  return makeTexture(nrm, size, { anisotropy: 2 });
}
