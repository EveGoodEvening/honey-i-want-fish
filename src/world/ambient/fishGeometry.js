// Procedural small schooling fish: sardine, scad, jack (trevally) and fry.
//
// Unit length along +Z: nose at z = +0.5, caudal-fin tips at z ≈ -0.5.
// Forward axis is +Z (matches Object3D.lookAt for non-camera objects). The
// tail wag is done in the vertex shader (FishSchools) from the vertex z.
//
// All four species share ONE topology (same vertex count, same index buffer):
// a body of rings around the spine plus a fixed set of flat fins (caudal,
// two dorsals, anal, pectorals, pelvics, a dorsal and an anal finlet).
// Each species fills that superset with its own vertex positions — a fin it
// doesn't have collapses to a degenerate point inside the body — so the
// schools stay a single InstancedMesh / one draw call: FishSchools fetches the
// species' vertex from a float "shape" texture by gl_VertexID (rows per
// species: position + body flag, normal, fin colour + metalness, atlas uv +
// translucency) and paints the body from a pattern atlas.
//
// Body markings are painted per species into the atlas in body coordinates
// (u = along the body, v = around it) but drawn from object-space (z, y), so
// spots, stripes and eyes come out round and at absolute sizes:
//   sardine  slim round spindle, blue-green back, a row of dark spots, silver
//   scad     slim, pointed, yellow mid-flank stripe, dark opercular spot,
//            two dorsals, scutes on the straight lateral line, one detached
//            dorsal and one anal finlet (Decapterus)
//   jack     deep, compressed body, steep forehead, long sickle pectorals,
//            tall falcate dorsal/anal lobes, big deeply forked tail, scutes
//   fry      tiny, big head and eye, pale see-through body (mixed toward the
//            water colour), silver gut, melanophore dots, small fins
import * as THREE from 'three';

export const FISH_SPECIES = ['sardine', 'scad', 'jack', 'fry'];
export const FISH_SHAPE_ROWS = 4; // shape-texture rows per species

// Pattern atlas: one band of ATLAS_ROWS rows per species; the body's v ∈ [0, 1]
// maps to rows [ATLAS_PAD, ATLAS_ROWS - ATLAS_PAD) of its band. The pad rows
// repeat the edge colour (back above, belly below) so the mip chain doesn't
// pull the next species' belly into this one's back seam: with an eighth of
// the band per side, levels up to 5 (3 rows a band) still sample only their
// own species at v = 0 / 1 (a fish that small is a few pixels). Pad rows are
// copied, not painted.
export const ATLAS_W = 256;
export const ATLAS_ROWS = 96;
const ATLAS_PAD = 16;
export const ATLAS_H = ATLAS_ROWS * FISH_SPECIES.length;

const RING_BIAS = 1.25; // t_i = (i / rings)^bias: denser rings at the head

// ---------------------------------------------------------------------------
// species
//   prof: [t, top, bottom, halfWidth] (t = 0 nose … 1 caudal peduncle);
//   body runs from z = 0.5 to z = zPed; noseY = snout height.
//   fins (built against the body surface): see FIN_LAYOUT.
// ---------------------------------------------------------------------------
const SPECS = {
  sardine: {
    zPed: -0.3,
    noseY: -0.006,
    prof: [
      [0, 0, 0, 0],
      [0.04, 0.03, 0.027, 0.023],
      [0.12, 0.06, 0.056, 0.042],
      [0.26, 0.086, 0.08, 0.055],
      [0.44, 0.094, 0.086, 0.057],
      [0.62, 0.082, 0.072, 0.049],
      [0.8, 0.054, 0.047, 0.033],
      [0.93, 0.031, 0.028, 0.019],
      [1, 0.025, 0.023, 0.014],
    ],
    eye: { z: 0.444, y: 0.012, r: 0.024 },
    finCol: [0.42, 0.5, 0.54],
    finTip: [0.55, 0.62, 0.66],
    finMetal: 0.25,
    finTrans: 0.35,
    metal: 1,
    trans: 0,
  },
  scad: {
    zPed: -0.31,
    noseY: -0.002,
    prof: [
      [0, 0, 0, 0],
      [0.04, 0.024, 0.022, 0.019],
      [0.13, 0.053, 0.05, 0.036],
      [0.28, 0.08, 0.076, 0.047],
      [0.46, 0.086, 0.08, 0.047],
      [0.64, 0.072, 0.064, 0.039],
      [0.81, 0.044, 0.039, 0.025],
      [0.94, 0.021, 0.019, 0.012],
      [1, 0.016, 0.015, 0.01],
    ],
    eye: { z: 0.43, y: 0.014, r: 0.029 },
    finCol: [0.4, 0.44, 0.44],
    finTip: [0.56, 0.58, 0.55],
    tailCol: [0.62, 0.5, 0.16],
    tailTip: [0.85, 0.7, 0.22],
    finMetal: 0.2,
    finTrans: 0.3,
    metal: 1,
    trans: 0,
  },
  jack: {
    zPed: -0.22,
    noseY: -0.012,
    prof: [
      [0, 0, 0, 0],
      [0.03, 0.036, 0.026, 0.016],
      [0.1, 0.112, 0.068, 0.03],
      [0.22, 0.168, 0.124, 0.042],
      [0.38, 0.184, 0.148, 0.045],
      [0.55, 0.158, 0.13, 0.04],
      [0.7, 0.108, 0.09, 0.029],
      [0.84, 0.052, 0.044, 0.016],
      [0.94, 0.021, 0.018, 0.009],
      [1, 0.015, 0.013, 0.007],
    ],
    eye: { z: 0.442, y: 0.048, r: 0.031 },
    finCol: [0.14, 0.16, 0.18],
    finTip: [0.08, 0.09, 0.1],
    pecCol: [0.26, 0.27, 0.24],
    pecTip: [0.36, 0.35, 0.26],
    finMetal: 0.2,
    finTrans: 0.12,
    metal: 1,
    trans: 0,
  },
  fry: {
    zPed: -0.33,
    noseY: 0,
    prof: [
      [0, 0, 0, 0],
      [0.04, 0.042, 0.04, 0.036],
      [0.1, 0.068, 0.064, 0.05],
      [0.2, 0.076, 0.07, 0.05],
      [0.36, 0.062, 0.058, 0.038],
      [0.56, 0.047, 0.043, 0.028],
      [0.78, 0.032, 0.029, 0.019],
      [1, 0.021, 0.019, 0.011],
    ],
    eye: { z: 0.43, y: 0.012, r: 0.052 },
    finCol: [0.62, 0.7, 0.7],
    finTip: [0.7, 0.78, 0.78],
    finMetal: 0.1,
    finTrans: 0.8,
    metal: 1,
    trans: 0.9,
  },
};

// Catmull-Rom through the profile keys (no flat "beads" at the keys).
function makeProfile(spec) {
  const P = spec.prof;
  const n = P.length;
  return (t, out) => {
    t = Math.min(1, Math.max(0, t));
    let i = 1;
    while (i < n - 1 && t > P[i][0]) i++;
    const a = P[i - 1];
    const b = P[i];
    const pa = P[Math.max(0, i - 2)];
    const pb = P[Math.min(n - 1, i + 1)];
    const k = (t - a[0]) / (b[0] - a[0] || 1);
    const k2 = k * k;
    const k3 = k2 * k;
    for (let c = 1; c <= 3; c++) {
      const m0 = (b[c] - pa[c]) * 0.5;
      const m1 = (pb[c] - a[c]) * 0.5;
      const v = (2 * k3 - 3 * k2 + 1) * a[c] + (k3 - 2 * k2 + k) * m0 + (-2 * k3 + 3 * k2) * b[c] + (k3 - k2) * m1;
      out[c - 1] = Math.max(0, v);
    }
    return out;
  };
}

const _pf = [0, 0, 0];

// Body helpers for one species: z(t), t(z) and the surface at a z.
function bodyOf(name) {
  const spec = SPECS[name];
  const prof = makeProfile(spec);
  const z0 = 0.5;
  const z1 = spec.zPed;
  const zOf = (t) => z0 + (z1 - z0) * t;
  const tOf = (z) => (z0 - z) / (z0 - z1);
  // centre line: from the snout height to 0 at the peduncle
  const ycOf = (t) => spec.noseY * (1 - Math.min(1, t * 1.6));
  const top = (z) => {
    const t = tOf(z);
    prof(t, _pf);
    return ycOf(t) + _pf[0];
  };
  const bot = (z) => {
    const t = tOf(z);
    prof(t, _pf);
    return ycOf(t) - _pf[1];
  };
  const half = (z) => prof(tOf(z), _pf)[2];
  return { spec, prof, zOf, tOf, ycOf, top, bot, half };
}

// ---------------------------------------------------------------------------
// fins: fixed slots (vertex count, triangles); each species returns vertex
// lists [x, y, z, tip] (tip 0 = on the body, 1 = fin edge) or null (absent).
// Pectoral / pelvic vertices are given for the right side (+x) and mirrored.
// ---------------------------------------------------------------------------
const FIN_LAYOUT = [
  // caudal: peduncle top, peduncle bottom, upper tip, upper inner, notch, lower inner, lower tip
  { key: 'caudal', n: 7, tris: [[0, 2, 3], [0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 6]] },
  { key: 'dorsal1', n: 3, tris: [[0, 1, 2]] },
  // front base, front tip, rear tip, rear base
  { key: 'dorsal2', n: 4, tris: [[0, 1, 2], [0, 2, 3]] },
  { key: 'anal', n: 4, tris: [[0, 1, 2], [0, 2, 3]] },
  // base upper, tip, trailing edge, base lower (sickle: trailing edge concave)
  { key: 'pectoral', n: 4, mirror: true, tris: [[0, 1, 2], [0, 2, 3]] },
  { key: 'pelvic', n: 3, mirror: true, tris: [[0, 1, 2]] },
  { key: 'finletD', n: 3, tris: [[0, 1, 2]] },
  { key: 'finletA', n: 3, tris: [[0, 1, 2]] },
];

// Median fin along the top (sign 1) or bottom (-1) between zA (front) and zB.
function medianFin(B, sign, zA, zB, hFront, zTip, hRear = 0) {
  const s = sign > 0 ? B.top : B.bot;
  const base = (z) => s(z) - sign * 0.004; // sink the root into the skin
  const v = [
    [0, base(zA), zA, 0],
    [0, s(zTip) + sign * hFront, zTip, 1],
  ];
  if (hRear > 0) v.push([0, s(zB) + sign * hRear, zB + 0.004, 1]);
  v.push([0, base(zB), zB, 0]);
  return v;
}

function finlet(B, sign, z, len, h) {
  const s = sign > 0 ? B.top : B.bot;
  return [
    [0, s(z) - sign * 0.003, z, 0],
    [0, s(z - len) + sign * h, z - len * 1.15, 1],
    [0, s(z - len) - sign * 0.003, z - len, 0],
  ];
}

const FINS = {
  sardine(B) {
    const zp = B.spec.zPed;
    return {
      caudal: [
        [0, B.top(zp + 0.02), zp + 0.02, 0],
        [0, B.bot(zp + 0.02), zp + 0.02, 0],
        [0, 0.13, -0.5, 1],
        [0, 0.045, -0.425, 1],
        [0, 0, -0.39, 1],
        [0, -0.045, -0.425, 1],
        [0, -0.125, -0.495, 1],
      ],
      dorsal1: [
        [0, B.top(0.13) - 0.004, 0.13, 0],
        [0, B.top(0.08) + 0.07, 0.05, 1],
        [0, B.top(0.0) - 0.004, 0.0, 0],
      ],
      anal: medianFin(B, -1, -0.13, -0.24, 0.03, -0.15, 0.012),
      pectoral: pectoral(B, 0.33, -0.55, 0.075, 0.03, 0.4),
      pelvic: pelvic(B, 0.06, 0.05),
    };
  },
  scad(B) {
    const zp = B.spec.zPed;
    return {
      caudal: [
        [0, B.top(zp + 0.02), zp + 0.02, 0],
        [0, B.bot(zp + 0.02), zp + 0.02, 0],
        [0, 0.125, -0.5, 1],
        [0, 0.035, -0.415, 1],
        [0, 0, -0.385, 1],
        [0, -0.035, -0.415, 1],
        [0, -0.12, -0.5, 1],
      ],
      // spiny first dorsal: tall triangle
      dorsal1: [
        [0, B.top(0.23) - 0.004, 0.23, 0],
        [0, B.top(0.19) + 0.068, 0.175, 1],
        [0, B.top(0.1) - 0.004, 0.1, 0],
      ],
      // long low soft dorsal and anal, ending just ahead of the finlets
      dorsal2: medianFin(B, 1, 0.07, -0.205, 0.045, 0.035, 0.016),
      anal: medianFin(B, -1, -0.02, -0.205, 0.034, -0.045, 0.014),
      // low on the flank, laid back along the body (not sticking out sideways)
      pectoral: pectoral(B, 0.31, -0.42, 0.11, 0.03, 0.12),
      pelvic: pelvic(B, 0.2, 0.04),
      // one detached finlet behind the soft dorsal and one behind the anal
      finletD: finlet(B, 1, -0.228, 0.026, 0.021),
      finletA: finlet(B, -1, -0.228, 0.026, 0.019),
    };
  },
  jack(B) {
    const zp = B.spec.zPed;
    return {
      // big, deeply forked lunate tail on a thin peduncle
      caudal: [
        [0, B.top(zp + 0.015), zp + 0.015, 0],
        [0, B.bot(zp + 0.015), zp + 0.015, 0],
        [0, 0.215, -0.5, 1],
        [0, 0.055, -0.355, 1],
        [0, 0, -0.3, 1],
        [0, -0.055, -0.355, 1],
        [0, -0.205, -0.49, 1],
      ],
      // low spiny first dorsal
      dorsal1: [
        [0, B.top(0.19) - 0.004, 0.19, 0],
        [0, B.top(0.15) + 0.036, 0.13, 1],
        [0, B.top(0.08) - 0.004, 0.08, 0],
      ],
      // second dorsal / anal: tall falcate front lobe, long low base
      dorsal2: medianFin(B, 1, 0.05, -0.19, 0.15, -0.045, 0.022),
      anal: medianFin(B, -1, -0.005, -0.185, 0.12, -0.085, 0.02),
      // long sickle pectoral sweeping back and up past the anal origin
      pectoral: [
        [B.half(0.3) * 0.85, -0.012, 0.3, 0],
        [B.half(0.02) + 0.035, 0.018, 0.02, 1],
        [B.half(0.17) + 0.014, -0.036, 0.19, 1],
        [B.half(0.28) * 0.85, -0.052, 0.275, 0],
      ],
      pelvic: pelvic(B, 0.27, 0.05),
    };
  },
  fry(B) {
    const zp = B.spec.zPed;
    return {
      // small fan tail: rounded lobes with a shallow notch between them
      caudal: [
        [0, B.top(zp + 0.02), zp + 0.02, 0],
        [0, B.bot(zp + 0.02), zp + 0.02, 0],
        [0, 0.062, -0.462, 1],
        [0, 0.036, -0.5, 1],
        [0, 0, -0.482, 1],
        [0, -0.035, -0.5, 1],
        [0, -0.06, -0.462, 1],
      ],
      dorsal1: [
        [0, B.top(-0.04) - 0.003, -0.04, 0],
        [0, B.top(-0.09) + 0.03, -0.09, 1],
        [0, B.top(-0.16) - 0.003, -0.16, 0],
      ],
      anal: medianFin(B, -1, -0.1, -0.22, 0.022, -0.13, 0.01),
      pectoral: pectoral(B, 0.36, -0.2, 0.055, 0.025, 0.3),
    };
  },
};

// Pectoral (right side): root at z0 on the flank at height frac (−1 belly … 1
// back), swept back by len, droop dy.
function pectoral(B, z0, frac, len, dy, spread) {
  const yc = (B.top(z0) + B.bot(z0)) * 0.5;
  const hh = (B.top(z0) - B.bot(z0)) * 0.5;
  const y = yc + hh * frac;
  const x = B.half(z0) * Math.sqrt(Math.max(0, 1 - frac * frac)) * 0.9;
  return [
    [x, y + 0.006, z0, 0],
    [x + len * spread, y - dy * 0.4, z0 - len, 1],
    [x + len * spread * 0.6, y - dy, z0 - len * 0.65, 1],
    [x, y - 0.006, z0 - 0.012, 0],
  ];
}

function pelvic(B, z0, len) {
  const y = B.bot(z0) + 0.004;
  return [
    [B.half(z0) * 0.3, y, z0, 0],
    [B.half(z0) * 0.3 + len * 0.35, y - len * 0.35, z0 - len, 1],
    [B.half(z0) * 0.3, y, z0 - len * 0.5, 0],
  ];
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------
const _cA = new THREE.Color();
const _cB = new THREE.Color();

/**
 * Build every species' vertex data on the shared topology.
 * Returns { index, vertexCount, triangles, species: { name: { pos, nrm, col, aux } } }
 *   pos  xyz + body flag (1 body, 0 fin)
 *   nrm  xyz + 0
 *   col  fin colour rgb (1 on the body) + metalness factor
 *   aux  atlas uv + translucency + 0
 */
export function buildFishSpecies({ rings = 14, radial = 10 } = {}) {
  let index = null;
  const species = {};
  FISH_SPECIES.forEach((name, si) => {
    const B = bodyOf(name);
    const spec = B.spec;
    const pos = [];
    const col = [];
    const aux = [];
    const idx = [];
    const vRow = (v) => (si * ATLAS_ROWS + ATLAS_PAD + v * (ATLAS_ROWS - 2 * ATLAS_PAD)) / ATLAS_H;
    const bodyVert = (x, y, z, t, s) => {
      pos.push(x, y, z, 1);
      col.push(1, 1, 1, spec.metal);
      aux.push(Math.min(1, Math.max(0, t)), vRow((s + 1) * 0.5), spec.trans, 0);
    };
    // nose tip + rings (vertex 0 of a ring on the dorsal ridge)
    bodyVert(0, spec.noseY, 0.5 + 0.004, 0, 0);
    for (let i = 1; i <= rings; i++) {
      const t = Math.pow(i / rings, RING_BIAS);
      B.prof(t, _pf);
      const [h, hb, w] = _pf;
      const yc = B.ycOf(t);
      const z = B.zOf(t);
      for (let j = 0; j < radial; j++) {
        const a = Math.PI / 2 + (j / radial) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        bodyVert(w * c, yc + (s > 0 ? h : hb) * s, z, t, s);
      }
    }
    for (let j = 0; j < radial; j++) idx.push(0, 1 + j, 1 + ((j + 1) % radial));
    for (let i = 0; i < rings - 1; i++) {
      const r0 = 1 + i * radial;
      const r1 = r0 + radial;
      for (let j = 0; j < radial; j++) {
        const a = r0 + j;
        const b = r0 + ((j + 1) % radial);
        const c = r1 + j;
        const d = r1 + ((j + 1) % radial);
        idx.push(a, d, b, a, c, d);
      }
    }
    const lastRing = 1 + (rings - 1) * radial;
    const cap = pos.length / 4;
    bodyVert(0, B.ycOf(1), spec.zPed - 0.006, 1, 0);
    for (let j = 0; j < radial; j++) idx.push(lastRing + ((j + 1) % radial), lastRing + j, cap);

    // fins
    const fins = FINS[name](B);
    const finVert = (v, key) => {
      pos.push(v[0], v[1], v[2], 0);
      const tail = key === 'caudal' && spec.tailCol;
      const pec = key === 'pectoral' && spec.pecCol;
      _cA.fromArray(tail ? spec.tailCol : pec ? spec.pecCol : spec.finCol);
      _cB.fromArray(tail ? spec.tailTip : pec ? spec.pecTip : spec.finTip);
      _cA.lerp(_cB, v[3]);
      col.push(_cA.r, _cA.g, _cA.b, spec.finMetal);
      aux.push(0, vRow(0.5), Math.min(1, spec.finTrans * (0.6 + 0.6 * v[3])), 0);
    };
    for (const L of FIN_LAYOUT) {
      const verts = fins[L.key] ?? null;
      for (const side of L.mirror ? [1, -1] : [1]) {
        const base = pos.length / 4;
        for (let k = 0; k < L.n; k++) {
          if (verts) {
            const v = verts[k];
            finVert([v[0] * side, v[1], v[2], v[3]], L.key);
          } else {
            finVert([0, 0, 0, 0], L.key); // absent: degenerate point inside the body
          }
        }
        for (const t of L.tris) {
          if (side > 0) idx.push(base + t[0], base + t[1], base + t[2]);
          else idx.push(base + t[0], base + t[2], base + t[1]);
        }
      }
    }

    // normals from this species' shape (shared index)
    const n = pos.length / 4;
    const p3 = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      p3[k * 3] = pos[k * 4];
      p3[k * 3 + 1] = pos[k * 4 + 1];
      p3[k * 3 + 2] = pos[k * 4 + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p3, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const n3 = g.attributes.normal.array;
    const nrm = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      let x = n3[k * 3];
      let y = n3[k * 3 + 1];
      let z = n3[k * 3 + 2];
      if (x * x + y * y + z * z < 1e-8) y = 1; // degenerate (absent fin)
      nrm[k * 4] = x;
      nrm[k * 4 + 1] = y;
      nrm[k * 4 + 2] = z;
    }
    g.dispose();
    if (index && index.length !== idx.length) throw new Error('fish species topology mismatch');
    index = idx;
    species[name] = {
      pos: new Float32Array(pos),
      nrm,
      col: new Float32Array(col),
      aux: new Float32Array(aux),
      p3,
    };
  });
  const vertexCount = species[FISH_SPECIES[0]].pos.length / 4;
  return { index, vertexCount, triangles: index.length / 3, species };
}

// ---------------------------------------------------------------------------
// pattern atlas (sRGB RGB + linear alpha = silver/metalness 0..1)
// ---------------------------------------------------------------------------
const lin2srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mixC = (c, d, k) => {
  c[0] += (d[0] - c[0]) * k;
  c[1] += (d[1] - c[1]) * k;
  c[2] += (d[2] - c[2]) * k;
  c[3] += (d[3] - c[3]) * k;
};
// Disk coverage (radius r, soft edge ±soft; object units).
const disk = (dz, dy, r, soft) => 1 - sstep(r - soft, r + soft, Math.sqrt(dz * dz + dy * dy));

// Eye: dark pupil, silver/golden iris ring, thin dark rim. c = [r, g, b, metal]
// Only on the flanks (|s| small): the atlas wraps over the back and belly,
// and an eye reaching past the head outline would paint a band across them.
function paintEye(c, dz, dy, e, iris, s) {
  const d = Math.sqrt(dz * dz + dy * dy);
  if (d > e.r * 1.25) return;
  const side = 1 - sstep(0.7, 0.92, Math.abs(s));
  const soft = e.r * 0.08;
  mixC(c, [0.06, 0.07, 0.07, 0.6], (1 - sstep(e.r * 1.0, e.r * 1.2, d)) * side); // orbit rim
  mixC(c, iris, (1 - sstep(e.r * 0.86 - soft, e.r * 0.86 + soft, d)) * side);
  mixC(c, [0.004, 0.005, 0.006, 1], (1 - sstep(e.r * 0.52 - soft, e.r * 0.52 + soft, d)) * side);
}

const PAINT = {
  sardine(B, t, s, z, y, c) {
    const back = [0.02, 0.085, 0.1, 0.3];
    const flank = [0.8, 0.84, 0.87, 1];
    const belly = [0.93, 0.94, 0.95, 1];
    c.splice(0, 4, ...flank);
    mixC(c, back, sstep(0.44, 0.66, s));
    mixC(c, belly, sstep(0.3, 0.85, -s) * 0.8);
    // blue-green sheen band under the back
    mixC(c, [0.25, 0.48, 0.52, 0.9], Math.exp(-(((s - 0.36) / 0.09) ** 2)) * 0.45 * sstep(0.1, 0.25, t));
    // row of dark spots along the upper flank (absolute sizes), right under
    // the back colour: high enough that their lower edge stays clear of the
    // widest point (s = 0), so a top view keeps an unbroken silver rim instead
    // of a dashed light edge
    const yRow = B.ycOf(t) + (B.top(z) - B.ycOf(t)) * 0.46;
    for (let k = 0; k < 7; k++) {
      const zs = 0.29 - k * 0.052;
      if (Math.abs(z - zs) > 0.03) continue;
      const r = 0.0145 - k * 0.0008;
      mixC(c, [0.03, 0.05, 0.06, 0.15], disk(z - zs, y - yRow, r, 0.003) * (s > 0 ? 1 : 0));
    }
    // golden gill cover
    const gill = sstep(0.06, 0.1, t) * (1 - sstep(0.17, 0.21, t)) * (1 - sstep(0.25, 0.45, s)) * sstep(-0.7, -0.4, s);
    mixC(c, [0.85, 0.75, 0.52, 1], gill * 0.45);
    // gill slit
    mixC(c, [0.25, 0.3, 0.32, 0.6], Math.exp(-(((t - 0.205) / 0.008) ** 2)) * 0.7 * (1 - sstep(0.4, 0.6, s)));
    paintEye(c, z - B.spec.eye.z, y - B.spec.eye.y, B.spec.eye, [0.8, 0.78, 0.7, 1], s);
  },
  scad(B, t, s, z, y, c) {
    const back = [0.03, 0.07, 0.11, 0.3];
    const flank = [0.76, 0.81, 0.86, 1];
    const belly = [0.92, 0.93, 0.94, 1];
    c.splice(0, 4, ...flank);
    mixC(c, back, sstep(0.32, 0.6, s));
    mixC(c, belly, sstep(0.3, 0.85, -s) * 0.8);
    // yellow mid-flank stripe, behind the eye to the tail
    const ys = B.ycOf(t) + (B.top(z) - B.ycOf(t)) * 0.2;
    const stripe = (1 - sstep(0.007, 0.012, Math.abs(y - ys))) * sstep(0.1, 0.2, t) * (1 - sstep(0.93, 1, t));
    mixC(c, [0.95, 0.72, 0.1, 0.55], stripe * (s > -0.2 ? 1 : 0));
    // lateral line: arches from the gill cover down to the mid line, then
    // runs straight (with scutes) to the tail
    const arch = t < 0.55 ? 0.45 - 0.42 * sstep(0.2, 0.55, t) : 0.03;
    const ll = B.ycOf(t) + (B.top(z) - B.ycOf(t)) * arch;
    const llMask = sstep(0.18, 0.24, t);
    mixC(c, [0.42, 0.46, 0.5, 1], (1 - sstep(0.002, 0.004, Math.abs(y - ll))) * llMask * 0.7);
    if (t > 0.55) {
      const sc = sstep(0.55, 0.65, t);
      const band = 1 - sstep(0.004, 0.0065, Math.abs(y - ll));
      const tick = 0.5 + 0.5 * Math.cos(z * Math.PI * 2 / 0.014);
      mixC(c, [0.2, 0.23, 0.25, 0.45], band * sc * (0.55 + 0.45 * tick));
    }
    // dark opercular spot at the upper gill-cover edge
    mixC(c, [0.02, 0.025, 0.03, 0.1], disk(z - 0.375, y - (B.top(0.375) * 0.55), 0.016, 0.004));
    mixC(c, [0.25, 0.3, 0.32, 0.6], Math.exp(-(((t - 0.2) / 0.008) ** 2)) * 0.7 * (1 - sstep(0.4, 0.6, s)));
    paintEye(c, z - B.spec.eye.z, y - B.spec.eye.y, B.spec.eye, [0.82, 0.8, 0.72, 1], s);
  },
  jack(B, t, s, z, y, c) {
    const back = [0.025, 0.042, 0.055, 0.22];
    const flank = [0.74, 0.77, 0.8, 1];
    const belly = [0.88, 0.89, 0.9, 1];
    c.splice(0, 4, ...flank);
    mixC(c, back, sstep(-0.1, 0.55, s));
    mixC(c, belly, sstep(0.35, 0.9, -s) * 0.6);
    // arched lateral line over the pectoral, straight from mid body, scutes
    const arch = t < 0.58 ? 0.5 - 0.48 * sstep(0.25, 0.58, t) : 0.02;
    const yc = B.ycOf(t);
    const ll = yc + (B.top(z) - yc) * arch;
    mixC(c, [0.45, 0.48, 0.5, 1], (1 - sstep(0.002, 0.0045, Math.abs(y - ll))) * sstep(0.16, 0.22, t) * 0.7);
    if (t > 0.6) {
      const sc = sstep(0.6, 0.7, t);
      const band = 1 - sstep(0.005, 0.008, Math.abs(y - ll));
      const tick = 0.5 + 0.5 * Math.cos(z * Math.PI * 2 / 0.013);
      mixC(c, [0.12, 0.13, 0.14, 0.35], band * sc * (0.6 + 0.4 * tick));
    }
    // small black opercular spot, gill margin, darker forehead
    mixC(c, [0.02, 0.02, 0.025, 0.1], disk(z - 0.392, y - B.top(0.392) * 0.62, 0.012, 0.003));
    mixC(c, [0.2, 0.22, 0.24, 0.5], Math.exp(-(((t - 0.19) / 0.009) ** 2)) * 0.75 * (1 - sstep(0.5, 0.75, s)));
    mixC(c, [0.1, 0.12, 0.13, 0.5], (1 - sstep(0.05, 0.12, t)) * sstep(-0.1, 0.3, s) * 0.6);
    // mouth line
    const mz = 0.5 - z;
    const my = y - (B.spec.noseY - 0.004 - mz * 0.35);
    mixC(c, [0.08, 0.08, 0.09, 0.3], (1 - sstep(0.002, 0.004, Math.abs(my))) * (1 - sstep(0.04, 0.05, mz)));
    paintEye(c, z - B.spec.eye.z, y - B.spec.eye.y, B.spec.eye, [0.85, 0.78, 0.55, 1], s);
  },
  fry(B, t, s, z, y, c) {
    // see-through body (low "silver" = translucency in the shader)
    c.splice(0, 4, 0.55, 0.62, 0.6, 0.04);
    mixC(c, [0.5, 0.6, 0.6, 0.1], sstep(0.4, 0.9, s) * 0.6);
    // silver gut / swim bladder
    const gut = sstep(0.16, 0.22, t) * (1 - sstep(0.42, 0.5, t)) * sstep(0.2, 0.5, -s);
    mixC(c, [0.86, 0.88, 0.9, 1], gut);
    // spine (notochord) line and ventral melanophore dots
    const yc = B.ycOf(t);
    mixC(c, [0.42, 0.46, 0.46, 0.3], (1 - sstep(0.003, 0.006, Math.abs(y - yc))) * sstep(0.2, 0.3, t) * 0.6);
    const yb = B.bot(z) + 0.006;
    for (let k = 0; k < 9; k++) {
      const zs = 0.2 - k * 0.055;
      if (Math.abs(z - zs) > 0.02) continue;
      mixC(c, [0.03, 0.03, 0.035, 1], disk(z - zs, y - yb, 0.006, 0.002) * (s < 0 ? 1 : 0));
    }
    // dorsal melanophores, faint
    const yt = B.top(z) - 0.005;
    for (let k = 0; k < 6; k++) {
      const zs = 0.1 - k * 0.08;
      if (Math.abs(z - zs) > 0.02) continue;
      mixC(c, [0.08, 0.09, 0.09, 1], disk(z - zs, y - yt, 0.005, 0.002) * 0.7 * (s > 0 ? 1 : 0));
    }
    paintEye(c, z - B.spec.eye.z, y - B.spec.eye.y, B.spec.eye, [0.75, 0.78, 0.74, 1], s);
  },
};

/**
 * Paint the species pattern atlas. Returns { data: Uint8Array RGBA (RGB sRGB,
 * A linear silver 0..1), width, height }. Row 0 is texture v = 0.
 */
export function paintFishPatterns() {
  const W = ATLAS_W;
  const H = ATLAS_H;
  const data = new Uint8Array(W * H * 4);
  const c = [0, 0, 0, 0];
  FISH_SPECIES.forEach((name, si) => {
    const B = bodyOf(name);
    const paint = PAINT[name];
    for (let r = ATLAS_PAD; r < ATLAS_ROWS - ATLAS_PAD; r++) {
      const v = Math.min(1, Math.max(0, (r + 0.5 - ATLAS_PAD) / (ATLAS_ROWS - 2 * ATLAS_PAD)));
      const s = v * 2 - 1;
      const row = si * ATLAS_ROWS + r;
      for (let x = 0; x < W; x++) {
        const t = (x + 0.5) / W;
        const z = B.zOf(t);
        B.prof(t, _pf);
        const yc = B.ycOf(t);
        const y = yc + (s > 0 ? _pf[0] : _pf[1]) * s;
        paint(B, t, s, z, y, c);
        const o = (row * W + x) * 4;
        data[o] = Math.round(Math.min(1, Math.max(0, lin2srgb(c[0]))) * 255);
        data[o + 1] = Math.round(Math.min(1, Math.max(0, lin2srgb(c[1]))) * 255);
        data[o + 2] = Math.round(Math.min(1, Math.max(0, lin2srgb(c[2]))) * 255);
        data[o + 3] = Math.round(Math.min(1, Math.max(0, c[3])) * 255);
      }
    }
    // pad rows repeat the belly (v = 0) and back (v = 1) edge rows
    const band = si * ATLAS_ROWS;
    const rowBytes = W * 4;
    for (let r = 0; r < ATLAS_PAD; r++) {
      data.copyWithin((band + r) * rowBytes, (band + ATLAS_PAD) * rowBytes, (band + ATLAS_PAD + 1) * rowBytes);
      const top = band + ATLAS_ROWS - 1 - r;
      const edge = band + ATLAS_ROWS - ATLAS_PAD - 1;
      data.copyWithin(top * rowBytes, edge * rowBytes, (edge + 1) * rowBytes);
    }
  });
  return { data, width: W, height: H };
}

/**
 * GPU assets for FishSchools: a geometry (the sardine shape in `position` /
 * `normal`, used only for bounds — the shader reads the species' vertex from
 * `shapeTexture`), the float shape texture (width = vertex count, FISH_SHAPE_ROWS
 * rows per species in FISH_SPECIES order) and the pattern atlas.
 */
export function createFishAssets({ rings = 14, radial = 10 } = {}) {
  const built = buildFishSpecies({ rings, radial });
  const n = built.vertexCount;
  const rows = FISH_SPECIES.length * FISH_SHAPE_ROWS;
  const shape = new Float32Array(n * rows * 4);
  FISH_SPECIES.forEach((name, si) => {
    const sp = built.species[name];
    const src = [sp.pos, sp.nrm, sp.col, sp.aux];
    for (let r = 0; r < FISH_SHAPE_ROWS; r++) shape.set(src[r], (si * FISH_SHAPE_ROWS + r) * n * 4);
  });
  const shapeTexture = new THREE.DataTexture(shape, n, rows, THREE.RGBAFormat, THREE.FloatType);
  shapeTexture.name = 'AmbientLife.fishShape';
  shapeTexture.minFilter = THREE.NearestFilter;
  shapeTexture.magFilter = THREE.NearestFilter;
  shapeTexture.generateMipmaps = false;
  shapeTexture.needsUpdate = true;

  const pat = paintFishPatterns();
  const patternTexture = new THREE.DataTexture(pat.data, pat.width, pat.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  patternTexture.name = 'AmbientLife.fishPattern';
  patternTexture.colorSpace = THREE.SRGBColorSpace;
  patternTexture.wrapS = THREE.ClampToEdgeWrapping;
  patternTexture.wrapT = THREE.ClampToEdgeWrapping;
  patternTexture.magFilter = THREE.LinearFilter;
  patternTexture.minFilter = THREE.LinearMipmapLinearFilter;
  patternTexture.generateMipmaps = true;
  patternTexture.anisotropy = 4;
  patternTexture.needsUpdate = true;

  const sardine = built.species[FISH_SPECIES[0]];
  const nrm3 = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    nrm3[k * 3] = sardine.nrm[k * 4];
    nrm3[k * 3 + 1] = sardine.nrm[k * 4 + 1];
    nrm3[k * 3 + 2] = sardine.nrm[k * 4 + 2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(sardine.p3, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm3, 3));
  geo.setIndex(built.index);
  geo.computeBoundingSphere();
  return { geometry: geo, shapeTexture, patternTexture, vertexCount: n, triangles: built.triangles };
}
