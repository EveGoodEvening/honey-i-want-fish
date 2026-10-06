// Small deterministic noise toolkit used at build time (terrain, textures,
// rock/cliff displacement). Nothing here runs per frame.
//
// - mulberry32(seed): fast seeded PRNG returning [0, 1)
// - noise2 / noise3: improved Perlin gradient noise, roughly [-1, 1]
// - pnoise2(x, y, px, py): Perlin noise that tiles with integer periods (textures)
// - fbm2 / fbm3 / pfbm2 / ridged3: fractal sums of the above

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Permutation table (fixed seed so the world is identical every run).
const PERM = new Uint8Array(512);
{
  const rand = mulberry32(0x5eab0d);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

// 8 gradient directions for 2D.
const G2X = new Float32Array([1, -1, 1, -1, 1.4142, -1.4142, 0, 0]);
const G2Y = new Float32Array([1, 1, -1, -1, 0, 0, 1.4142, -1.4142]);

function grad2(h, x, y) {
  const i = h & 7;
  return G2X[i] * x + G2Y[i] * y;
}

function grad3(h, x, y, z) {
  const hh = h & 15;
  const u = hh < 8 ? x : y;
  const v = hh < 4 ? y : hh === 12 || hh === 14 ? x : z;
  return ((hh & 1) === 0 ? u : -u) + ((hh & 2) === 0 ? v : -v);
}

/** 2D gradient noise, ~[-1, 1]. */
export function noise2(x, y) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const X = fx & 255;
  const Y = fy & 255;
  x -= fx;
  y -= fy;
  const u = fade(x);
  const v = fade(y);
  const a = PERM[X] + Y;
  const b = PERM[X + 1] + Y;
  return lerp(
    lerp(grad2(PERM[a], x, y), grad2(PERM[b], x - 1, y), u),
    lerp(grad2(PERM[a + 1], x, y - 1), grad2(PERM[b + 1], x - 1, y - 1), u),
    v,
  ) * 0.75;
}

/** 2D gradient noise that tiles every (px, py) lattice cells (integers ≤ 256). */
export function pnoise2(x, y, px, py) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  x -= fx;
  y -= fy;
  const X0 = ((fx % px) + px) % px;
  const Y0 = ((fy % py) + py) % py;
  const X1 = (X0 + 1) % px;
  const Y1 = (Y0 + 1) % py;
  const u = fade(x);
  const v = fade(y);
  const h00 = PERM[PERM[X0] + Y0];
  const h10 = PERM[PERM[X1] + Y0];
  const h01 = PERM[PERM[X0] + Y1];
  const h11 = PERM[PERM[X1] + Y1];
  return lerp(
    lerp(grad2(h00, x, y), grad2(h10, x - 1, y), u),
    lerp(grad2(h01, x, y - 1), grad2(h11, x - 1, y - 1), u),
    v,
  ) * 0.75;
}

/** 3D improved Perlin noise, ~[-1, 1]. */
export function noise3(x, y, z) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  x -= fx;
  y -= fy;
  z -= fz;
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;
  return lerp(
    lerp(
      lerp(grad3(PERM[AA], x, y, z), grad3(PERM[BA], x - 1, y, z), u),
      lerp(grad3(PERM[AB], x, y - 1, z), grad3(PERM[BB], x - 1, y - 1, z), u),
      v,
    ),
    lerp(
      lerp(grad3(PERM[AA + 1], x, y, z - 1), grad3(PERM[BA + 1], x - 1, y, z - 1), u),
      lerp(grad3(PERM[AB + 1], x, y - 1, z - 1), grad3(PERM[BB + 1], x - 1, y - 1, z - 1), u),
      v,
    ),
    w,
  );
}

export function fbm2(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, y) * amp;
    norm += amp;
    amp *= gain;
    // Rotate a little between octaves to hide lattice alignment.
    const nx = x * 1.6 - y * 1.2;
    const ny = x * 1.2 + y * 1.6;
    x = nx * (lacunarity / 2) + 17.13;
    y = ny * (lacunarity / 2) - 9.71;
  }
  return sum / norm;
}

export function fbm3(x, y, z, octaves = 5, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x, y, z) * amp;
    norm += amp;
    amp *= gain;
    x = x * lacunarity + 31.7;
    y = y * lacunarity - 12.3;
    z = z * lacunarity + 5.9;
  }
  return sum / norm;
}

/** Ridged multifractal (sharp crests), ~[0, 1]. */
export function ridged3(x, y, z, octaves = 5, lacunarity = 2.1, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise3(x, y, z));
    n *= n;
    sum += n * amp * prev;
    norm += amp;
    prev = n;
    amp *= gain;
    x = x * lacunarity + 7.1;
    y = y * lacunarity + 3.3;
    z = z * lacunarity - 1.7;
  }
  return sum / norm;
}

/** Tileable fBm over the unit square: u, v in [0, 1), base period in cells. */
export function pfbm2(u, v, period, octaves = 5, gain = 0.5, offset = 0) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    const o = offset + i * 37.17;
    sum += pnoise2(u * p + o, v * p - o * 0.7, p, p) * amp;
    norm += amp;
    amp *= gain;
    p *= 2;
    if (p > 256) break;
  }
  return sum / norm;
}

/** Cheap integer hash → [0, 1). */
export function hash2(ix, iy) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
