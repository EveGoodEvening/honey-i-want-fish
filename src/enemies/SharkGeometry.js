// Procedural shark geometry: one skinned BufferGeometry (group 0 = skin:
// lofted body + lower jaw + fins, group 1 = mouth interior: gums, palate,
// tongue floor, throat), plus instanced serrated teeth, eyes, bone layout,
// hurtbox anchors and attachment points.
//
// Every vertex carries `aMouthDepth` (0 on the skin and at the lips → 1 deep
// in the throat); the mouth material uses it as cavity occlusion. Mouth
// colours are dark, desaturated tissue (red is long gone at depth).
//
// Model space: +Z forward (snout), +Y up. See SharkAnatomy.js.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SharkAnatomy, BONE, BONE_COUNT } from './SharkAnatomy.js';
import { clamp, smoothstep, lerp, makeRng } from './noise.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

export const GEO_QUALITY = {
  high: { ringStep: 0.0085, mu: 44, mj: 16, finT: 8, finU: 7, mouthK: 14, gillGeo: true, teethRows: 3, throatR: 5 },
  medium: { ringStep: 0.013, mu: 32, mj: 12, finT: 6, finU: 5, mouthK: 10, gillGeo: true, teethRows: 3, throatR: 4 },
  low: { ringStep: 0.022, mu: 22, mj: 8, finT: 4, finU: 4, mouthK: 8, gillGeo: false, teethRows: 2, throatR: 3 },
};

// Texture layout: body s maps to u = s * U_BODY; fins sample a strip at u ≥ U_FIN.
export const U_BODY = 0.88;
export const U_FIN = 0.9;

// ---------------------------------------------------------------------------
// Small helpers

/** Accumulates skinned vertices for one sub-mesh. */
class MeshData {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.si = [];
    this.sw = [];
    this.md = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  add(p, n, u, v, color, weights, mouthDepth = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(color[0], color[1], color[2]);
    this.si.push(weights.i[0], weights.i[1], weights.i[2], weights.i[3]);
    this.sw.push(weights.w[0], weights.w[1], weights.w[2], weights.w[3]);
    this.md.push(mouthDepth);
    return this.count - 1;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  toGeometry(computeNormals = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setAttribute('aMouthDepth', new THREE.Float32BufferAttribute(this.md, 1));
    g.setIndex(this.idx);
    if (computeNormals) g.computeVertexNormals();
    return g;
  }
}

/** Skin weights: up to 4 bone influences. */
class Weights {
  constructor() {
    this.i = [0, 0, 0, 0];
    this.w = [1, 0, 0, 0];
    this._acc = new Map();
  }

  clear() {
    this._acc.clear();
    return this;
  }

  add(bone, weight) {
    if (weight <= 1e-5) return this;
    this._acc.set(bone, (this._acc.get(bone) ?? 0) + weight);
    return this;
  }

  addAll(other, scale) {
    for (let k = 0; k < 4; k++) if (other.w[k] > 0) this.add(other.i[k], other.w[k] * scale);
    return this;
  }

  finish() {
    const list = [...this._acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const [, w] of list) sum += w;
    for (let k = 0; k < 4; k++) {
      if (k < list.length && sum > 0) {
        this.i[k] = list[k][0];
        this.w[k] = list[k][1] / sum;
      } else {
        this.i[k] = 0;
        this.w[k] = 0;
      }
    }
    if (sum === 0) {
      this.i[0] = BONE.root;
      this.w[0] = 1;
    }
    return this;
  }

  copy(o) {
    for (let k = 0; k < 4; k++) {
      this.i[k] = o.i[k];
      this.w[k] = o.w[k];
    }
    return this;
  }

  static single(bone) {
    const w = new Weights();
    w.i[0] = bone;
    w.w[0] = 1;
    return w;
  }
}

function mixColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ---------------------------------------------------------------------------
// Skin weights along the body

function makeWeightFns(anat) {
  const spec = anat.spec;
  const m = anat.mouth;
  const idx = [0, 0];
  const w = [0, 0];
  const snoutEnd = Math.min(0.13, spec.headS - 0.035);

  function upper(s, out) {
    anat.axialWeights(s, idx, w);
    out.clear().add(idx[0], w[0]).add(idx[1], w[1]);
    if (s < snoutEnd) {
      const ws = 1 - smoothstep(0.035, snoutEnd, s);
      // Front of the head: blend head ↔ snout (the snout lifts when biting).
      const base = new Weights().copy(out.finish());
      out.clear().add(BONE.snout, ws).addAll(base, 1 - ws);
    }
    return out.finish();
  }

  const _tmp = new Weights();
  // edge: 0 at the ventral midline of the jaw sector, 1 at the lip.
  function jawSector(s, edge, out) {
    if (s < m.sFront) return upper(s, out);
    if (s <= m.sHinge + 1e-6) return out.clear().add(BONE.jaw, 1).finish();
    const wj = 1 - smoothstep(m.sHinge, m.sHinge + 0.012, s);
    const wt = smoothstep(m.sHinge, m.sHinge + 0.016, s) * (1 - smoothstep(m.sHinge + 0.03, m.sClose + 0.03, s)) * (1 - 0.75 * edge);
    const rest = Math.max(0, 1 - wj - wt);
    upper(s, _tmp);
    return out.clear().add(BONE.jaw, wj).add(BONE.throat, wt).addAll(_tmp, rest).finish();
  }

  return { upper, jawSector };
}

function ringSamples(anat, q) {
  const spec = anat.spec;
  const m = anat.mouth;
  const g = spec.gills;
  const gA = g.s0 - 0.012;
  const gB = g.s0 + (g.count - 1) * g.spacing + 0.012;
  const list = [];
  let s = 0;
  while (s < anat.sEnd - 1e-4) {
    list.push(s);
    let f = 1;
    if (s < 0.03) f = 0.3;
    else if (s < m.sClose + 0.02) f = 0.55;
    if (s > gA && s < gB) f = Math.min(f, q.gillGeo ? 0.3 : 0.8);
    if (s > 0.8) f = Math.min(f, 0.7);
    s += q.ringStep * f;
  }
  list.push(anat.sEnd);
  // Make sure the mouth front and hinge are exact ring positions.
  for (const key of [m.sFront, m.sHinge]) {
    let best = 0;
    for (let i = 1; i < list.length; i++) if (Math.abs(list[i] - key) < Math.abs(list[best] - key)) best = i;
    list[best] = key;
  }
  return list;
}

// ---------------------------------------------------------------------------
// Fins

function buildFin(md, anat, fs, side, q, wfns) {
  const L = anat.L;
  const theta = side > 0 ? fs.theta * DEG : Math.PI - fs.theta * DEG;
  const R0 = anat.surface(fs.s0, theta, new THREE.Vector3(), false);
  const R1 = anat.surface(fs.s1, theta, new THREE.Vector3(), false);
  // Bury the root inside the body so there is no visible seam.
  const inset = fs.thick * L * 1.3 + 0.004 * L;
  for (const [R, s] of [[R0, fs.s0], [R1, fs.s1]]) {
    const axis = anat.center(s, new THREE.Vector3());
    const toAxis = axis.sub(R);
    const len = toAxis.length();
    if (len > 1e-6) R.addScaledVector(toAxis, Math.min(inset, len * 0.6) / len);
  }
  const c = new THREE.Vector3().subVectors(R1, R0).normalize();
  const d = new THREE.Vector3(fs.dir[0] * side, fs.dir[1], fs.dir[2]);
  d.addScaledVector(c, -d.dot(c)).normalize();
  const nrm = new THREE.Vector3().crossVectors(c, d).normalize();

  const span = fs.span * L;
  const sweep = fs.sweep * L;
  const tipChord = fs.tipChord * L;
  const falcate = fs.falcate * L;
  const leBow = (fs.leBow ?? 0) * L;
  const thick = fs.thick * L;
  const tipLE = new THREE.Vector3().copy(R0).addScaledVector(d, span).addScaledVector(c, sweep);
  const tipTE = new THREE.Vector3().copy(tipLE).addScaledVector(c, tipChord);

  // Spanwise curl (fs.curl × span at the tip, toward the belly side): a
  // real pectoral is not a flat plate — edge-on it shows a curved blade.
  const curl = (fs.curl ?? 0) * span;
  const curlDir = nrm.clone().multiplyScalar(nrm.y > 0 ? -1 : 1);
  const T = q.finT;
  const U = q.finU;
  const LE = new THREE.Vector3();
  const TE = new THREE.Vector3();
  const P = new THREE.Vector3();
  const N = new THREE.Vector3(0, 1, 0);
  const pec = fs.bone === 'pec';
  const wPec = Weights.single(side > 0 ? BONE.pecP : BONE.pecN);
  const wTmp = new Weights();
  const idxTmp = [0, 0];
  const wArr = [0, 0];
  const lastSpine = anat.spec.spineS[anat.spec.spineS.length - 1];

  for (const face of [1, -1]) {
    const offDir = nrm.clone().multiplyScalar(face);
    // Pectoral / pelvic undersides are pale (and GW pectoral tips are black underneath).
    const isUnder = fs.paleUnder && offDir.y < 0;
    const start = md.count;
    for (let ti = 0; ti <= T; ti++) {
      const t = ti / T;
      LE.copy(R0).addScaledVector(d, span * t).addScaledVector(c, sweep * Math.pow(t, 1.4) - leBow * Math.sin(Math.PI * t));
      TE.copy(R1).lerp(tipTE, Math.pow(t, 0.9)).addScaledVector(c, -falcate * Math.sin(Math.PI * Math.pow(t, 0.8)));
      // Keep the trailing edge behind the leading edge.
      const chord = TE.clone().sub(LE).dot(c);
      if (chord < tipChord * 0.5) TE.copy(LE).addScaledVector(c, tipChord * 0.5);
      for (let ui = 0; ui <= U; ui++) {
        const u0 = ui / U;
        const u = (1 - Math.cos(Math.PI * u0)) * 0.5; // cosine spacing: finer at LE/TE
        P.copy(LE).lerp(TE, u);
        const airfoil = clamp(2.6 * Math.sqrt(u) * (1 - u), 0, 1);
        // Thick at the root, thinning fast toward a blade-thin tip: seen
        // edge-on a fin tapers like a blade instead of reading as a plank.
        const th = thick * (0.06 + 0.94 * Math.pow(1 - t, 1.6)) * airfoil;
        P.addScaledVector(offDir, th * 0.5);
        if (curl) P.addScaledVector(curlDir, curl * t * t);
        // Colour: darker tips / trailing margins.
        let dark = smoothstep(0.62, 1, t) * (isUnder ? (fs.tipDarkUnder ?? fs.tipDark ?? 0) : (fs.tipDark ?? 0));
        dark = Math.max(dark, smoothstep(0.8, 1, u) * (fs.edgeDark ?? 0.12) * (0.3 + 0.7 * t));
        const shade = 1 - dark * 0.85;
        const col = [shade, shade, shade];
        let weights;
        if (pec) weights = wPec;
        else {
          const s = Math.min(lastSpine + 0.05, anat.sFromZ(P.z));
          anat.axialWeights(s, idxTmp, wArr);
          weights = wTmp.clear().add(idxTmp[0], wArr[0]).add(idxTmp[1], wArr[1]).finish();
          weights = new Weights().copy(weights);
        }
        const tu = U_FIN + (1 - U_FIN) * 0.98 * u;
        const tv = isUnder ? 0.02 + 0.45 * t : 0.52 + 0.45 * t;
        md.add(P, N, tu, tv, col, weights);
      }
    }
    // Grid triangles; winding chosen so the face normal points along offDir.
    for (let ti = 0; ti < T; ti++) {
      for (let ui = 0; ui < U; ui++) {
        const a = start + ti * (U + 1) + ui;
        const b = a + 1;
        const cc = a + (U + 1);
        const dd = cc + 1;
        if (face > 0) {
          md.tri(a, b, cc);
          md.tri(b, dd, cc);
        } else {
          md.tri(a, cc, b);
          md.tri(b, cc, dd);
        }
      }
    }
  }
  return { R0, R1, c, d, nrm, span, sweep, curl, curlDir };
}

// ---------------------------------------------------------------------------
// Teeth

/** Serrated tooth blade, unit height along +Y, base width 1 along X, face normal +Z. */
export function buildToothGeometry(shape = 'triangle', serration = 0.045) {
  const outline = [];
  const N = 9; // serrations per edge
  const edge = (from, to, outward, bulge) => {
    for (let k = 0; k < 2 * N; k++) {
      const t = k / (2 * N);
      const x = lerp(from[0], to[0], t);
      const y = lerp(from[1], to[1], t);
      const amp = (k % 2 === 1 ? serration : 0) * (1 - 0.6 * Math.abs(t - 0.5));
      const b = bulge * Math.sin(Math.PI * t);
      outline.push([x + outward[0] * (amp + b), y + outward[1] * (amp + b)]);
    }
  };
  if (shape === 'cockscomb') {
    // Tiger-shark tooth: tip hooked sideways, deep notch on the distal edge.
    const tip = [0.26, 0.86];
    edge([-0.5, 0], tip, [-0.85, 0.5], 0.08);
    edge(tip, [0.34, 0.42], [0.8, 0.2], 0.0);
    edge([0.34, 0.42], [0.5, 0.0], [0.95, 0.3], 0.04);
  } else {
    const tip = [0, 1];
    edge([-0.5, 0], tip, [-0.9, 0.42], 0.035);
    edge(tip, [0.5, 0], [0.9, 0.42], 0.035);
  }
  const pos = [];
  const col = [];
  const idx = [];
  const pushV = (x, y, z) => {
    pos.push(x, y, z);
    // Root fades into gum colour, tips bone white.
    const k = smoothstep(0.0, 0.3, y);
    col.push(lerp(0.78, 1, k), lerp(0.55, 0.98, k), lerp(0.5, 0.92, k));
    return pos.length / 3 - 1;
  };
  const front = pushV(0, 0.34, 0.12);
  const back = pushV(0, 0.34, -0.05);
  const first = pos.length / 3;
  for (const [x, y] of outline) pushV(x, y, 0);
  const n = outline.length;
  for (let k = 0; k < n; k++) {
    const a = first + k;
    const b = first + ((k + 1) % n);
    // Outline runs from base-left up over the tip and back down (clockwise
    // seen from +Z), so (front, b, a) faces +Z.
    idx.push(front, b, a);
    idx.push(back, a, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Main builder

/** Synchronous build (drains the generator). */
export function buildSharkGeometry(spec, quality = 'high') {
  const gen = buildSharkGeometryGen(spec, quality);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/**
 * Incremental build: yields every few rings / sub-meshes so the asset
 * library can spread the work across frames. Returns the geometry bundle.
 */
export function* buildSharkGeometryGen(spec, quality = 'high') {
  const q = GEO_QUALITY[quality] ?? GEO_QUALITY.high;
  const anat = new SharkAnatomy(spec);
  const L = anat.L;
  const m = anat.mouth;
  const wf = makeWeightFns(anat);
  const rng = makeRng(spec.seed + 17);

  // ---------------------------------------------------------------- bones
  const restWorld = [];
  for (let k = 0; k < BONE_COUNT; k++) restWorld.push(new THREE.Vector3());
  spec.spineS.forEach((s, k) => anat.center(s, restWorld[k]));
  anat.center(spec.headS, restWorld[BONE.head]);
  anat.center(spec.eye.s, restWorld[BONE.snout]);
  const hingeLip = anat.lip(m.sHinge, 1, new THREE.Vector3());
  restWorld[BONE.jaw].set(0, hingeLip.y, anat.z(m.sHinge));
  restWorld[BONE.upperJaw].set(0, hingeLip.y, anat.z((m.sFront + m.sHinge) * 0.5));
  const pThroat = anat.profile(m.sHinge + 0.03);
  restWorld[BONE.throat].set(0, pThroat.bot * L, anat.z(m.sHinge + 0.03));
  const parents = new Array(BONE_COUNT).fill(-1);
  for (let k = 1; k < 9; k++) parents[k] = k - 1;
  parents[BONE.head] = BONE.root;
  parents[BONE.snout] = BONE.head;
  parents[BONE.upperJaw] = BONE.head;
  parents[BONE.jaw] = BONE.head;
  parents[BONE.throat] = BONE.head;
  parents[BONE.pecN] = BONE.root;
  parents[BONE.pecP] = BONE.root;

  // ---------------------------------------------------------------- body + lower jaw
  const skin = new MeshData();
  const sList = ringSamples(anat, q);
  const Mu = q.mu;
  const Mj = q.mj;
  const ringLen = Mu + 1 + Mj + 1;
  const P = new THREE.Vector3();
  const Nn = new THREE.Vector3();
  const white = [1, 1, 1];
  const wTmp = new Weights();
  const iFront = sList.indexOf(m.sFront);
  const iHinge = sList.indexOf(m.sHinge);
  // Per-ring lip info for the mouth builder.
  const ringStart = [];

  for (let i = 0; i < sList.length; i++) {
    if (i % 12 === 11) yield 'rings';
    const s = sList[i];
    const dl = anat.delta(s);
    ringStart.push(skin.count);
    const u = s * U_BODY;
    // Upper sector (head / body skin): from the +x lip over the back to the -x lip.
    for (let j = 0; j <= Mu; j++) {
      const th = -Math.PI / 2 + dl + (j / Mu) * (2 * Math.PI - 2 * dl);
      anat.surface(s, th, P, q.gillGeo);
      anat.surfaceNormal(s, th, Nn, q.gillGeo);
      const lip = j === 0 || j === Mu;
      if (lip && s > m.sHinge) wf.jawSector(s, 1, wTmp);
      else wf.upper(s, wTmp);
      skin.add(P, Nn, u, (th + Math.PI / 2) / (2 * Math.PI), white, wTmp);
    }
    // Jaw sector (lower jaw skin / throat), duplicated lip vertices at both ends.
    for (let j = 0; j <= Mj; j++) {
      const th = (3 * Math.PI) / 2 - dl + (j / Mj) * (2 * dl);
      anat.surface(s, th, P, q.gillGeo);
      anat.surfaceNormal(s, th, Nn, q.gillGeo);
      const edge = Math.abs((j / Mj) * 2 - 1);
      wf.jawSector(s, edge, wTmp);
      skin.add(P, Nn, u, (th + Math.PI / 2) / (2 * Math.PI), white, wTmp);
    }
  }
  for (let i = 0; i < sList.length - 1; i++) {
    const r0 = ringStart[i];
    const r1 = ringStart[i + 1];
    for (let j = 0; j < Mu; j++) {
      const a = r0 + j;
      const b = r1 + j;
      skin.tri(a, b, a + 1);
      skin.tri(b, b + 1, a + 1);
    }
    for (let j = 0; j < Mj; j++) {
      const a = r0 + Mu + 1 + j;
      const b = r1 + Mu + 1 + j;
      skin.tri(a, b, a + 1);
      skin.tri(b, b + 1, a + 1);
    }
  }

  yield 'body';
  // ---------------------------------------------------------------- fins
  const finInfo = {};
  for (const [name, fs] of Object.entries(spec.fins)) {
    const sides = fs.mirror ? [1, -1] : [1];
    for (const side of sides) {
      const info = buildFin(skin, anat, fs, side, q, wf);
      finInfo[`${name}${fs.mirror ? (side > 0 ? 'P' : 'N') : ''}`] = info;
      yield 'fin';
    }
  }
  // Pectoral bones pivot at the fin roots.
  restWorld[BONE.pecP].copy(finInfo.pectoralP.R0);
  restWorld[BONE.pecN].copy(finInfo.pectoralN.R0);

  // Body vertex normals are analytic; fins need computed normals. Build
  // separately and merge.
  const bodyVertCount = ringStart[ringStart.length - 1] + ringLen;
  const skinGeo = skin.toGeometry(false);
  {
    // Recompute fin normals only (vertices after the body block).
    const finGeo = new THREE.BufferGeometry();
    const posAttr = skinGeo.getAttribute('position');
    finGeo.setAttribute('position', posAttr);
    finGeo.setIndex(skin.idx.slice(firstFinIndex(skin, bodyVertCount)));
    finGeo.computeVertexNormals();
    const fn = finGeo.getAttribute('normal');
    const nAttr = skinGeo.getAttribute('normal');
    for (let v = bodyVertCount; v < posAttr.count; v++) nAttr.setXYZ(v, fn.getX(v), fn.getY(v), fn.getZ(v));
  }

  yield 'finNormals';
  // ---------------------------------------------------------------- mouth interior
  const mouth = new MeshData();
  const K = q.mouthK;
  // Linear albedo. Dull, dark tissue: at depth there is no red light to make
  // gums look pink, and the cavity itself is shaded by aMouthDepth.
  const gumFront = [0.16, 0.05, 0.05];
  const gumBack = [0.075, 0.028, 0.028];
  const lipColor = [0.1, 0.05, 0.048];
  const palateColor = [0.095, 0.034, 0.034];
  const floorColor = [0.085, 0.03, 0.03];
  const throatColor = [0.02, 0.01, 0.01];
  const gumAt = (t) => mixColor(gumFront, gumBack, t);
  // Cavity depth for a palate/floor vertex: t = front → hinge, mid = 0 at the
  // gums → 1 on the midline.
  const cavity = (t, mid) => clamp(0.3 + 0.45 * t + 0.2 * mid, 0, 0.95);
  const toothH = spec.teeth.upper * L;
  const gumWidth = spec.mouth.gum * L;
  const lipRings = [];
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const wUpperJaw = Weights.single(BONE.upperJaw);
  const wJaw = Weights.single(BONE.jaw);

  for (let i = iFront; i <= iHinge; i++) {
    const s = sList[i];
    const base = ringStart[i];
    const pos = skinGeo.getAttribute('position');
    const upP = new THREE.Vector3().fromBufferAttribute(pos, base + 0);
    const upN = new THREE.Vector3().fromBufferAttribute(pos, base + Mu);
    const jawN = new THREE.Vector3().fromBufferAttribute(pos, base + Mu + 1);
    const jawP = new THREE.Vector3().fromBufferAttribute(pos, base + Mu + 1 + Mj);
    // Tangent along the +x lip (front → back) → horizontal inward direction.
    const e = 0.004;
    anat.lip(Math.min(m.sHinge, s + e), 1, tmpA);
    anat.lip(Math.max(m.sFront - e, s - e), 1, tmpB);
    const T = tmpA.sub(tmpB);
    const inP = new THREE.Vector3(T.z, 0, -T.x);
    if (inP.lengthSq() < 1e-10) inP.set(0, 0, -1);
    inP.normalize();
    if (inP.x > 0.05) inP.x = -inP.x;
    const inN = new THREE.Vector3(-inP.x, 0, inP.z);
    const prof = anat.profile(s);
    const headroom = Math.max(0.001, prof.top * L - upP.y);
    const jawRoom = Math.max(0.001, upP.y - prof.bot * L);
    const front = smoothstep(m.sFront, m.sFront + 0.035, s);
    const lift = Math.min(toothH * 0.85, headroom * 0.35) * (0.35 + 0.65 * front);
    const drop = Math.min(toothH * 0.8, jawRoom * 0.3) * (0.35 + 0.65 * front);
    const dome = Math.max(0, Math.min(spec.mouth.palate * L, headroom * 0.55) - lift) * front;
    const fdome = Math.max(0, Math.min(spec.mouth.floor * L, jawRoom * 0.55) - drop) * front;
    lipRings.push({ s, i, upP, upN, jawP, jawN, inP, inN, lift, drop, dome, fdome, wUp: new Weights().copy(wf.upper(s, wTmp)) });
  }

  const tAlong = (r) => (r.s - m.sFront) / (m.sHinge - m.sFront);
  const palateRows = [];
  const floorRows = [];
  const V = new THREE.Vector3();
  for (const r of lipRings) {
    const t = tAlong(r);
    // Palate (roof): lip → gum → dome → gum → lip.
    const row = [];
    const gumInP = r.upP.clone().addScaledVector(r.inP, gumWidth).addScaledVector(UP, r.lift);
    const gumInN = r.upN.clone().addScaledVector(r.inN, gumWidth).addScaledVector(UP, r.lift);
    for (let k = 0; k <= K; k++) {
      let col;
      let w;
      let md;
      if (k === 0 || k === K) {
        V.copy(k === 0 ? r.upP : r.upN);
        col = lipColor;
        w = r.wUp;
        md = 0;
      } else if (k === 1 || k === K - 1) {
        V.copy(k === 1 ? gumInP : gumInN);
        col = gumAt(t);
        w = wUpperJaw;
        md = 0.08 + 0.22 * t;
      } else {
        const u = (k - 1) / (K - 2);
        V.copy(gumInP).lerp(gumInN, u).addScaledVector(UP, r.dome * Math.pow(4 * u * (1 - u), 0.6));
        // Transverse ridges (rugae) and darkening toward the throat.
        const ridge = 0.8 + 0.2 * Math.sin((r.s * Math.PI * 2) / 0.02); // transverse palatal ridges
        const mid = Math.pow(4 * u * (1 - u), 0.5);
        col = mixColor(palateColor, throatColor, 0.3 * t + 0.35 * mid * t).map((x) => x * ridge);
        w = wUpperJaw;
        md = cavity(t, mid);
      }
      row.push(mouth.add(V, UP, 0, 0, col, w, md));
    }
    palateRows.push(row);

    const frow = [];
    const fgumP = r.jawP.clone().addScaledVector(r.inP, gumWidth * 1.15).addScaledVector(UP, -r.drop);
    const fgumN = r.jawN.clone().addScaledVector(r.inN, gumWidth * 1.15).addScaledVector(UP, -r.drop);
    for (let k = 0; k <= K; k++) {
      let col;
      let md;
      if (k === 0 || k === K) {
        V.copy(k === 0 ? r.jawP : r.jawN);
        col = lipColor;
        md = 0;
      } else if (k === 1 || k === K - 1) {
        V.copy(k === 1 ? fgumP : fgumN);
        col = gumAt(t);
        md = 0.08 + 0.22 * t;
      } else {
        const u = (k - 1) / (K - 2);
        V.copy(fgumP).lerp(fgumN, u).addScaledVector(UP, -r.fdome * Math.pow(4 * u * (1 - u), 0.6));
        const mid = Math.pow(4 * u * (1 - u), 0.5);
        const fold = 0.85 + 0.15 * Math.sin(u * Math.PI * 7);
        col = mixColor(floorColor, throatColor, 0.25 + 0.45 * t * mid).map((x) => x * fold);
        md = cavity(t, mid);
      }
      frow.push(mouth.add(V, UP, 0, 0, col, wJaw, md));
    }
    floorRows.push(frow);
  }
  const gridTris = (rows, flip) => {
    for (let a = 0; a < rows.length - 1; a++) {
      for (let k = 0; k < K; k++) {
        const p00 = rows[a][k];
        const p01 = rows[a][k + 1];
        const p10 = rows[a + 1][k];
        const p11 = rows[a + 1][k + 1];
        if (flip) {
          mouth.tri(p00, p01, p10);
          mouth.tri(p01, p11, p10);
        } else {
          mouth.tri(p00, p10, p01);
          mouth.tri(p01, p10, p11);
        }
      }
    }
  };
  yield 'mouthRows';
  gridTris(palateRows, false);
  gridTris(floorRows, true);

  // Throat curtain: palate back edge → deep throat → floor back edge.
  const R = q.throatR;
  const lastR = lipRings[lipRings.length - 1];
  const throatDepth = spec.mouth.throat * L;
  const throatRows = [];
  const wBlend = new Weights();
  for (let r = 0; r <= R; r++) {
    const t = r / R;
    const row = [];
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      const A = new THREE.Vector3().fromArray(mouth.pos, palateRows[palateRows.length - 1][k] * 3);
      const B = new THREE.Vector3().fromArray(mouth.pos, floorRows[floorRows.length - 1][k] * 3);
      V.copy(A).lerp(B, t);
      const bulge = 1 - Math.pow(2 * u - 1, 4);
      V.z -= throatDepth * Math.sin(Math.PI * t) * bulge;
      const edge = k === 0 || k === K;
      const wA = edge ? lastR.wUp : wUpperJaw;
      wBlend.clear().addAll(wA, 1 - t).addAll(wJaw, t).finish();
      const depth = Math.sin(Math.PI * t) * bulge;
      const col = mixColor(mixColor(palateColor, floorColor, t), throatColor, 0.55 + 0.45 * depth);
      // The corners stay at lip depth; the curtain itself is the gullet.
      const md = edge ? 0.15 : 0.72 + 0.28 * depth;
      row.push(mouth.add(V, UP, 0, 0, col, new Weights().copy(wBlend), md));
    }
    throatRows.push(row);
  }
  gridTris(throatRows, false);

  // Corner patches where the upper and lower lips meet behind the hinge.
  {
    const pos = skinGeo.getAttribute('position');
    const iN = iHinge + 1;
    for (const side of [1, -1]) {
      const upIdx = ringStart[iHinge] + (side > 0 ? 0 : Mu);
      const jawIdx = ringStart[iHinge] + Mu + 1 + (side > 0 ? Mj : 0);
      const nextIdx = ringStart[iN] + (side > 0 ? 0 : Mu);
      const a = mouth.add(new THREE.Vector3().fromBufferAttribute(pos, upIdx), UP, 0, 0, lipColor, lastR.wUp);
      const b = mouth.add(new THREE.Vector3().fromBufferAttribute(pos, jawIdx), UP, 0, 0, lipColor, wJaw);
      wf.jawSector(sList[iN], 1, wTmp);
      const c = mouth.add(new THREE.Vector3().fromBufferAttribute(pos, nextIdx), UP, 0, 0, gumBack, new Weights().copy(wTmp), 0.1);
      mouth.tri(a, b, c);
    }
  }
  yield 'mouthMesh';
  const mouthGeo = mouth.toGeometry(true);

  yield 'merge';
  const geometry = mergeGeometries([skinGeo, mouthGeo], true);
  geometry.groups[0].materialIndex = 0;
  geometry.groups[1].materialIndex = 1;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // ---------------------------------------------------------------- teeth
  yield 'teeth';
  const teeth = buildTeeth(spec, anat, lipRings, restWorld, q, rng);

  // ---------------------------------------------------------------- eyes
  const eyeR = spec.eye.radius * L;
  const eyes = [];
  for (const side of [1, -1]) {
    const th = side > 0 ? spec.eye.theta * DEG : Math.PI - spec.eye.theta * DEG;
    const p = anat.surface(spec.eye.s, th, new THREE.Vector3(), false);
    const n = anat.surfaceNormal(spec.eye.s, th, new THREE.Vector3(), false);
    // Bias the gaze slightly forward.
    n.z += 0.18;
    n.normalize();
    const center = p.clone().addScaledVector(n, -eyeR * 0.42);
    const zAxis = n.clone();
    const xAxis = new THREE.Vector3(0, 0, 1).addScaledVector(zAxis, -zAxis.z).normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    const mtx = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    eyes.push({
      side,
      position: center.sub(restWorld[BONE.head]),
      quaternion: new THREE.Quaternion().setFromRotationMatrix(mtx),
    });
  }

  // ---------------------------------------------------------------- hurtboxes
  const hurtboxes = buildHurtboxes(spec, anat, restWorld, eyes, finInfo);

  // ---------------------------------------------------------------- attachment points (bone-local)
  const sGrab = m.sFront + 0.24 * (m.sHinge - m.sFront);
  const lipGrab = anat.lip(sGrab, 1, new THREE.Vector3());
  const points = {
    // Where a grabbed player is held (between the jaws), head-bone space.
    grab: new THREE.Vector3(0, lipGrab.y - 0.012 * L, anat.z(sGrab)).sub(restWorld[BONE.head]),
    // Bite volume centre (just ahead of the jaws).
    bite: new THREE.Vector3(0, anat.lip(m.sFront, 1, new THREE.Vector3()).y - 0.01 * L, anat.z(m.sFront) + 0.02 * L).sub(restWorld[BONE.head]),
    snout: new THREE.Vector3(0, anat.profile(0.01).mid * L, anat.z(0)).sub(restWorld[BONE.head]),
    // Caudal fin centre, last spine bone space.
    caudal: new THREE.Vector3(0, anat.profile(0.9).mid * L + 0.02 * L, anat.z(0.97)).sub(restWorld[BONE.sp8]),
    gills: hurtboxes.filter((h) => h.part === 'gills').map((h) => ({ bone: h.bone, local: h.local.clone() })),
  };

  // Bone hierarchy with parent-relative rest positions.
  const bones = [];
  for (let k = 0; k < BONE_COUNT; k++) {
    const local = restWorld[k].clone();
    if (parents[k] >= 0) local.sub(restWorld[parents[k]]);
    bones.push({ index: k, parent: parents[k], position: local });
  }

  return {
    spec,
    anatomy: anat,
    quality,
    geometry,
    bones,
    restWorld,
    teeth,
    eyes,
    eyeRadius: eyeR,
    hurtboxes,
    points,
    boundingRadius: 0.75 * L,
  };
}

function firstFinIndex(md, bodyVertCount) {
  // Index entries are pushed body first, then fins: find where fins start.
  const idx = md.idx;
  for (let k = 0; k < idx.length; k += 3) {
    if (idx[k] >= bodyVertCount) return k;
  }
  return idx.length;
}

function buildTeeth(spec, anat, lipRings, restWorld, q, rng) {
  const L = anat.L;
  const ts = spec.teeth;
  const rows = Math.min(ts.rows, q.teethRows);
  const upper = [];
  const lower = [];
  // Per-instance colour: back rows sit inside the mouth (darker), and the
  // ivory varies tooth to tooth.
  const upperColors = [];
  const lowerColors = [];
  const ROW_SHADE = [1, 0.62, 0.42];
  // Irregularity: an old giant's teeth are uneven (tilt ±12°, size ±20 %).
  const tiltMax = (spec.isBoss ? 12 : 5) * DEG;
  const sizeVar = spec.isBoss ? 0.2 : 0;
  const gumWidth = spec.mouth.gum * L;
  const mtx = new THREE.Matrix4();
  const X = new THREE.Vector3();
  const Y = new THREE.Vector3();
  const Z = new THREE.Vector3();
  const P = new THREE.Vector3();
  const S = new THREE.Vector3();
  const T2 = new THREE.Vector3();

  // Arc-length parameterisation of the lip, per side.
  const cum = [0];
  for (let i = 1; i < lipRings.length; i++) cum.push(cum[i - 1] + lipRings[i].upP.distanceTo(lipRings[i - 1].upP));
  const total = cum[cum.length - 1];
  const sample = (f) => {
    const target = f * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const t = clamp((target - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]), 0, 1);
    return { a: lipRings[i - 1], b: lipRings[i], t };
  };

  for (const side of [1, -1]) {
    for (let j = 0; j < ts.perSide; j++) {
      const f = ((j + 0.55) / (ts.perSide + 0.2)) * 0.93;
      const { a, b, t } = sample(f);
      // Front teeth are the biggest; the 3rd is a small intermediate tooth (lamnid trait).
      let size = 1 - 0.5 * Math.pow(f, 1.25);
      if (j === 2 && ts.shape !== 'cockscomb') size *= 0.72;
      size *= 0.92 + rng() * 0.16;
      for (const jaw of ['upper', 'lower']) {
        const isUp = jaw === 'upper';
        const lipA = isUp ? (side > 0 ? a.upP : a.upN) : side > 0 ? a.jawP : a.jawN;
        const lipB = isUp ? (side > 0 ? b.upP : b.upN) : side > 0 ? b.jawP : b.jawN;
        const inA = side > 0 ? a.inP : a.inN;
        const inB = side > 0 ? b.inP : b.inN;
        const inward = new THREE.Vector3().copy(inA).lerp(inB, t).normalize();
        const lipPt = new THREE.Vector3().copy(lipA).lerp(lipB, t);
        const vroom = isUp ? lerp(a.lift, b.lift, t) : lerp(a.drop, b.drop, t);
        const tangent = new THREE.Vector3().subVectors(lipB, lipA);
        if (tangent.lengthSq() < 1e-10) tangent.set(side, 0, 0);
        tangent.normalize();
        const hBase0 = (isUp ? ts.upper : ts.lower) * L * size;
        for (let r = 0; r < rows; r++) {
          const jitter = 1 + (rng() - 0.5) * 2 * sizeVar;
          // Teeth in tight spots (front of the jaw) shrink to stay inside the head.
          const h = Math.min(hBase0 * jitter, vroom / 0.62 + 0.002 * L);
          const width = h * (isUp ? ts.upperWidth : ts.lowerWidth);
          const rake = (isUp ? 0.22 : 0.12) + r * 0.78;
          const hr = h * (1 - 0.14 * r);
          // Root on the gum slope, inside the lip line, raised into the gum.
          P.copy(lipPt)
            .addScaledVector(inward, gumWidth * (isUp ? 0.5 : 0.75) + r * 0.0072 * L)
            .addScaledVector(UP, (isUp ? 1 : -1) * Math.min(vroom, hr * 0.62));
          // Tip direction: away from the gum, raked inward for back rows.
          Y.copy(UP).multiplyScalar(isUp ? -Math.cos(rake) : Math.cos(rake)).addScaledVector(inward, Math.sin(rake)).normalize();
          Z.copy(inward).negate();
          Z.addScaledVector(Y, -Z.dot(Y)).normalize();
          X.crossVectors(Y, Z).normalize();
          // In-plane tilt: rotate the blade about its face normal.
          const tilt = (rng() - 0.5) * 2 * tiltMax;
          if (tilt !== 0) {
            const ct = Math.cos(tilt);
            const st = Math.sin(tilt);
            T2.copy(X).multiplyScalar(ct).addScaledVector(Y, st);
            Y.multiplyScalar(ct).addScaledVector(X, -st);
            X.copy(T2);
          }
          mtx.makeBasis(X, Y, Z);
          S.set(width * (1 - 0.1 * r), hr, hr * 0.9);
          mtx.scale(S);
          const bone = isUp ? BONE.upperJaw : BONE.jaw;
          P.sub(restWorld[bone]);
          mtx.setPosition(P);
          (isUp ? upper : lower).push(mtx.clone());
          const shade = ROW_SHADE[Math.min(r, ROW_SHADE.length - 1)] * (0.86 + 0.14 * rng());
          const yellow = rng();
          (isUp ? upperColors : lowerColors).push(shade, shade * (0.98 - 0.03 * yellow), shade * (0.93 - 0.08 * yellow));
        }
      }
    }
  }
  return { geometry: buildToothGeometry(ts.shape, ts.serration), upper, lower, upperColors, lowerColors };
}

function buildHurtboxes(spec, anat, restWorld, eyes, finInfo) {
  const L = anat.L;
  const list = [];
  const add = (part, bone, worldPos, radius) => {
    list.push({ part, bone, local: worldPos.clone().sub(restWorld[bone]), radius });
  };
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  // Eyes (critical, small but aimable).
  for (const e of eyes) {
    const w = e.position.clone().add(restWorld[BONE.head]);
    add('eye', BONE.head, w, Math.max(spec.eye.radius * L * 3.2, 0.026 * L));
  }
  // Gills, one sphere per flank over the slits.
  const g = spec.gills;
  const sG = g.s0 + (g.count - 1) * g.spacing * 0.5;
  const pG = anat.profile(sG);
  const rG = Math.max(pG.h, pG.w) * L * 0.55;
  for (const side of [1, -1]) {
    const th = side > 0 ? -0.12 : Math.PI + 0.12;
    anat.surface(sG, th, P, false);
    anat.surfaceNormal(sG, th, N, false);
    P.addScaledVector(N, -rG * 0.35);
    add('gills', anat.dominantBone(sG), P, rG);
  }
  // Head.
  for (const s of [0.035, 0.08, 0.13]) {
    const p = anat.profile(s);
    anat.center(s, P);
    add('head', BONE.head, P, Math.max(p.h, p.w) * L * 1.06 + 0.01 * L);
  }
  // Fins.
  const finCenter = (info, along, chordT) => {
    const out = info.R0.clone().addScaledVector(info.d, info.span * along).addScaledVector(info.c, info.sweep * Math.pow(along, 1.4));
    const chord = info.R1.distanceTo(info.R0);
    out.addScaledVector(info.c, chord * chordT * (1 - along));
    if (info.curl) out.addScaledVector(info.curlDir, info.curl * along * along); // follows the fin's curl
    return out;
  };
  if (finInfo.dorsal1) {
    const c = finCenter(finInfo.dorsal1, 0.4, 0.45);
    const chord = finInfo.dorsal1.R1.distanceTo(finInfo.dorsal1.R0);
    add('fin', anat.dominantBone(anat.sFromZ(c.z)), c, chord * 0.42);
  }
  for (const key of ['pectoralP', 'pectoralN']) {
    const info = finInfo[key];
    if (!info) continue;
    const chord = info.R1.distanceTo(info.R0);
    for (const along of [0.3, 0.7]) {
      const c = finCenter(info, along, 0.4);
      add('fin', key === 'pectoralP' ? BONE.pecP : BONE.pecN, c, chord * (0.48 - 0.16 * along));
    }
  }
  // Body / tail chain following the spine.
  let s = 0.175;
  while (s < 0.93) {
    const p = anat.profile(s);
    const r = Math.max(Math.max(p.h, p.w) * L * 1.06, 0.045 * L);
    anat.center(s, P);
    add(s < 0.64 ? 'body' : 'tail', anat.dominantBone(s), P, r);
    s += Math.max(0.028, (0.7 * r) / L);
  }
  // Caudal lobes.
  for (const key of ['caudalUpper', 'caudalLower']) {
    const info = finInfo[key];
    if (!info) continue;
    const c = finCenter(info, 0.45, 0.3);
    add('tail', BONE.sp8, c, info.span * 0.42);
  }
  return list;
}
