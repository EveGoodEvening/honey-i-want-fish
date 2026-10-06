// Procedural small schooling fish (sardine / scad / jack silhouette).
//
// Unit length along +Z: nose at z = +0.5, forked tail tips at z = -0.5.
// Forward axis is +Z (matches Object3D.lookAt for non-camera objects).
// Laterally compressed spindle body + forked caudal fin + dorsal and anal
// fins. Vertex colours bake a counter-shaded pattern: dark blue-green back,
// bright silver flanks, white belly and a faint lateral line. The tail wag is
// done in the vertex shader (FishSchools) using position.z.
import * as THREE from 'three';

// nose → caudal peduncle profile: [t, halfHeight, halfWidth, yCentre]
const PROFILE = [
  [0.0, 0.0, 0.0, -0.004],
  [0.04, 0.04, 0.024, -0.004],
  [0.12, 0.074, 0.042, -0.006],
  [0.26, 0.098, 0.05, -0.008],
  [0.42, 0.1, 0.048, -0.008],
  [0.58, 0.088, 0.04, -0.006],
  [0.74, 0.06, 0.027, -0.002],
  [0.88, 0.034, 0.015, 0.0],
  [1.0, 0.024, 0.01, 0.0],
];
const BODY_FRONT = 0.5;
const BODY_BACK = -0.31;

function sampleProfile(t) {
  for (let i = 1; i < PROFILE.length; i++) {
    if (t <= PROFILE[i][0]) {
      const a = PROFILE[i - 1];
      const b = PROFILE[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      const s = k * k * (3 - 2 * k);
      return [a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, a[3] + (b[3] - a[3]) * s];
    }
  }
  const l = PROFILE[PROFILE.length - 1];
  return [l[1], l[2], l[3]];
}

const BACK = new THREE.Color(0.035, 0.075, 0.095);
const FLANK = new THREE.Color(0.78, 0.83, 0.86);
const BELLY = new THREE.Color(0.92, 0.93, 0.94);
const LATERAL = new THREE.Color(0.42, 0.5, 0.55);
const FIN = new THREE.Color(0.32, 0.4, 0.44);
const _c = new THREE.Color();

export function createFishGeometry({ rings = 14, radial = 10 } = {}) {
  const pos = [];
  const col = [];
  const idx = [];

  // --- body: nose tip + rings ---
  pos.push(0, -0.004, BODY_FRONT + 0.005);
  col.push(FLANK.r, FLANK.g, FLANK.b);
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    const [h, w, yc] = sampleProfile(t);
    const z = BODY_FRONT + (BODY_BACK - BODY_FRONT) * t;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      pos.push(w * c, yc + h * s, z);
      // counter-shading: s = 1 top, -1 bottom
      const back = THREE.MathUtils.smoothstep(s, 0.15, 0.75);
      const belly = THREE.MathUtils.smoothstep(-s, 0.3, 0.9);
      _c.copy(FLANK).lerp(BACK, back).lerp(BELLY, belly * 0.8);
      // thin darker lateral line just above the mid flank
      const lateral = Math.exp(-Math.pow((s - 0.2) / 0.08, 2)) * (0.3 + 0.5 * t);
      _c.lerp(LATERAL, lateral * 0.5);
      // darker head top/snout
      if (t < 0.15) _c.multiplyScalar(0.85 + t);
      col.push(_c.r, _c.g, _c.b);
    }
  }
  // nose fan
  for (let j = 0; j < radial; j++) {
    const a = 1 + j;
    const b = 1 + ((j + 1) % radial);
    idx.push(0, a, b);
  }
  // body quads
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
  // close the peduncle
  const lastRing = 1 + (rings - 1) * radial;
  const tailCap = pos.length / 3;
  const [, , ycTail] = sampleProfile(1);
  pos.push(0, ycTail, BODY_BACK - 0.008);
  col.push(FIN.r, FIN.g, FIN.b);
  for (let j = 0; j < radial; j++) {
    idx.push(lastRing + ((j + 1) % radial), lastRing + j, tailCap);
  }

  // --- flat fins (double sided material) ---
  const fin = (verts, tris) => {
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      col.push(FIN.r, FIN.g, FIN.b);
    }
    for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2]);
  };
  // forked caudal fin
  fin(
    [
      [0, 0.024, BODY_BACK + 0.02], // 0 peduncle top
      [0, -0.022, BODY_BACK + 0.02], // 1 peduncle bottom
      [0, 0.14, -0.5], // 2 upper lobe tip
      [0, 0.05, -0.43], // 3 upper inner
      [0, 0.0, -0.4], // 4 fork notch
      [0, -0.05, -0.43], // 5 lower inner
      [0, -0.135, -0.495], // 6 lower lobe tip
    ],
    [
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 1],
      [1, 4, 5],
      [1, 5, 6],
    ],
  );
  // dorsal fin
  fin(
    [
      [0, 0.09, 0.08],
      [0, 0.17, 0.0],
      [0, 0.085, -0.08],
    ],
    [[0, 1, 2]],
  );
  // anal fin
  fin(
    [
      [0, -0.07, -0.1],
      [0, -0.12, -0.16],
      [0, -0.055, -0.2],
    ],
    [[0, 1, 2]],
  );
  // pectoral fins (small, swept back, slightly drooping)
  for (const sx of [-1, 1]) {
    fin(
      [
        [sx * 0.04, -0.03, 0.3],
        [sx * 0.1, -0.06, 0.2],
        [sx * 0.04, -0.045, 0.22],
      ],
      [[0, 1, 2]],
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
