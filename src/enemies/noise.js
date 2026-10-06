// Small deterministic RNG + value noise used by the procedural shark builder
// (CPU side only: geometry and texture generation, never per frame).

export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ValueNoise {
  constructor(seed = 1) {
    const rng = makeRng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.values = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.values[i] = rng() * 2 - 1;
  }

  /**
   * Smooth 2D value noise in [-1, 1]. When `py` > 0 the noise is periodic
   * along y with that integer period (used to wrap seamlessly around the
   * body's circumference).
   */
  noise2(x, y, py = 0) {
    const fx0 = Math.floor(x);
    const fy0 = Math.floor(y);
    const fx = x - fx0;
    const fy = y - fy0;
    let iy0 = fy0;
    let iy1 = fy0 + 1;
    if (py > 0) {
      iy0 = ((iy0 % py) + py) % py;
      iy1 = (iy0 + 1) % py;
    }
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const perm = this.perm;
    const val = this.values;
    const x0 = fx0 & 255;
    const x1 = (fx0 + 1) & 255;
    const y0 = iy0 & 255;
    const y1 = iy1 & 255;
    const a = val[perm[perm[x0] + y0]];
    const b = val[perm[perm[x1] + y0]];
    const c = val[perm[perm[x0] + y1]];
    const d = val[perm[perm[x1] + y1]];
    const ab = a + (b - a) * ux;
    const cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  }

  /** Fractal sum of `octaves` noise layers, normalised to roughly [-1, 1]. */
  fbm2(x, y, octaves = 4, py = 0, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2(x * f, y * f, py * f);
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  }
}

export function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}
