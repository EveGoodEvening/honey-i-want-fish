// Procedural shark skin textures painted on the CPU into typed arrays:
//   albedo  (sRGB)  — countershading with an irregular boundary, mottling,
//                     tiger bars, scars & bite rakes, gill slits, mouth
//                     line, eye socket, ampullae pores, fin strip
//   normal  (linear)— skin grain, longitudinal denticle ridges, scar ridges,
//                     gill grooves, pores
//   orm     (linear)— R = ambient occlusion, G = roughness (wet sheen); half
//                     resolution at 2048 (both are low-frequency)
// plus one tiling detail normal shared by every species (denticle plates and
// micro-scars at a fixed 0.35 m repeat, blended in the skin shader).
//
// Scale: everything that is a physical feature (pores, scars, bite rakes,
// the detail map) is sized in METRES, not body lengths, so the 16 m megalodon
// carries ~2.7× more, finer marks per body length than the 6 m white — that
// density is what tells the eye it is huge.
//
// UV layout matches SharkGeometry: u = s * U_BODY along the body, v = angle
// around the body (0 = belly, 0.25 = +x flank, 0.5 = back). Fins sample a strip
// at u ≥ U_FIN (v < 0.5 pale underside, v ≥ 0.5 grey upper side).
//
// Painting is a generator that yields every couple of rows (≈ ≤ 6 ms slices)
// so the EnemyManager can spread the work over idle time.
import * as THREE from 'three';
import { ValueNoise, makeRng, clamp, smoothstep, lerp } from './noise.js';
import { U_BODY, U_FIN } from './SharkGeometry.js';

export const TEX_SIZE = { high: 2048, medium: 1024, low: 512 };
/** Shared detail normal: texture size per quality and the physical tile size (m). */
export const DETAIL_SIZE = { high: 512, medium: 512, low: 256 };
export const DETAIL_TILE_M = 0.35;
const DEG = Math.PI / 180;
/** Physical pore spacing / radius (m): the white's ampullae, on every species. */
const PORE_CELL_M = 0.066;
const PORE_RADIUS_M = 0.0078;
/** Axillary spot: largest semi-axis (m), whatever the body length. */
const AXIL_M = 0.11;

/**
 * Reference circumference (m) of the body: the texture's v axis spans this
 * many metres (used for metric noise and the detail-normal repeat).
 */
export function bodyCircumference(anat) {
  let maxR = 0;
  for (let s = 0; s < anat.sEnd; s += 0.01) {
    const p = anat.profile(s);
    maxR = Math.max(maxR, (p.h + p.w) * 0.5);
  }
  return 2 * Math.PI * maxR * anat.L;
}

// Scratch buffers (temporary fields only — never texture data) reused by
// successive species builds: fewer multi-MB allocations, so fewer GC pauses
// landing inside a prefetch slice. Dropped once the prefetch queue drains.
const _scratch = [];

function takeScratch(Type, n, zero) {
  const i = _scratch.findIndex((b) => b instanceof Type && b.length === n);
  if (i < 0) return new Type(n);
  const buf = _scratch.splice(i, 1)[0];
  if (zero) buf.fill(0);
  return buf;
}

function giveScratch(...bufs) {
  for (const b of bufs) if (_scratch.length < 8) _scratch.push(b);
}

/** Frees the pooled scratch buffers (call when no more skins are being painted). */
export function releaseTextureScratch() {
  _scratch.length = 0;
}

function srgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function makeDataTexture(data, w, h, colorSpace, anisotropy) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds the list of scar strokes (X along / Y around the body, metres).
 * Positions are body-relative; lengths and widths are absolute metres (a
 * tooth rake is the size of the teeth that made it, whatever it scarred).
 */
function makeScars(spec, anat, C, rng) {
  const L = anat.L;
  const col = spec.colors;
  const strokes = [];
  const pushStroke = (x0, y0, x1, y1, w, kind) => strokes.push({ x0, y0, x1, y1, w, kind });
  for (let k = 0; k < col.scars; k++) {
    const s = 0.05 + rng() * 0.78;
    const v = 0.12 + rng() * 0.76;
    const X = s * L;
    const Y = v * C;
    if (rng() < 0.32) {
      // Bite rake: an arc of short parallel tooth scratches.
      const R = 0.3 + rng() * 0.48;
      const a0 = rng() * Math.PI * 2;
      const n = 5 + Math.floor(rng() * 4);
      const l = 0.07 + rng() * 0.09;
      for (let t = 0; t < n; t++) {
        const a = a0 + (t / (n - 1)) * (0.9 + rng() * 0.5);
        const cx = X + Math.cos(a) * R;
        const cy = Y + Math.sin(a) * R;
        pushStroke(cx, cy, cx + Math.cos(a) * l, cy + Math.sin(a) * l, 0.015 + rng() * 0.012, 1);
      }
    } else {
      // Long healed scratch: 0.2–1.0 m long, 1.5–3 cm wide.
      const ang = (rng() - 0.5) * 1.4 + (rng() < 0.2 ? Math.PI / 2 : 0);
      const len = 0.2 + rng() * 0.8;
      const w = 0.015 + rng() * 0.015;
      const x1 = X + Math.cos(ang) * len;
      const y1 = Y + Math.sin(ang) * len;
      // Slight bend: two segments.
      const mx = (X + x1) / 2 + (rng() - 0.5) * len * 0.15;
      const my = (Y + y1) / 2 + (rng() - 0.5) * len * 0.15;
      pushStroke(X, Y, mx, my, w, 1);
      pushStroke(mx, my, x1, y1, w * 0.85, 1);
    }
  }
  for (let k = 0; k < (col.freshScars ?? 0); k++) {
    // Fresh, open gashes: pinkish, recessed.
    const s = 0.08 + rng() * 0.5;
    const v = 0.2 + rng() * 0.6;
    const ang = (rng() - 0.5) * 1.0;
    const len = 0.15 + rng() * 0.3;
    const X = s * L;
    const Y = v * C;
    const n = 1 + Math.floor(rng() * 3);
    for (let t = 0; t < n; t++) {
      const off = (t - (n - 1) / 2) * (0.05 + rng() * 0.06);
      const a2 = ang + (rng() - 0.5) * 0.5;
      const l2 = len * (0.5 + rng() * 0.6);
      const sx = X - Math.sin(ang) * off + (rng() - 0.5) * 0.06;
      const sy = Y + Math.cos(ang) * off;
      pushStroke(sx, sy, sx + Math.cos(a2) * l2, sy + Math.sin(a2) * l2, 0.018 + rng() * 0.024, 2);
    }
  }
  return strokes;
}

/**
 * Tiger-shark bars: irregular, broken blotch-bars. Per band: width ±50 %,
 * spacing ±35 %, a slight lean, its own darkness and 2–4 segments.
 */
function makeStripeBands(spec) {
  const n = spec.colors.stripes;
  if (!n) return null;
  const rng = makeRng(spec.seed * 31 + 7);
  const s0 = 0.14;
  const s1 = 0.9;
  const step = (s1 - s0) / n;
  const bands = [];
  let s = s0 + step * 0.5 * rng();
  let prevW = 0;
  while (s < s1) {
    let w = step * 0.3 * (0.5 + rng());
    // Never two neighbours of (nearly) equal width.
    if (Math.abs(w - prevW) < step * 0.05) w += step * (rng() < 0.5 ? -0.08 : 0.08);
    prevW = w;
    bands.push({ c: s, w, segs: 2 + Math.floor(rng() * 3), lean: (rng() - 0.5) * 0.03, dark: 0.65 + 0.35 * rng(), seed: rng() * 200 });
    s += step * (0.65 + 0.7 * rng());
  }
  return bands;
}

function* rasterScars(strokes, W, H, dX, dY, scar, scarKind) {
  let work = 0; // texels visited since the last yield
  for (const st of strokes) {
    if (work > 40000) {
      work = 0;
      yield 'scars';
    }
    const hw = st.w * 0.5;
    const minX = Math.max(0, Math.floor((Math.min(st.x0, st.x1) - st.w) / dX));
    const maxX = Math.min(W - 1, Math.ceil((Math.max(st.x0, st.x1) + st.w) / dX));
    const minY = Math.floor((Math.min(st.y0, st.y1) - st.w) / dY);
    const maxY = Math.ceil((Math.max(st.y0, st.y1) + st.w) / dY);
    work += (maxX - minX + 1) * (maxY - minY + 1);
    const ex = st.x1 - st.x0;
    const ey = st.y1 - st.y0;
    const len2 = ex * ex + ey * ey || 1e-9;
    for (let yy = minY; yy <= maxY; yy++) {
      const row = ((yy % H) + H) % H;
      const Y = (yy + 0.5) * dY;
      for (let x = minX; x <= maxX; x++) {
        const X = (x + 0.5) * dX;
        let t = ((X - st.x0) * ex + (Y - st.y0) * ey) / len2;
        t = clamp(t, 0, 1);
        const px = st.x0 + ex * t - X;
        const py = st.y0 + ey * t - Y;
        const d = Math.sqrt(px * px + py * py);
        if (d > hw) continue;
        const m = (1 - smoothstep(hw * 0.35, hw, d)) * Math.sqrt(Math.sin(Math.PI * clamp(t * 0.96 + 0.02, 0, 1)));
        const i = row * W + x;
        if (m > scar[i]) {
          scar[i] = m;
          scarKind[i] = st.kind;
        }
      }
    }
  }
}

/**
 * Generator painting the body textures. `out` receives { map, normalMap, ormMap }.
 */
export function* paintSkin(anat, spec, size, out, anisotropy = 8) {
  const W = size;
  const H = size >> 1;
  const L = anat.L;
  const col = spec.colors;
  const noise = new ValueNoise(spec.seed);
  const noiseB = new ValueNoise(spec.seed * 7 + 3);
  const rng = makeRng(spec.seed * 13 + 5);
  const m = anat.mouth;

  // Reference circumference (metres) for isotropic noise around the body.
  const C = bodyCircumference(anat);
  const dX = L / (U_BODY * W); // metres per texel along the body
  const dY = C / H; // metres per texel around
  const per = (f) => Math.max(1, Math.round(C * f)); // integer period for wrap-around noise

  const back = srgb(col.back);
  const backDark = srgb(col.backDark);
  const flank = srgb(col.flank);
  const belly = srgb(col.belly);
  const scarPale = [0.78, 0.77, 0.74];
  const scarFresh = [0.52, 0.33, 0.32];
  const slitInner = [0.2, 0.11, 0.11];

  // Big buffers are taken a slice apart (first touch of tens of MB is not
  // free); temporaries come from a scratch pool shared by successive builds.
  const scar = takeScratch(Float32Array, W * H, true);
  yield 'alloc';
  const scarKind = takeScratch(Uint8Array, W * H, true);
  yield 'alloc';
  yield* rasterScars(makeScars(spec, anat, C, rng), W, H, dX, dY, scar, scarKind);
  yield 'alloc';
  const albedo = new Uint8Array(W * H * 4);
  yield 'alloc';
  const halfOrm = size >= 2048;
  const orm = halfOrm ? takeScratch(Uint8Array, W * H * 4, false) : new Uint8Array(W * H * 4);
  yield 'alloc';
  const height = takeScratch(Float32Array, W * H, false);
  yield 'alloc';

  // ---- per-column precomputation
  const colS = new Float32Array(W);
  const colR = new Float32Array(W); // mean radius (m) for angular → metric conversion
  const colBnd = new Float32Array(W);
  const jagP = new Float32Array(W);
  const jagN = new Float32Array(W);
  const colDelta = new Float32Array(W);
  // Toward the snout tip the body's circumference shrinks while every texel
  // row still wraps it once, so noise painted at the reference circumference
  // is squeezed into radial streaks round the UV pole. Fine detail (grain,
  // ridges, mottle, pores) fades out where the local radius drops under
  // ~2/3 of the reference one — the first ~8 % of the length.
  const colK = new Float32Array(W);
  const rRef = C / (2 * Math.PI);
  const bands = makeStripeBands(spec);
  const colBand = new Int16Array(W); // nearest tiger bar per column
  for (let x = 0; x < W; x++) {
    if ((x & 511) === 511) yield 'columns';
    const u = (x + 0.5) / W;
    const s = u / U_BODY;
    colS[x] = s;
    const p = anat.profile(Math.min(s, anat.sEnd));
    colR[x] = Math.max(0.002, (p.h + p.w) * 0.5 * L);
    colK[x] = u >= U_FIN ? 1 : smoothstep(0.3, 0.65, colR[x] / rRef);
    const X = s * L;
    // Boundary sits a little lower around the head/gills and rises toward the tail.
    let b = col.boundary;
    b += -0.08 * (1 - smoothstep(0.05, 0.3, s));
    b += 0.06 * smoothstep(0.55, 0.85, s);
    // Snout (colors.snoutGrey): the grey runs down to the jaw line — the
    // underside ahead of the mouth stays grey and the white starts at the
    // lips, then climbs back to the flank line behind the mouth. (A white
    // snout underside read as a dolphin's pale muzzle head-on / from below.)
    let jagK = 1;
    if (col.snoutGrey) {
      const w = col.snoutGrey * (1 - smoothstep(0.06, 0.13, s));
      const lip = -Math.cos(anat.delta(s)) + 0.04 - 0.16 * (1 - smoothstep(m.sFront - 0.01, m.sFront + 0.02, s));
      b = lerp(b, lip, w);
      jagK = 1 - 0.7 * w;
    }
    colBnd[x] = b;
    jagP[x] = jagK * col.boundaryJag * (noise.fbm2(X * 1.6, 3.7, 3) + 0.3 * noise.noise2(X * 4.5, 9.1));
    jagN[x] = jagK * col.boundaryJag * (noise.fbm2(X * 1.6, 21.3, 3) + 0.3 * noise.noise2(X * 4.5, 31.7));
    colDelta[x] = anat.delta(s);
    if (bands) {
      let bk = 0;
      for (let k = 1; k < bands.length; k++) if (Math.abs(bands[k].c - s) < Math.abs(bands[bk].c - s)) bk = k;
      colBand[x] = bk;
    }
  }
  // ---- per-row precomputation
  const rowTheta = new Float32Array(H);
  const rowSin = new Float32Array(H);
  const rowCos = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const th = v * Math.PI * 2 - Math.PI / 2;
    rowTheta[y] = th;
    rowSin[y] = Math.sin(th);
    rowCos[y] = Math.cos(th);
  }

  const P1 = per(0.9);
  const P2 = per(4.5);
  const Pw = per(0.7);
  const P9 = per(9);
  const Ps = Math.max(1, Math.round(H / 2.3));
  const g = spec.gills;
  const gA = g.s0 - 0.02;
  const gB = g.s0 + (g.count - 1) * g.spacing + 0.02;
  const eyeS = spec.eye.s;
  const eyeTh = spec.eye.theta * DEG;
  const eyeR = spec.eye.radius * L;
  const pec = spec.fins.pectoral;
  const poreCell = PORE_CELL_M;
  const poreCellsY = Math.max(1, Math.round(C / poreCell));
  const sEnd = anat.sEnd;
  const c = [0, 0, 0];

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const sn = rowSin[y];
    const cs = rowCos[y];
    const th = rowTheta[y];
    const sideP = cs >= 0;
    const Y = v * C;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = (x + 0.5) / W;
      let h = 0;
      let rough = 0.5;
      let ao = 1;

      if (u >= U_FIN) {
        // ---------------- fin strip
        const fu = (u - U_FIN) / (1 - U_FIN);
        const pale = v < 0.5;
        const t = pale ? clamp((v - 0.02) / 0.45, 0, 1) : clamp((v - 0.52) / 0.45, 0, 1);
        const ray = noise.noise2(fu * 26, t * 2.2 + (pale ? 40 : 0));
        const mot = noise.fbm2(fu * 4 + 11, t * 5 + (pale ? 20 : 0), 3);
        if (pale) {
          const k = 0.12 + 0.3 * smoothstep(0.55, 1, fu) + 0.15 * smoothstep(0.6, 1, t);
          for (let q = 0; q < 3; q++) c[q] = lerp(belly[q], flank[q], k) * (1 + 0.03 * mot);
        } else {
          const k = 0.55 + 0.45 * clamp(mot * 1.4, -1, 1);
          for (let q = 0; q < 3; q++) c[q] = lerp(lerp(backDark[q], back[q], k), flank[q], 0.45) * (0.95 + 0.05 * ray);
        }
        h = 0.25 * ray + 0.1 * mot;
        rough = 0.5 + 0.05 * mot;
      } else if (colS[x] > sEnd) {
        for (let q = 0; q < 3; q++) c[q] = back[q];
      } else {
        // ---------------- body
        const s = colS[x];
        const X = s * L;
        const r = colR[x];
        const jag = sideP ? jagP[x] : jagN[x];
        // A little 2D wobble so the boundary is not just a function of s.
        const wob = 0.03 * noiseB.noise2(X * 2.5, v * P1 * 2, P1 * 2);
        const bnd = colBnd[x] + jag + wob;
        // Never sharper than ~1.5 texels around the body (avoids stair-stepping).
        const soft = Math.max(col.boundarySoft, (1.5 * dY) / Math.max(0.05, r));
        const tBack = smoothstep(bnd - soft, bnd + soft, sn);

        const kd = colK[x];
        const mot = kd * noise.fbm2(X * 0.9, v * P1, 3, P1);
        const fine = kd * noise.noise2(X * 4.5, v * P2, P2);
        // Back: mottled slate with a lighter flank band above the boundary.
        const km = clamp(0.55 + mot * 1.5 * (col.mottle / 0.1) * 0.5, 0, 1);
        const flankK = smoothstep(0.45, 0.0, sn - bnd) * 0.45;
        const topK = smoothstep(0.75, 1.0, sn) * 0.08;
        for (let q = 0; q < 3; q++) {
          let bc = lerp(backDark[q], back[q], km);
          bc = lerp(bc, flank[q], flankK);
          bc *= 1 - topK + 0.035 * fine;
          let wc = belly[q] * (0.985 - 0.025 * fine);
          // Faint grey cast on the belly just under the boundary.
          wc = lerp(wc, flank[q], 0.18 * smoothstep(-0.25, 0, sn - bnd));
          c[q] = lerp(wc, bc, tBack);
        }
        rough = lerp(0.58, 0.47, tBack) + 0.04 * fine;
        // A matte top of the head (species colors.headMatte): no wet gloss
        // on the snout and forehead, which read as a dolphin's melon.
        if (col.headMatte) rough += col.headMatte * (1 - smoothstep(0.1, 0.24, s)) * tBack;

        // Tiger bars: irregular blotch-bars broken into 2–4 ragged segments,
        // fading out toward the head and down the flank (adult pattern).
        if (bands) {
          const fade = smoothstep(0.16, 0.38, s) * (1 - smoothstep(0.86, 0.95, s)) * smoothstep(-0.25, 0.35, sn);
          let st = 0;
          if (fade > 0) {
            const warp = 0.014 * noise.fbm2(X * 0.7, v * Pw + 5, 2, Pw);
            const k0 = colBand[x];
            const k1 = Math.min(bands.length - 1, k0 + 1);
            for (let k = Math.max(0, k0 - 1); k <= k1; k++) {
              const b = bands[k];
              const d = Math.abs(s + warp - (b.c + b.lean * sn)) / b.w;
              if (d >= 1) continue;
              const Pk = b.segs * 3;
              const seg = smoothstep(-0.3, 0.15, noiseB.noise2(b.seed + X * 0.4, v * Pk, Pk));
              st = Math.max(st, (1 - smoothstep(0.4, 1, d)) * seg * b.dark);
            }
            st *= fade;
          }
          for (let q = 0; q < 3; q++) c[q] = lerp(c[q], backDark[q] * 0.42, st * 0.9 * 0.55);
          // Small dark spots on the head and flanks.
          const spot = smoothstep(0.55, 0.75, noise.noise2(X * 9, v * P9, P9)) * (1 - smoothstep(0.2, 0.4, s)) * smoothstep(-0.2, 0.2, sn);
          for (let q = 0; q < 3; q++) c[q] = lerp(c[q], backDark[q] * 0.6, spot * 0.6);
        }

        // Ampullae of Lorenzini: dark pores scattered over the snout.
        if (s < 0.15 && col.pores) {
          const gx = Math.floor(X / poreCell);
          const gy = Math.floor((Y / C) * poreCellsY);
          let best = 9;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              const cx = gx + ox;
              const cy = (((gy + oy) % poreCellsY) + poreCellsY) % poreCellsY;
              const hv = noise.perm[(noise.perm[cx & 255] + (cy & 255)) & 511];
              if ((hv & 3) !== 0 && col.pores < 1.2) continue; // ~25% of cells carry a pore
              const jx = (cx + 0.2 + 0.6 * ((hv * 37) % 101) / 101) * poreCell;
              const jy = (gy + oy + 0.2 + 0.6 * ((hv * 53) % 97) / 97) * (C / poreCellsY);
              const dx = jx - X;
              const dy = jy - Y;
              const d2 = dx * dx + dy * dy;
              if (d2 < best) best = d2;
            }
          }
          const pr = PORE_RADIUS_M * (1 - smoothstep(0.06, 0.15, s) * 0.6);
          const pd = (1 - smoothstep(pr * 0.4, pr, Math.sqrt(best))) * (1 - smoothstep(0.1, 0.15, s)) * kd;
          for (let q = 0; q < 3; q++) c[q] *= 1 - 0.28 * pd;
          h -= 0.25 * pd;
        }

        // Gill slits: dark crease with a lighter posterior flap.
        if (s > gA && s < gB) {
          const gs = anat.gillSlit(s, th);
          if (gs) {
            const d = gs.d * L;
            const sw = g.width * L * 0.42;
            const dark = (1 - smoothstep(sw * 0.2, sw * 1.1, Math.abs(d + sw * 0.25))) * gs.fade;
            const rim = Math.exp(-(((d - sw * 0.9) / (sw * 0.9)) ** 2)) * gs.fade;
            for (let q = 0; q < 3; q++) c[q] = lerp(c[q], slitInner[q], dark * 0.55) * (1 + 0.06 * rim);
            h += -0.7 * dark + 0.2 * rim;
            ao *= 1 - 0.45 * dark;
            rough = lerp(rough, 0.7, dark);
          }
        }

        // Mouth line along the lips.
        if (s > m.sFront - 0.006 && s < m.sClose) {
          const dl = colDelta[x];
          const tP = -Math.PI / 2 + dl;
          const tN = (3 * Math.PI) / 2 - dl;
          const dth = Math.min(Math.abs(th - tP), Math.abs(th - tN));
          const d = dth * r;
          const lw = 0.008 * L * (s < m.sHinge ? 1 : 1 - smoothstep(m.sHinge, m.sClose, s));
          if (lw > 0) {
            const k = 1 - smoothstep(lw * 0.2, lw, d);
            for (let q = 0; q < 3; q++) c[q] *= 1 - 0.45 * k;
            h -= 0.8 * k;
            ao *= 1 - 0.4 * k;
          }
        }

        // Dark eye socket.
        if (Math.abs(s - eyeS) < 0.04) {
          const thE = sideP ? eyeTh : Math.PI - eyeTh;
          const de = Math.hypot((s - eyeS) * L, (th - thE) * r);
          const k = 1 - smoothstep(eyeR * 1.0, eyeR * 2.6, de);
          for (let q = 0; q < 3; q++) c[q] *= 1 - 0.45 * k;
          ao *= 1 - 0.3 * k;
        }

        // Black axillary spot under the pectoral fin root (great white trait).
        // Absolute size (≤ AXIL_M m): scaled with a 16 m body it was a 0.6 m
        // black disc on the megalodon's belly.
        if (col.axillary && pec) {
          const sA = pec.s1 + 0.004;
          const thA = sideP ? -40 * DEG : Math.PI + 40 * DEG;
          const ds = (s - sA) * L;
          const dt = (th - thA) * r;
          const k = 1 - smoothstep(0.6, 1.0, Math.hypot(ds / Math.min(0.018 * L, AXIL_M), dt / Math.min(0.014 * L, AXIL_M * 0.78)));
          for (let q = 0; q < 3; q++) c[q] = lerp(c[q], 0.06, k * 0.85);
        }
        // Occlusion under the pectoral root.
        if (pec) {
          const thA = sideP ? pec.theta * DEG : Math.PI - pec.theta * DEG;
          const ds = s < pec.s0 ? (pec.s0 - s) * L : s > pec.s1 ? (s - pec.s1) * L : 0;
          const dt = Math.abs(th - thA) * r;
          ao *= 1 - 0.35 * (1 - smoothstep(0, 0.03 * L, Math.hypot(ds, dt)));
        }

        // Scars.
        const sm = scar[i];
        if (sm > 0) {
          if (scarKind[i] === 2) {
            for (let q = 0; q < 3; q++) c[q] = lerp(c[q], scarFresh[q], sm * 0.8);
            h -= 1.1 * sm;
            rough = lerp(rough, 0.32, sm);
          } else {
            for (let q = 0; q < 3; q++) c[q] = lerp(c[q], scarPale[q] * (0.5 + 0.5 * tBack) + belly[q] * 0.5 * (1 - tBack), sm * 0.55);
            h += 0.7 * sm;
            rough = lerp(rough, 0.66, sm);
          }
        }

        // Height detail: longitudinal denticle ridges and soft relief (the
        // isotropic skin grain is added after this pass, see below).
        const ridges = kd * noiseB.noise2(x / 38, (y * Ps) / H, Ps);
        h += 0.03 * ridges + 0.16 * mot + 0.05 * fine;
        rough += 0.02 * ridges;
      }

      height[i] = h;
      const o = i * 4;
      albedo[o] = clamp(c[0], 0, 1) * 255;
      albedo[o + 1] = clamp(c[1], 0, 1) * 255;
      albedo[o + 2] = clamp(c[2], 0, 1) * 255;
      albedo[o + 3] = 255;
      orm[o] = clamp(ao, 0, 1) * 255;
      orm[o + 1] = clamp(rough, 0.05, 1) * 255;
      orm[o + 2] = 0;
      orm[o + 3] = 255;
    }
    if (y & 1) yield 'rows';
  }

  // ---- isotropic skin grain: per-texel white noise, blurred once. Unlike
  // lattice value noise this has no grid structure, so it reads as fine
  // denticle texture under the wet specular instead of a pattern of dimples.
  // (Row-chunked so no single slice walks the whole 2048×1024 field.)
  giveScratch(scar, scarKind);
  {
    const rowsPerSlice = Math.max(4, Math.round(32768 / W)); // ~32k texels per slice
    const grain = takeScratch(Float32Array, W * H, false);
    let seed = (spec.seed * 2654435761) >>> 0;
    for (let y = 0; y < H; y++) {
      const r = y * W;
      for (let x = 0; x < W; x++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        grain[r + x] = ((seed >>> 0) / 4294967296) * 2 - 1;
      }
      if (y % rowsPerSlice === rowsPerSlice - 1) yield 'grain';
    }
    const tmp = takeScratch(Float32Array, W * H, false);
    for (let y = 0; y < H; y++) {
      const r = y * W;
      for (let x = 0; x < W; x++) {
        const xl = x > 0 ? x - 1 : x;
        const xr = x < W - 1 ? x + 1 : x;
        tmp[r + x] = (grain[r + xl] + 2 * grain[r + x] + grain[r + xr]) * 0.25;
      }
      if (y % rowsPerSlice === rowsPerSlice - 1) yield 'grain';
    }
    const amp = 0.16 * Math.min(1, size / 1024);
    for (let y = 0; y < H; y++) {
      const r = y * W;
      const ru = ((y + 1) % H) * W;
      const rd = ((y - 1 + H) % H) * W;
      for (let x = 0; x < W; x++) {
        // Fins and the unused strip get the grain too; it is subtle. Faded
        // toward the snout tip like the rest of the fine detail (colK).
        height[r + x] += amp * colK[x] * (tmp[rd + x] + 2 * tmp[r + x] + tmp[ru + x]) * 0.25;
      }
      if (y % rowsPerSlice === rowsPerSlice - 1) yield 'grain';
    }
    giveScratch(grain, tmp);
  }

  // ---- normal map from the height field (wraps around v, clamps along u)
  const normal = new Uint8Array(W * H * 4);
  yield 'alloc';
  const k = 1.5 * (size / 2048) + 0.5;
  for (let y = 0; y < H; y++) {
    const yu = ((y + 1) % H) * W;
    const yd = ((y - 1 + H) % H) * W;
    const yr = y * W;
    for (let x = 0; x < W; x++) {
      const xl = x > 0 ? x - 1 : x;
      const xr = x < W - 1 ? x + 1 : x;
      const nx = (height[yr + xl] - height[yr + xr]) * k;
      const ny = (height[yd + x] - height[yu + x]) * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (yr + x) * 4;
      normal[o] = (nx * inv * 0.5 + 0.5) * 255;
      normal[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      normal[o + 2] = (inv * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
    if ((y & 7) === 7) yield 'normal';
  }

  giveScratch(height);
  out.map = makeDataTexture(albedo, W, H, THREE.SRGBColorSpace, anisotropy);
  out.normalMap = makeDataTexture(normal, W, H, THREE.NoColorSpace, anisotropy);
  if (halfOrm) {
    // AO and roughness are low-frequency: half resolution (2×2 box) saves
    // ~8 MB of VRAM per species on high.
    const w2 = W >> 1;
    const h2 = H >> 1;
    const half = new Uint8Array(w2 * h2 * 4);
    for (let y = 0; y < h2; y++) {
      const r0 = 2 * y * W;
      const r1 = r0 + W;
      for (let x = 0; x < w2; x++) {
        const a = (r0 + 2 * x) * 4;
        const b = (r1 + 2 * x) * 4;
        const o = (y * w2 + x) * 4;
        half[o] = (orm[a] + orm[a + 4] + orm[b] + orm[b + 4] + 2) >> 2;
        half[o + 1] = (orm[a + 1] + orm[a + 5] + orm[b + 1] + orm[b + 5] + 2) >> 2;
        half[o + 3] = 255;
      }
      if ((y & 63) === 63) yield 'orm';
    }
    giveScratch(orm);
    out.ormMap = makeDataTexture(half, w2, h2, THREE.NoColorSpace, anisotropy);
  } else {
    out.ormMap = makeDataTexture(orm, W, H, THREE.NoColorSpace, anisotropy);
  }
}

// ---------------------------------------------------------------------------
// Shared detail normal (all species): a tiling patch of skin at a fixed
// physical size (DETAIL_TILE_M) — slightly domed denticle plates elongated
// along the body with fine grooves between them, coarse folds and thin healed
// micro-scratches. Blended into the skin normal by SharkAssets' shader patch
// at uv × (body metres / tile), fading out with view distance, so a 16 m
// flank seen from 4 m shows skin-scale detail instead of blurry texels.

const _detail = new Map(); // size → { gen, tex }

/** Advances (or reuses) the one shared detail-normal build; returns its texture. */
export function* ensureDetailNormal(size, anisotropy = 8) {
  let e = _detail.get(size);
  if (!e) {
    e = { gen: paintDetailNormal(size, anisotropy), tex: null };
    _detail.set(size, e);
  }
  // Several bundles may be building at once: each step advances the same
  // generator, whoever drives it.
  while (!e.tex) {
    const r = e.gen.next();
    if (r.done) e.tex = r.value;
    else yield r.value;
  }
  return e.tex;
}

/** Tileable cellular field: F1 / F2 distances (px) to jittered feature points. */
function worley(N, cells, ax, seed) {
  const rng = makeRng(seed);
  const cw = N / cells;
  const fx = new Float32Array(cells * cells);
  const fy = new Float32Array(cells * cells);
  for (let k = 0; k < cells * cells; k++) {
    const i = k % cells;
    const j = (k / cells) | 0;
    fx[k] = (i + 0.12 + 0.76 * rng()) * cw;
    fy[k] = (j + 0.12 + 0.76 * rng()) * cw;
  }
  return (x, y, out) => {
    const i0 = Math.floor(x / cw);
    const j0 = Math.floor(y / cw);
    let f1 = 1e12;
    let f2 = 1e12;
    for (let dj = -1; dj <= 1; dj++) {
      let jj = j0 + dj;
      let oy = 0;
      if (jj < 0) {
        jj += cells;
        oy = -N;
      } else if (jj >= cells) {
        jj -= cells;
        oy = N;
      }
      for (let di = -1; di <= 1; di++) {
        let ii = i0 + di;
        let ox = 0;
        if (ii < 0) {
          ii += cells;
          ox = -N;
        } else if (ii >= cells) {
          ii -= cells;
          ox = N;
        }
        const k = jj * cells + ii;
        const dx = (fx[k] + ox - x) * ax;
        const dy = fy[k] + oy - y;
        const d = dx * dx + dy * dy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
    }
    out[0] = Math.sqrt(f1);
    out[1] = Math.sqrt(f2);
    return out;
  };
}

function* paintDetailNormal(size, anisotropy) {
  const N = size;
  const h = new Float32Array(N * N);
  // Plates ≈ 9 mm (N / 40 per tile), squashed across the body so they run
  // lengthwise like denticle rows; folds ≈ 6 cm.
  const fine = worley(N, Math.max(8, Math.round(N / 13)), 0.72, 90210);
  const coarse = worley(N, 6, 0.8, 4711);
  const cwF = N / Math.max(8, Math.round(N / 13));
  const cwC = N / 6;
  const f = [0, 0];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      fine(x + 0.5, y + 0.5, f);
      const groove = smoothstep(0, 0.2 * cwF, f[1] - f[0]); // 0 in the seams
      const dome = 1 - Math.min(1, f[0] / (0.7 * cwF));
      let v = 0.55 * groove + 0.3 * dome * dome;
      coarse(x + 0.5, y + 0.5, f);
      v += 0.35 * smoothstep(0, 0.35 * cwC, f[1] - f[0]) - 0.2 * (f[0] / cwC);
      h[y * N + x] = v;
    }
    if ((y & 15) === 15) yield 'detail';
  }
  // Thin healed micro-scratches (2–10 cm), mostly lengthwise, wrapping.
  // Rasterised into their own buffer (strongest stroke wins) so the 1 px
  // steps along a stroke do not pile up.
  const scr = new Float32Array(N * N);
  const rng = makeRng(31337);
  const nScar = Math.round(N / 12);
  for (let s = 0; s < nScar; s++) {
    const len = N * (0.06 + rng() * 0.22);
    const ang = (rng() - 0.5) * 1.2 + (rng() < 0.25 ? Math.PI / 2 : 0);
    const hw = 0.6 + rng() * 1.1;
    const depth = (rng() < 0.6 ? 1 : -1) * (0.35 + rng() * 0.35);
    const x0 = rng() * N;
    const y0 = rng() * N;
    const steps = Math.ceil(len);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    for (let t = 0; t <= steps; t++) {
      const taper = Math.sin(Math.PI * (t / steps));
      const px = x0 + ca * t;
      const py = y0 + sa * t;
      const r = Math.ceil(hw + 1);
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          const d = Math.sqrt(ox * ox + oy * oy);
          if (d > hw + 0.5) continue;
          const xx = ((Math.round(px) + ox) % N + N) % N;
          const yy = ((Math.round(py) + oy) % N + N) % N;
          const m = (1 - smoothstep(hw * 0.4, hw + 0.5, d)) * taper * depth;
          const i = yy * N + xx;
          if (Math.abs(m) > Math.abs(scr[i])) scr[i] = m;
        }
      }
    }
    if ((s & 3) === 3) yield 'detail';
  }
  yield 'detail';
  for (let i = 0; i < N * N; i++) h[i] += 0.3 * scr[i];
  yield 'detail';
  // Height → tangent-space normal (fully wrapping).
  const data = new Uint8Array(N * N * 4);
  const k = 2.2;
  for (let y = 0; y < N; y++) {
    const yu = ((y + 1) % N) * N;
    const yd = ((y - 1 + N) % N) * N;
    const yr = y * N;
    for (let x = 0; x < N; x++) {
      const xl = (x - 1 + N) % N;
      const xr = (x + 1) % N;
      const nx = (h[yr + xl] - h[yr + xr]) * k;
      const ny = (h[yd + x] - h[yu + x]) * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (yr + x) * 4;
      data[o] = (nx * inv * 0.5 + 0.5) * 255;
      data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      data[o + 2] = (inv * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
    if ((y & 31) === 31) yield 'detail';
  }
  const tex = makeDataTexture(data, N, N, THREE.NoColorSpace, anisotropy);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.name = 'shark-detail-normal';
  return tex;
}

/**
 * Eye texture for a three.js SphereGeometry: the front hemisphere (+Z) is the
 * black, glossy iris/pupil; the back is the pale sclera revealed when the eye
 * rolls back during a bite.
 */
export function paintEye(size = 128) {
  const W = size;
  const H = size >> 1;
  const data = new Uint8Array(W * H * 4);
  const noise = new ValueNoise(77);
  for (let y = 0; y < H; y++) {
    // SphereGeometry: uv.y = 1 - v, theta = v * PI.
    const vt = (y + 0.5) / H;
    const thetaS = (1 - vt) * Math.PI;
    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W) * Math.PI * 2;
      const dz = Math.sin(phi) * Math.sin(thetaS);
      let r;
      let g;
      let b;
      const veins = smoothstep(0.55, 0.9, noise.fbm2(x * 0.25, y * 0.25, 3) * 0.5 + 0.5);
      if (dz > -0.2) {
        // Iris: near-black with a faint blue-grey ring, pupil pure black.
        const ring = smoothstep(0.55, 0.8, dz) * (1 - smoothstep(0.86, 0.95, dz));
        const streak = 0.5 + 0.5 * noise.noise2(Math.atan2(Math.cos(thetaS), Math.cos(phi)) * 12, dz * 3);
        r = 0.025 + 0.03 * ring * streak;
        g = 0.03 + 0.04 * ring * streak;
        b = 0.04 + 0.06 * ring * streak;
        const edge = smoothstep(-0.2, -0.05, dz);
        r = lerp(0.45, r, edge);
        g = lerp(0.42, g, edge);
        b = lerp(0.42, b, edge);
      } else {
        // Sclera: off-white with pink veins.
        r = 0.82 - 0.05 * veins + 0.06 * veins;
        g = 0.8 - 0.25 * veins;
        b = 0.78 - 0.24 * veins;
      }
      const o = (y * W + x) * 4;
      data[o] = clamp(r, 0, 1) * 255;
      data[o + 1] = clamp(g, 0, 1) * 255;
      data[o + 2] = clamp(b, 0, 1) * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
