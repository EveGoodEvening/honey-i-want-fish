// 老公's head: a stack of horizontal superellipse sections (chin → crown)
// sculpted with Gaussian features (brow ridge, sockets, nose, cheekbones and
// the lean cheeks under them, nasolabial folds, lips, chin, jaw angle), plus
// ears and eyes. The skin/hair/stubble/brow texture is painted procedurally in
// the same (θ, y) parameterisation as the UVs, so it lines up with the sculpt
// exactly: a weathered tan with blotches and a day's beard, and a bump map of
// pores, creases and wrinkles. Original character — no likeness. Preview the
// sculpt in seconds without a browser: node scripts/player-headview.mjs.
//
// Head-local frame: origin between the ear canals, +Y up, +Z face, +X left.
import * as THREE from 'three';
import { buildLoft, mergeParts } from './loft.js';
import { gauss, sampleScalar, smoothstep, saturate, clamp, noise3, fbm3, TAU } from './math.js';

// Head-local origin in bind model space (feet at 0, top of head ≈ 1.757).
export const HEAD_ORIGIN = new THREE.Vector3(0, 1.637, 0.006);

// [y, cz, rFront, rBack, halfWidth, exponent]
// The lower face tapers from the cheekbones to a narrower jaw (bigonial
// ≈ 11.5 cm), the crown is domed, and the sections stay closer to elliptical
// (exponent ≤ 2.5): wide, squarish sections from the jaw to a flat crown read
// as a box with a face painted on.
const TABLE = [
  [-0.117, 0.07, 0.009, 0.006, 0.013, 2.4],
  [-0.112, 0.06, 0.026, 0.016, 0.027, 2.45],
  [-0.104, 0.048, 0.04, 0.028, 0.039, 2.5],
  [-0.094, 0.033, 0.056, 0.034, 0.0495, 2.5],
  [-0.08, 0.016, 0.074, 0.04, 0.0575, 2.45],
  [-0.064, 0.005, 0.087, 0.044, 0.0625, 2.4],
  [-0.048, 0.0, 0.094, 0.056, 0.0665, 2.35],
  [-0.032, 0.0, 0.094, 0.075, 0.0705, 2.3],
  [-0.014, 0.002, 0.092, 0.093, 0.0735, 2.25],
  [0.004, 0.004, 0.091, 0.103, 0.0755, 2.2],
  [0.022, 0.004, 0.091, 0.107, 0.077, 2.2],
  [0.042, 0.001, 0.089, 0.108, 0.078, 2.2],
  [0.062, -0.003, 0.084, 0.106, 0.0775, 2.2],
  [0.08, -0.007, 0.075, 0.099, 0.0718, 2.15],
  [0.094, -0.01, 0.062, 0.087, 0.0615, 2.1],
  [0.104, -0.012, 0.046, 0.068, 0.049, 2.1],
  [0.111, -0.013, 0.028, 0.044, 0.032, 2.05],
  [0.1145, -0.013, 0.011, 0.017, 0.0125, 2.0],
  [0.1153, -0.013, 0.0004, 0.0004, 0.0004, 2.0],
];
export const HEAD_Y_MIN = TABLE[0][0];
export const HEAD_Y_MAX = TABLE[TABLE.length - 1][0];

const COL = (c) => TABLE.map((r) => [r[0], r[c]]);
const T_CZ = COL(1);
const T_RF = COL(2);
const T_RB = COL(3);
const T_WX = COL(4);
const T_E = COL(5);

// Nose projection (m) and angular width as functions of height.
const NOSE = [
  [0.036, 0],
  [0.026, 0.0025],
  [0.014, 0.0065],
  [0.002, 0.011],
  [-0.01, 0.016],
  [-0.021, 0.0215],
  [-0.03, 0.0235],
  [-0.037, 0.017],
  [-0.042, 0.007],
  [-0.047, 0.0005],
  [-0.05, 0],
];
const NOSE_W = [
  [0.03, 0.07],
  [0.012, 0.075],
  [-0.01, 0.085],
  [-0.025, 0.11],
  [-0.035, 0.15],
  [-0.045, 0.19],
];

export function sectionAt(y) {
  return {
    cz: sampleScalar(T_CZ, y),
    rf: sampleScalar(T_RF, y),
    rb: sampleScalar(T_RB, y),
    wx: sampleScalar(T_WX, y),
    e: sampleScalar(T_E, y),
  };
}

/** Radial sculpt offset (m) at angle θ (0 = face front) and height y. */
export function faceBump(th, y) {
  const a = Math.abs(th);
  let b = 0;
  // nose + nostril wings
  if (y > -0.055 && y < 0.04) {
    b += sampleScalar(NOSE, y) * gauss(th, 0, sampleScalar(NOSE_W, y));
    b += 0.0072 * gauss(a, 0.17, 0.065) * gauss(y, -0.035, 0.0052); // alae
    b -= 0.0022 * gauss(a, 0.25, 0.04) * gauss(y, -0.03, 0.008); // alar crease
  }
  // eye sockets (almond, slightly downturned at the outer corner)
  b -= 0.0095 * gauss(a, 0.41, 0.16) * gauss(y, 0.006 - (a - 0.41) * 0.01, 0.0105);
  // tear trough under the inner eye; the lower lid puffs a little with age
  b -= 0.0012 * gauss(a, 0.3, 0.09) * gauss(y, -0.011, 0.004);
  b += 0.0009 * gauss(a, 0.46, 0.12) * gauss(y, -0.0075, 0.0035);
  // brow: a supraorbital ridge that drops and thickens toward the outer third
  // (it shades the eyes), the glabella, and a soft step above it so it reads
  // as bone rather than a rolled forehead
  b += 0.0062 * gauss(a, 0.38, 0.27) * gauss(y, browRidgeY(a), 0.0075);
  b += 0.0026 * gauss(th, 0, 0.11) * gauss(y, 0.019, 0.009);
  b -= 0.0012 * gauss(a, 0.3, 0.3) * gauss(y, 0.04, 0.008);
  // cheekbones (zygoma and its arch back toward the ear), lean cheeks under them
  b += 0.0055 * gauss(a, 0.88, 0.2) * gauss(y, -0.006, 0.013);
  b += 0.0028 * gauss(a, 1.2, 0.15) * gauss(y, -0.004, 0.0065);
  b -= 0.0012 * gauss(a, 0.92, 0.24) * gauss(y, -0.045, 0.014);
  // temples
  b -= 0.0028 * gauss(a, 1.12, 0.2) * gauss(y, 0.034, 0.016);
  // nasolabial fold: a shallow groove from the nose wing past the mouth
  // corner, the cheek a little full beside it (the texture carries most of it;
  // a deep carved fold reads as a puppet's mouth)
  if (y < -0.022 && y > -0.082) {
    const w = smoothstep(-0.022, -0.03, y) * smoothstep(-0.082, -0.072, y);
    const la = nasolabialA(y);
    b -= 0.0007 * w * gauss(a, la, 0.035);
    b += 0.001 * w * gauss(a, la + 0.09, 0.06);
  }
  // lips, mouth line, corners, sulcus, chin
  const ym = mouthLine(a);
  const lw = Math.max(0, 1 - (a / 0.29) ** 2);
  const lwLow = Math.max(0, 1 - (a / 0.25) ** 2); // the lower lip is the shorter, fuller one
  b += 0.0031 * Math.sqrt(lw) * gauss(y, ym + 0.0038, 0.0032); // upper lip
  b += 0.0034 * lwLow * gauss(y, ym - 0.0052, 0.004); // lower lip
  b += 0.0012 * gauss(a, 0, 0.3) * gauss(y, -0.049, 0.006); // skin lip over the teeth
  b -= 0.0024 * gauss(a, 0, 0.32) * gauss(y, ym, 0.0013); // mouth line
  b -= 0.0018 * gauss(a, 0.3, 0.055) * gauss(y, mouthLine(0.3), 0.005); // tucked corners
  b -= 0.0012 * gauss(th, 0, 0.05) * gauss(y, -0.046, 0.004); // philtrum
  b -= 0.0028 * gauss(th, 0, 0.2) * gauss(y, -0.081, 0.0055); // mentolabial sulcus
  b += 0.0055 * gauss(th, 0, 0.3) * gauss(y, -0.097, 0.01); // chin
  b += 0.0018 * gauss(a, 0.24, 0.1) * gauss(y, -0.1, 0.007); // its two tubercles: a squarer chin
  // jaw: the angle and the masseter (the lower sections taper to the chin;
  // a ridge along the jaw border reads as a strap in profile)
  b += 0.0035 * gauss(a, 1.42, 0.18) * gauss(y, -0.07, 0.01);
  b += 0.0016 * gauss(a, 1.22, 0.2) * gauss(y, -0.048, 0.014);
  // short hair rises slightly above the scalp at the hairline
  b += 0.0022 * hairMask(th, y, 0);
  return b;
}

/** Height of the brow ridge's crest: level over the eye, lower at the outer end. */
export function browRidgeY(a) {
  return 0.0225 - 0.006 * smoothstep(0.35, 0.75, a);
}

/** |θ| of the nasolabial fold at height y (nose wing → past the mouth corner). */
export function nasolabialA(y) {
  return 0.21 + 0.15 * clamp((-y - 0.03) / 0.04, 0, 1);
}

/** Height of the mouth line; corners turn slightly down (a stern mouth). */
export function mouthLine(a) {
  return -0.0615 - 0.0035 * (a / 0.28) ** 2;
}

// Hairline height as a function of |θ| (front → back). Short crop, slightly
// receding temples, sideburns, neat line above the ears, nape at the back.
const HAIRLINE = [
  [0.0, 0.071],
  [0.35, 0.073],
  [0.62, 0.079],
  [0.9, 0.062],
  [1.12, 0.03],
  [1.25, -0.006],
  [1.36, -0.006],
  [1.44, 0.028],
  [1.62, 0.036],
  [1.85, 0.03],
  [2.1, -0.02],
  [2.5, -0.05],
  [Math.PI, -0.058],
];

export function hairMask(th, y, jitter) {
  const hl = sampleScalar(HAIRLINE, Math.abs(th)) + jitter;
  return smoothstep(hl - 0.0035, hl + 0.0035, y);
}

/** Builds the head + ears geometry (rigid, head-local coordinates). */
export function buildHeadGeometry(quality) {
  const seg = quality === 'low' ? 56 : quality === 'medium' ? 84 : 112;
  const rowsN = quality === 'low' ? 44 : quality === 'medium' ? 60 : 78;
  const ys = rowDistribution(rowsN);
  const rings = [];
  for (let i = 0; i <= rowsN; i++) {
    const y = ys[i];
    const sec = sectionAt(y);
    rings.push({
      c: new THREE.Vector3(0, y, sec.cz),
      ax: new THREE.Vector3(1, 0, 0),
      az: new THREE.Vector3(0, 0, 1),
      rx: Math.max(0.0004, sec.wx),
      rzf: Math.max(0.0004, sec.rf),
      rzb: Math.max(0.0004, sec.rb),
      e: sec.e,
      y,
    });
  }
  const head = buildLoft({
    rings,
    seg,
    // ~2.3× angular density across the face, sparser at the back of the skull
    thetaFn: (t) => {
      const u = 2 * t - 1;
      return Math.PI * (0.42 * u + 0.58 * u * u * u);
    },
    bump: (i, th, ring) => faceBump(th, ring.y),
    uv: (i, th, p) => [(th + Math.PI) / TAU, (rings[i].y - HEAD_Y_MIN) / (HEAD_Y_MAX - HEAD_Y_MIN)],
  });

  const parts = [head];
  for (const side of [1, -1]) parts.push(buildEar(side), ...buildEyelids(side));
  return mergeParts(parts);
}

/** Row heights: dense at chin and crown, and through the eyes/nose/mouth. */
function rowDistribution(n) {
  const N = 2000;
  const dens = new Float64Array(N + 1);
  let total = 0;
  for (let k = 0; k <= N; k++) {
    const y = HEAD_Y_MIN + ((HEAD_Y_MAX - HEAD_Y_MIN) * k) / N;
    const t = (y - HEAD_Y_MIN) / (HEAD_Y_MAX - HEAD_Y_MIN);
    const ends = 1 / Math.max(0.25, Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, t))));
    dens[k] = 0.6 * Math.min(4, ends) + 1.6 * gauss(y, -0.035, 0.04);
    if (k > 0) total += (dens[k] + dens[k - 1]) * 0.5;
  }
  const out = [HEAD_Y_MIN];
  let acc = 0;
  let next = total / n;
  for (let k = 1; k <= N && out.length < n; k++) {
    const step = (dens[k] + dens[k - 1]) * 0.5;
    while (acc + step >= next && out.length < n) {
      const f = (next - acc) / step;
      out.push(HEAD_Y_MIN + ((HEAD_Y_MAX - HEAD_Y_MIN) * (k - 1 + f)) / N);
      next += total / n;
    }
    acc += step;
  }
  out.push(HEAD_Y_MAX);
  return out;
}

const EYE_R = 0.0112;
const EYE_POS = (side) => new THREE.Vector3(side * 0.0315, 0.0062, 0.0705);

/**
 * Upper and lower eyelids: thin spherical caps hugging each eyeball. The upper
 * lid hangs low for a tired, hooded look. UVs point at the painted lid skin,
 * the rim row at the dark lash line.
 */
function buildEyelids(side) {
  const parts = [];
  const lid = (thetaStart, thetaLen, tiltX, rimAtStart) => {
    const g = new THREE.SphereGeometry(EYE_R + 0.0011, 18, 6, 0, Math.PI * 2, thetaStart, thetaLen);
    const uv = g.attributes.uv;
    const pos = g.attributes.position;
    const skinU = (side * 0.41 + Math.PI) / TAU;
    const skinV = (0.012 - HEAD_Y_MIN) / (HEAD_Y_MAX - HEAD_Y_MIN); // shadowed socket skin
    const lashV = (0.0065 - HEAD_Y_MIN) / (HEAD_Y_MAX - HEAD_Y_MIN);
    for (let i = 0; i < uv.count; i++) {
      // polar angle of this vertex
      const th = Math.acos(Math.max(-1, Math.min(1, pos.getY(i) / (EYE_R + 0.0011))));
      const edge = rimAtStart ? Math.abs(th - thetaStart) : Math.abs(th - (thetaStart + thetaLen));
      uv.setXY(i, skinU, edge < 0.32 ? lashV : skinV);
    }
    g.rotateX(tiltX);
    g.rotateY(side * 0.06);
    g.translate(...EYE_POS(side).toArray());
    return g;
  };
  parts.push(lid(0, 1.12, 0.27, false)); // upper: front edge ~10° above the iris centre
  parts.push(lid(Math.PI - 0.95, 0.95, -0.18, true)); // lower
  return parts;
}

/**
 * A simple but believable ear: a cupped, flattened shell lofted from the
 * attached front edge to the free back edge, set against the side of the
 * head with the back edge flared out ~20°.
 */
function buildEar(side) {
  const rings = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const h = 0.0315 * Math.pow(Math.max(0, 1 - Math.pow(t, 2.4)), 0.55) + 0.0008;
    rings.push({
      c: new THREE.Vector3(0, 0.003 + t * 0.003, -t * 0.021),
      ax: new THREE.Vector3(side, 0, 0), // thickness, +ax = outer face
      az: new THREE.Vector3(0, 1, 0),
      rx: 0.0026 + 0.0022 * Math.sin(Math.PI * Math.min(1, t * 1.2)),
      rzf: h * 0.56,
      rzb: h * 0.44,
      e: 2.3,
      t,
    });
  }
  const g = buildLoft({
    rings,
    seg: 18,
    capStart: true,
    // concha: a hollow in the middle of the outer face
    bump: (i, th, ring) => -0.0022 * gauss(th, Math.PI / 2, 0.55) * Math.sin(Math.PI * ring.t),
    uv: () => [side > 0 ? 0.75 : 0.25, 0.47],
  });
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -side * 0.36, 0, 'YXZ'));
  const m = new THREE.Matrix4().compose(new THREE.Vector3(side * 0.071, 0.002, -0.002), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Two eyeballs (merged), head-local. Iris faces +Z. */
export function buildEyesGeometry() {
  const parts = [];
  for (const side of [1, -1]) {
    const g = new THREE.SphereGeometry(EYE_R, 20, 14);
    g.rotateY(side * 0.06);
    g.translate(...EYE_POS(side).toArray());
    parts.push(g);
  }
  return mergeParts(parts);
}

export function makeEyeTexture() {
  const w = 128;
  const h = 64;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // sphere uv: u = 0.25 → +Z, v = 0.5 → equator
      const du = (x / w - 0.25) * TAU;
      const dv = (y / h - 0.5) * Math.PI;
      const d = Math.sqrt(du * du + dv * dv);
      // sclera: off-white, shaded toward the edges and reddened in the corners
      // (a tired man's eyes). The iris spans ≈ 31° of the eyeball (12 mm): a
      // wider dark iris leaves no white showing and reads as a doll's eyes.
      const shade = 0.82 + 0.18 * saturate(1 - d / 1.6);
      const corner = smoothstep(0.7, 1.3, Math.abs(du));
      let r = 0.6 * shade;
      let g = 0.57 * shade * (1 - 0.1 * corner);
      let b = 0.52 * shade * (1 - 0.12 * corner);
      const iris = smoothstep(0.58, 0.5, d);
      const fib = (0.8 + 0.2 * Math.sin(Math.atan2(dv, du) * 23)) * (1 - 0.45 * gauss(d, 0.53, 0.035)); // + limbal ring
      r = r * (1 - iris) + 0.24 * fib * iris;
      g = g * (1 - iris) + 0.155 * fib * iris;
      b = b * (1 - iris) + 0.09 * fib * iris;
      const pupil = smoothstep(0.24, 0.19, d);
      r *= 1 - pupil * 0.92;
      g *= 1 - pupil * 0.92;
      b *= 1 - pupil * 0.92;
      const i = (y * w + x) * 4;
      data[i] = r * 255;
      data[i + 1] = g * 255;
      data[i + 2] = b * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Head texture width per quality (height is half). The head covers a few
 *  percent of the screen in the follow camera; 512 holds up in close-ups. */
export const HEAD_TEX_SIZE = { low: 256, medium: 512, high: 512 };

/**
 * Paints the head: weathered skin, salt-and-pepper short hair, stubble,
 * eyebrows, lips, socket shadows; plus a bump map (hair, stubble, wrinkles,
 * pores) and a roughness map whose R channel holds cavity occlusion (use it
 * as the aoMap too). `size` is a quality name or a texture width.
 * Returns { map, bumpMap, roughnessMap }.
 */
export function makeHeadTextures(size) {
  const gen = paintHeadTextures(typeof size === 'number' ? size : HEAD_TEX_SIZE[size] ?? 512);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/**
 * Generator version of makeHeadTextures for a texture width W: yields every
 * few rows so the painting can be spread over idle time; returns the textures.
 */
export function* paintHeadTextures(W) {
  const H = W / 2;
  const ROWS_PER_SLICE = Math.max(1, Math.round(2048 / W));
  const col = new Uint8Array(W * H * 4);
  const bmp = new Uint8Array(W * H * 4);
  const rgh = new Uint8Array(W * H * 4);
  const p = new THREE.Vector3();

  for (let iy = 0; iy < H; iy++) {
    const v = (iy + 0.5) / H;
    const y = HEAD_Y_MIN + v * (HEAD_Y_MAX - HEAD_Y_MIN);
    const sec = sectionAt(y);
    for (let ix = 0; ix < W; ix++) {
      const u = (ix + 0.5) / W;
      const th = u * TAU - Math.PI;
      const a = Math.abs(th);
      const c = Math.cos(th);
      p.set(Math.sin(th) * sec.wx, y, sec.cz + c * (c >= 0 ? sec.rf : sec.rb));
      const n1 = fbm3(p.x * 40, p.y * 40, p.z * 40, 3); // blotches
      const nFine = noise3(p.x * 900, p.y * 900, p.z * 900);
      const nMid = noise3(p.x * 260, p.y * 260, p.z * 260);

      // --- skin base: weathered, sun-darkened, slightly ruddy -------------
      // (a fisherman's tan: darker and warmer than a pale base, which the
      // strong cyan water fill turns into a plaster-white mask)
      let r = 0.55 + n1 * 0.05;
      let g = 0.39 + n1 * 0.04;
      let b = 0.305 + n1 * 0.035;
      const ruddy =
        0.6 * gauss(a, 0, 0.12) * gauss(y, -0.028, 0.012) + // nose tip
        0.35 * gauss(a, 0.72, 0.25) * gauss(y, -0.022, 0.016) + // cheeks
        0.25 * gauss(a, 1.57, 0.2); // around ears
      r += ruddy * 0.06;
      g -= ruddy * 0.015;
      b -= ruddy * 0.01;
      // sun-weathered forehead slightly darker / browner
      const fore = gauss(y, 0.05, 0.02) * gauss(a, 0, 0.7);
      r -= fore * 0.03;
      g -= fore * 0.03;
      b -= fore * 0.03;
      // years of sun and salt: uneven, blotchy colour and a few faint sun
      // spots on the forehead and temples (an even tone is what makes a face
      // read as a mannequin; spots on the cheeks smudge their shading)
      const nBlot = noise3(p.x * 95 + 5, p.y * 95, p.z * 95);
      r += nBlot * 0.022;
      g += nBlot * 0.01;
      b += nBlot * 0.005;
      const spotW = saturate(gauss(y, 0.045, 0.025));
      if (spotW > 0.02) {
        const spot = smoothstep(0.5, 0.72, noise3(p.x * 150 + 11, p.y * 150, p.z * 150)) * spotW;
        r *= 1 - spot * 0.035;
        g *= 1 - spot * 0.05;
        b *= 1 - spot * 0.06;
      }

      let bump = 0.5 + nMid * 0.03 + nFine * 0.02; // pores
      // open pores over the nose and the cheeks
      bump -= 0.035 * smoothstep(0.35, 0.75, nFine) * saturate(gauss(a, 0, 0.16) * gauss(y, -0.02, 0.02) + gauss(a, 0.7, 0.3) * gauss(y, -0.025, 0.02));
      let rough = 0.55 - gauss(a, 0, 0.35) * gauss(y, 0.03, 0.04) * 0.08; // oily T-zone

      // --- socket shadow + lash line ---------------------------------------
      const eyeY = 0.0065 - (a - 0.41) * 0.01;
      const ed = Math.sqrt(((a - 0.405) / 0.155) ** 2 + ((y - eyeY) / 0.0068) ** 2);
      const socket = gauss(a, 0.41, 0.2) * gauss(y, 0.004, 0.013);
      r *= 1 - socket * 0.13;
      g *= 1 - socket * 0.15;
      b *= 1 - socket * 0.11;
      // tired, darker skin under the eyes
      const under = gauss(a, 0.4, 0.14) * gauss(y, -0.0095, 0.0045);
      r *= 1 - under * 0.1;
      g *= 1 - under * 0.13;
      b *= 1 - under * 0.08;
      const lash = smoothstep(1.35, 1.0, ed) * smoothstep(0.7, 1.0, ed);
      r *= 1 - lash * 0.55;
      g *= 1 - lash * 0.58;
      b *= 1 - lash * 0.55;
      // eye bags, and two fine lines under each
      bump -= 0.08 * gauss(a, 0.42, 0.13) * gauss(y, -0.006, 0.003);
      {
        const ue = y - (eyeY - 0.012 + 0.01 * ((a - 0.42) / 0.2) ** 2);
        if (ue < 0.001 && ue > -0.009) bump -= 0.06 * gauss(a, 0.45, 0.13) * Math.abs(Math.sin((ue * TAU) / 0.0042)) ** 8;
      }

      // --- lips ---------------------------------------------------------------
      const ym = mouthLine(a);
      const lw = Math.max(0, 1 - (a / 0.28) ** 2);
      const hu = 0.0068 * Math.sqrt(lw) - 0.0012 * gauss(a, 0, 0.035); // cupid's bow
      const hl = 0.0085 * Math.sqrt(lw);
      const dy = y - ym;
      const lipU = dy >= 0 ? smoothstep(hu, hu * 0.6, dy) : 0;
      const lipL = dy < 0 ? smoothstep(hl, hl * 0.55, -dy) : 0;
      const lip = Math.max(lipU, lipL) * smoothstep(0.3, 0.24, a);
      r = r * (1 - lip) + r * 0.93 * lip;
      g = g * (1 - lip) + g * 0.78 * lip;
      b = b * (1 - lip) + b * 0.8 * lip;
      const mline = gauss(dy, 0, 0.0009) * smoothstep(0.32, 0.22, a);
      r *= 1 - 0.45 * mline;
      g *= 1 - 0.5 * mline;
      b *= 1 - 0.5 * mline;
      // nostrils
      const nost = gauss(a, 0.085, 0.035) * gauss(y, -0.041, 0.0028);
      r *= 1 - 0.6 * nost;
      g *= 1 - 0.65 * nost;
      b *= 1 - 0.65 * nost;
      rough -= lip * 0.1;

      // --- stubble: jaw, chin, upper lip; short, dark, salted with grey -------
      let stub = smoothstep(-0.03, -0.05, y) * (1 - smoothstep(1.2, 1.48, a));
      stub = Math.max(stub, smoothstep(0.36, 0.26, a) * smoothstep(-0.036, -0.044, y)); // moustache
      stub = Math.max(stub, smoothstep(-0.085, -0.1, y) * smoothstep(1.75, 1.3, a)); // under the jaw
      stub *= 1 - lip;
      stub *= 1 - gauss(a, 0, 0.16) * gauss(y, -0.03, 0.01); // not on the nose
      stub *= 0.75 + 0.25 * noise3(p.x * 90, p.y * 90, p.z * 90); // patchy
      if (stub > 0.01) {
        const shade = 0.86; // the grey-blue cast of a day's beard under the skin
        r *= 1 - stub * (1 - shade);
        g *= 1 - stub * (1 - shade * 0.99);
        b *= 1 - stub * (1 - shade * 1.01);
        const dot = smoothstep(0.42, 0.72, nFine) * stub;
        const grey = noise3(p.x * 700 + 9, p.y * 700, p.z * 700) > 0.35;
        const hr = grey ? 0.42 : 0.16;
        const hg = grey ? 0.41 : 0.13;
        const hb = grey ? 0.4 : 0.12;
        r = r * (1 - dot * 0.6) + hr * dot * 0.6;
        g = g * (1 - dot * 0.6) + hg * dot * 0.6;
        b = b * (1 - dot * 0.6) + hb * dot * 0.6;
        bump += dot * 0.06;
        rough += stub * 0.08;
      }

      // --- eyebrows -----------------------------------------------------------
      if (a > 0.06 && a < 0.72) {
        // a full, soft-edged mass of hair, not a drawn line of strands (that
        // reads as stitching on a doll at game distances)
        const tb = (a - 0.08) / 0.56;
        const by = 0.0262 + 0.0042 * Math.sin(saturate(tb) * Math.PI * 0.9) - 0.002 * tb;
        const thick = 0.0062 - 0.003 * saturate(tb);
        const strands = 0.78 + 0.22 * noise3(p.x * 1400, p.y * 500, p.z * 1400);
        const brow = smoothstep(thick, thick * 0.2, Math.abs(y - by)) * smoothstep(0.06, 0.13, a) * smoothstep(0.72, 0.6, a) * strands;
        const grey = noise3(p.x * 900, p.y * 900 + 4, p.z * 900) > 0.62 ? 0.16 : 0; // a few grey hairs
        r = r * (1 - brow) + (0.08 + grey) * brow;
        g = g * (1 - brow) + (0.07 + grey) * brow;
        b = b * (1 - brow) + (0.065 + grey * 0.95) * brow;
        bump += brow * 0.15;
        rough += brow * 0.2;
      }

      // --- hair: short crop, salt and pepper (greyer at the temples) -----------
      const jitter = (noise3(p.x * 180, p.y * 180, p.z * 180) * 0.0028 + noise3(p.x * 700, p.y * 700, p.z * 700) * 0.0012);
      const hair = hairMask(th, y, jitter);
      if (hair > 0.001) {
        // short strands lie back on top and down at the sides: stretch the noise
        const strand = noise3(p.x * 1100, p.y * 420 + p.z * 200, p.z * 1100);
        const greyAmt = 0.06 + 0.32 * gauss(a, 1.45, 0.4) + 0.05 * smoothstep(0.08, 0.11, y);
        const greyN = noise3(p.x * 800 + 3, p.y * 300, p.z * 800) * 0.5 + 0.5;
        const isGrey = greyN < greyAmt;
        let hr = 0.055 + strand * 0.012;
        let hg = 0.05 + strand * 0.011;
        let hb = 0.047 + strand * 0.01;
        if (isGrey) {
          const k = smoothstep(greyAmt, greyAmt - 0.08, greyN);
          hr += k * 0.22;
          hg += k * 0.215;
          hb += k * 0.21;
        }
        // scalp shows through at the edges of a short crop
        const dens = smoothstep(0, 0.9, hair) * (0.84 + 0.16 * saturate(strand + 0.5));
        r = r * (1 - dens) + hr * dens;
        g = g * (1 - dens) + hg * dens;
        b = b * (1 - dens) + hb * dens;
        bump += hair * (0.12 + strand * 0.12);
        rough = rough * (1 - hair) + 0.72 * hair;
      }

      // --- cavity occlusion (R of the roughness map, used as the aoMap) --------
      // Underwater the face is lit mostly by the diffuse water fill; without
      // occlusion in the sockets, around the nose, mouth and under the jaw it
      // reads flat, like a mannequin. Follows the sculpt in faceBump().
      let ao = 1;
      ao -= 0.4 * gauss(a, 0.41, 0.17) * gauss(y, 0.004, 0.011); // eye sockets (and the lids)
      ao -= 0.35 * gauss(a, 0.2, 0.07) * gauss(y, 0.002, 0.01); // inner corners beside the bridge
      ao -= 0.2 * gauss(a, 0.42, 0.22) * gauss(y, browRidgeY(a) - 0.007, 0.004); // under the brow ridge
      ao -= 0.45 * gauss(a, 0.22, 0.05) * gauss(y, -0.034, 0.008); // around the nose wings
      ao -= 0.7 * nost + 0.5 * mline; // nostrils, mouth line
      ao -= 0.22 * gauss(a, 0.3, 0.05) * gauss(y, mouthLine(0.3), 0.004); // mouth corners
      ao -= 0.3 * gauss(th, 0, 0.22) * gauss(y, -0.08, 0.006); // under the lower lip
      ao -= 0.3 * smoothstep(-0.088, -0.11, y) * smoothstep(1.9, 1.2, a); // under the jaw
      ao -= 0.18 * gauss(a, 1.12, 0.2) * gauss(y, 0.036, 0.016); // temples
      ao -= 0.25 * gauss(a, 1.5, 0.12) * gauss(y, -0.005, 0.03); // where the ears meet the head

      // --- wrinkles and weathering (bump only) -----------------------------------
      // forehead lines: shallow and broken (under the top-down sun a full-width
      // ribbing reads as a corrugated mask, not skin)
      if (a < 0.8 && y > 0.036 && y < 0.07) {
        const lines = Math.pow(Math.abs(Math.sin((y + noise3(p.x * 60, 0, p.z * 60) * 0.002) * (TAU / 0.0078))), 6);
        const broken = smoothstep(-0.2, 0.4, noise3(p.x * 90 + 3, p.y * 40, p.z * 90));
        bump -= lines * 0.07 * broken * smoothstep(0.8, 0.3, a) * (1 - hair);
      }
      // two short frown lines between the brows
      bump -= 0.1 * gauss(a, 0.055, 0.012) * gauss(y, 0.029, 0.008);
      // sun-cracked cheeks: a fine cross-hatch of creases
      if (a > 0.45 && a < 1.4 && y > -0.07 && y < 0.002) {
        const k = 2400;
        const w = nMid * 2;
        const xh = Math.abs(Math.sin((p.x * 0.8 + p.y) * k + w)) ** 10 + Math.abs(Math.sin((p.x * 0.8 - p.y) * k - w)) ** 10;
        bump -= 0.028 * xh * gauss(a, 0.9, 0.25) * gauss(y, -0.03, 0.02);
      }
      // crow's feet
      {
        const dx = a - 0.6;
        const dy = y - 0.006;
        if (dx > 0 && dx < 0.12 && Math.abs(dy) < 0.012) {
          const ang = Math.atan2(dy, dx * 0.09);
          bump -= Math.pow(Math.abs(Math.sin(ang * 6)), 8) * 0.1 * smoothstep(0.12, 0.02, dx);
        }
      }
      // nasolabial folds (follow the sculpted groove, see nasolabialA)
      if (y < -0.026 && y > -0.074) {
        const t = clamp((-y - 0.03) / 0.04, 0, 1);
        const fold = smoothstep(0.03, 0.0, Math.abs(a - nasolabialA(y))) * (1 - Math.abs(t - 0.4));
        bump -= fold * 0.12;
        ao -= fold * 0.26;
      }

      const i = (iy * W + ix) * 4;
      col[i] = clamp(r, 0, 1) * 255;
      col[i + 1] = clamp(g, 0, 1) * 255;
      col[i + 2] = clamp(b, 0, 1) * 255;
      col[i + 3] = 255;
      const bb = clamp(bump, 0, 1) * 255;
      bmp[i] = bb;
      bmp[i + 1] = bb;
      bmp[i + 2] = bb;
      bmp[i + 3] = 255;
      const rr = clamp(rough, 0, 1) * 255;
      rgh[i] = clamp(ao, 0.3, 1) * 255; // three: aoMap reads R, roughnessMap G
      rgh[i + 1] = rr;
      rgh[i + 2] = rr;
      rgh[i + 3] = 255;
    }
    if ((iy + 1) % ROWS_PER_SLICE === 0) yield;
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(col, true), bumpMap: mk(bmp, false), roughnessMap: mk(rgh, false) };
}
