// World layout + seabed heightfield.
//
// The seabed is a regular grid of heights computed once from an analytic
// function. The rendered mesh uses exactly these vertices and the same
// triangulation that heightAt() interpolates, so getSeabedHeight(x, z) matches
// the visible ground to float precision, and costs a handful of array reads.
//
// Angles are measured from north (−Z) clockwise toward east (+X):
//   theta = atan2(x, −z);  x = r·sin(theta), z = −r·cos(theta)
import { WORLD } from '../core/config.js';
import { fbm2, noise2, smoothstep } from './noise.js';

const DEG = Math.PI / 180;

export const polar = (r, theta) => ({ x: r * Math.sin(theta), z: -r * Math.cos(theta) });

export const LAYOUT = {
  size: 420, // terrain edge length (m); fog hides the edges
  floorY: WORLD.floorY,
  // A towering reef wall bending around the north side of the arena.
  cliff: { center: -24 * DEG, half: 78 * DEG, taper: 18 * DEG, radius: 64, rise: 6, topY: -11 },
  // A drop-off into a black trench on the east/south-east side.
  trench: { center: 110 * DEG, half: 56 * DEG, taper: 16 * DEG, radius: 58, width: 26, bottomY: -138 },
  // Sunken fishing boat: in front of the cliff, north-west of the arena centre,
  // lying broadside to the arena with its deck rolled toward it.
  // heading: bow direction = (sin h, 0, cos h).
  wreck: { ...polar(44, -36 * DEG), heading: 120 * DEG, length: 15, beam: 4.6 },
  kelpPatches: [
    { ...polar(58, -84 * DEG), radius: 15, density: 1.0 },
    { ...polar(52, -146 * DEG), radius: 13, density: 0.85 },
    { ...polar(55, -52 * DEG), radius: 9, density: 0.7 },
    { ...polar(50, 30 * DEG), radius: 10, density: 0.75 },
    { ...polar(70, -122 * DEG), radius: 12, density: 0.8 },
  ],
  grassMeadows: [
    { ...polar(30, 180 * DEG), radius: 16 },
    { ...polar(26, -118 * DEG), radius: 11 },
    { ...polar(30, -6 * DEG), radius: 10 },
    { ...polar(36, 60 * DEG), radius: 9 },
    { ...polar(14, -60 * DEG), radius: 6 },
  ],
  // Big rock formations (bommies) that break up sight lines; all outside the
  // central ~40 m combat circle.
  outcrops: [
    { ...polar(44, 22 * DEG), size: 7.5, tall: 1.6 },
    { ...polar(43, -112 * DEG), size: 6.5, tall: 1.2 },
    { ...polar(45, 150 * DEG), size: 7, tall: 1.0 },
    { ...polar(50, -6 * DEG), size: 5.5, tall: 1.9 },
    { ...polar(49, 76 * DEG), size: 6, tall: 0.9 },
    { ...polar(46, -168 * DEG), size: 5, tall: 1.4 },
  ],
};

const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/** 0..1 weight of an angular sector with soft ends. */
function sectorWeight(theta, s) {
  const d = Math.abs(wrapAngle(theta - s.center));
  return smoothstep(s.half, s.half - s.taper, d);
}

/** Radius of the cliff face at a given angle (wobbly, not a perfect arc). */
export function cliffRadius(theta) {
  const c = LAYOUT.cliff;
  return c.radius + noise2(theta * 3.1, 4.2) * 5 + noise2(theta * 9.0, 1.7) * 1.6;
}

/** Radius of the trench lip at a given angle. */
export function trenchRadius(theta) {
  const t = LAYOUT.trench;
  return t.radius + noise2(theta * 3.7, 9.1) * 5 + noise2(theta * 11, 3.3) * 1.5;
}

/** Height of the cliff plateau top along the arc (tapers at the ends). */
export function cliffTop(theta, x, z) {
  const c = LAYOUT.cliff;
  return c.topY + fbm2(x / 20, z / 20, 3) * 3.5 + noise2(theta * 6, 0.5) * 2.5;
}

/** Undulating sand plain (before cliff/trench/wreck shaping). */
function plainHeight(x, z) {
  const floor = LAYOUT.floorY;
  const r = Math.hypot(x, z);
  let h = fbm2(x / 75, z / 75, 4) * 3.0 + fbm2(x / 24 + 40, z / 24 - 13, 3) * 0.9;
  // Long-crested sand waves.
  const warp = fbm2(x / 45, z / 45, 2) * 3.5;
  h += Math.sin((x * 0.78 + z * 0.62) / 6.5 + warp) * 0.32 * (0.6 + 0.4 * noise2(x / 30, z / 30));
  // Keep the central combat area gentle.
  const flat = smoothstep(46, 14, r);
  h *= 1 - 0.55 * flat;
  return floor + h;
}

/** Analytic seabed height used to fill the grid (build time only). */
export function analyticHeight(x, z) {
  let h = plainHeight(x, z);
  const r = Math.hypot(x, z);
  const theta = Math.atan2(x, -z);

  // Cliff: a steep rise to a plateau, with a talus ramp at its foot.
  const c = LAYOUT.cliff;
  const cw = sectorWeight(theta, c);
  if (cw > 0) {
    const R = cliffRadius(theta);
    const talus = smoothstep(R - 14, R, r) * 2.4;
    const s = smoothstep(R, R + c.rise, r);
    const top = cliffTop(theta, x, z);
    h += talus * cw * (1 - s);
    h += (top - h) * s * cw;
  }

  // Trench: a raised lip, then a near-vertical wall into the dark.
  const t = LAYOUT.trench;
  const tw = sectorWeight(theta, t);
  if (tw > 0) {
    const R = trenchRadius(theta);
    const lip = Math.exp(-((r - R + 2.5) ** 2) / 10) * 1.3;
    // Buttresses and gullies running down the wall (the wall line wobbles
    // with position), then a few ledges on the way down.
    const wob = fbm2(x / 10, z / 10, 3) * 5 + noise2(x / 3.7, z / 3.7) * 1.4;
    let d = smoothstep(R, R + t.width, r + wob * smoothstep(R - 3, R + 6, r));
    d = d * d * (3 - 2 * d); // steepen the middle of the wall
    const n = 6;
    d -= (Math.sin(d * Math.PI * 2 * n) / (Math.PI * 2 * n)) * 0.75;
    const bottom = t.bottomY + fbm2(x / 30, z / 30, 3) * 8;
    h += lip * tw * (1 - d);
    h += (bottom - h) * d * tw;
  }

  // Wreck scour: settle the ground under the hull and dig a shallow moat.
  const w = LAYOUT.wreck;
  const dx = x - w.x;
  const dz = z - w.z;
  const ch = Math.cos(w.heading);
  const sh = Math.sin(w.heading);
  const lx = dx * ch - dz * sh; // across the hull
  const lz = dx * sh + dz * ch; // along the hull
  const e = Math.hypot(lx / (w.beam * 0.9), lz / (w.length * 0.6));
  if (e < 2.2) {
    const base = wreckBaseY();
    const settle = smoothstep(1.6, 0.9, e);
    h += (base - h) * settle;
    h -= Math.exp(-((e - 1.25) ** 2) / 0.08) * 0.45; // scour moat
  }
  return h;
}

let _wreckBase = null;
export function wreckBaseY() {
  if (_wreckBase === null) {
    const w = LAYOUT.wreck;
    _wreckBase = plainHeight(w.x, w.z) - 0.15;
  }
  return _wreckBase;
}

/** Regular-grid heightfield with exact triangle interpolation. */
export class Heightfield {
  constructor(segments, size = LAYOUT.size) {
    this.segments = segments;
    this.size = size;
    this.half = size / 2;
    this.cell = size / segments;
    this.invCell = segments / size;
    const row = segments + 1;
    this.row = row;
    const heights = new Float32Array(row * row);
    for (let iz = 0; iz < row; iz++) {
      const z = -this.half + iz * this.cell;
      for (let ix = 0; ix < row; ix++) {
        const x = -this.half + ix * this.cell;
        heights[iz * row + ix] = analyticHeight(x, z);
      }
    }
    this.heights = heights;
  }

  /**
   * Height of the rendered seabed at (x, z). Grid cell (ix, iz) is split into
   * triangles (a, b, d) and (b, c, d) with a=(ix,iz) b=(ix,iz+1) c=(ix+1,iz+1)
   * d=(ix+1,iz) — the same split Seabed.js uses for its index buffer.
   */
  heightAt(x, z) {
    const n = this.segments;
    let fx = (x + this.half) * this.invCell;
    let fz = (z + this.half) * this.invCell;
    if (!(fx > 0)) fx = 0; // also catches NaN
    else if (fx > n) fx = n;
    if (!(fz > 0)) fz = 0;
    else if (fz > n) fz = n;
    let ix = Math.floor(fx);
    let iz = Math.floor(fz);
    if (ix >= n) ix = n - 1;
    if (iz >= n) iz = n - 1;
    const tx = fx - ix;
    const tz = fz - iz;
    const h = this.heights;
    const i = iz * this.row + ix;
    const ha = h[i];
    const hd = h[i + 1];
    const hb = h[i + this.row];
    const hc = h[i + this.row + 1];
    if (tx + tz <= 1) return ha + (hd - ha) * tx + (hb - ha) * tz;
    return hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
  }

  /** Approximate surface normal (central differences), written into `out`. */
  normalAt(x, z, out) {
    const e = this.cell;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  /** Steepness 0 (flat) .. 1 (vertical) at (x, z). */
  slopeAt(x, z) {
    const e = this.cell;
    const hx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const hz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return 1 - 1 / Math.sqrt(1 + hx * hx + hz * hz);
  }
}
