// Smooth 1D gradient noise in [-1, 1] — used for camera shake and sway so the
// motion is continuous (no per-frame random jitter).

function grad(i, seed) {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

export function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = grad(i, seed) * f;
  const g1 = grad(i + 1, seed) * (f - 1);
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  // gradient noise peaks at ~0.5; scale to roughly [-1, 1]
  return (g0 + (g1 - g0) * u) * 2;
}

/** Two octaves, for slightly richer motion. */
export function noise2(x, seed = 0) {
  return noise1(x, seed) * 0.7 + noise1(x * 2.13 + 17.3, seed + 7) * 0.3;
}
