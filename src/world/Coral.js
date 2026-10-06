// Sparse deep-reef life: barrel sponges (three shapes, half-buried), tube-
// sponge clusters, gorgonian sea fans and boulder (brain) corals. Muted
// colours on purpose — at 30-45 m red light is gone, so even a red sea fan
// reads as dark brown. Sponges and corals share one material with a porous,
// knobbly world-space detail normal map (textures.js makeReefTextures).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, noise3, fbm3, smoothstep, hash2 } from './noise.js';
import { LAYOUT, cliffRadius, trenchRadius, polar } from './terrain.js';
import { makeMergedBuckets } from './instancing.js';
import { TRIPLANAR_GLSL } from './waterShading.js';

const CORAL_CELL = 60; // bucket cell size (m)
const CORAL_CELL_LOW = 120; // low: fewer, coarser buckets (draw calls on a weak CPU)

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function colorize(geo, fn) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    const c = fn(_p, i);
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Drop everything but position/normal so variants can be merged. */
function stripToPN(geo) {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }
  return geo;
}

// Barrel-sponge profiles (r, y, part) for unit height: buried foot → outer
// wall → broad, rounded rim → inner wall → atrium floor. part: 0 outer wall,
// 1 rim, 2 inner wall (fractions blend).
const BARREL_PROFILE = [
  [0.29, -0.2, 0], [0.34, 0.0, 0], [0.44, 0.25, 0], [0.51, 0.5, 0], [0.55, 0.75, 0], [0.565, 0.92, 0.4],
  [0.55, 1.0, 1], [0.5, 1.045, 1], [0.445, 1.01, 1],
  [0.42, 0.88, 2], [0.34, 0.6, 2], [0.14, 0.4, 2], [0, 0.37, 2],
];
const BARREL_PROFILE_LOW = [
  [0.29, -0.2, 0], [0.38, 0.12, 0], [0.5, 0.45, 0], [0.56, 0.8, 0], [0.555, 0.98, 0.6],
  [0.5, 1.04, 1], [0.44, 1.0, 1.4],
  [0.38, 0.75, 2], [0.18, 0.45, 2], [0, 0.38, 2],
];
// Variants: classic barrel, squat wide bowl, tall and narrow with a torn rim.
const BARREL_SHAPES = [
  { flare: 1.12, height: 1.0, lean: 0.07, notch: 0.12, tint: [0.6, 0.4, 0.34] },
  { flare: 1.25, height: 0.72, lean: 0.03, notch: 0.06, tint: [0.54, 0.42, 0.37] },
  { flare: 0.88, height: 1.2, lean: 0.11, notch: 0.24, tint: [0.58, 0.37, 0.36] },
];
const SAND_RGB = [0.62, 0.58, 0.48];

/**
 * Giant barrel sponge (Xestospongia-like): a thick-walled, lopsided barrel
 * flaring to a wide mouth, its foot buried in the sand, the outside cut by
 * deep, wandering vertical ridges broken into knobs, a broad uneven rim with
 * a torn notch, and a dark atrium. A closed ring grid (no lathe seam, so the
 * normals are smooth all round); vertex colour = tint × ridge AO, silt on the
 * rim and the foot.
 */
function makeBarrelSponge(seed, lowPoly, variant) {
  const rand = mulberry32(seed);
  const shape = BARREL_SHAPES[variant];
  const prof = lowPoly ? BARREL_PROFILE_LOW : BARREL_PROFILE;
  const segs = lowPoly ? 18 : 32;
  const ridges = lowPoly ? 5 : 8; // ≥ 3.5 segments per ridge
  const o = rand() * 50;
  const notchA = rand() * Math.PI * 2;
  const leanA = rand() * Math.PI * 2;
  const rows = prof.length;
  const pos = new Float32Array(rows * segs * 3);
  const col = new Float32Array(rows * segs * 3);
  for (let j = 0; j < rows; j++) {
    const [r0, y0, part] = prof[j];
    const outer = part < 1 ? 1 - part : part < 2 ? 0.3 * (2 - part) : 0; // ridge relief weight
    const inner = Math.max(0, part - 1);
    const top = smoothstep(0.7, 1.0, y0); // the mouth: uneven rim height, notch
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Lopsided cross-section (the same for both walls: even thickness).
      const lobe = 1 + 0.1 * noise3(ca * 1.1 + o, y0 * 0.7, sa * 1.1) + 0.05 * Math.cos(2 * a + o);
      // Wandering vertical ridges, broken into knobs, fading toward the foot.
      // (The wander stays well under a ridge spacing between profile rows,
      // or the ridges zigzag into random lumps.)
      const u = (a / (Math.PI * 2)) * ridges + noise3(ca * 0.8 + o, y0 * 0.9, sa * 0.8 - o) * 0.35;
      const crest = smoothstep(0.2, 0.9, 1 - Math.abs(2 * (u - Math.floor(u)) - 1));
      const knob = 0.6 + 0.4 * noise3(ca * 3 + o, y0 * 4, sa * 3);
      const ridge = (crest * knob - 0.35) * 0.17 * smoothstep(-0.05, 0.3, y0) * outer;
      // Rim: uneven height, small crenellations where ridges end, a torn notch.
      let d = Math.abs(a - notchA) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      const rimY =
        (0.07 * noise3(ca * 1.6 + o, 2.3, sa * 1.6) + 0.03 * crest * (part >= 0.4 && part <= 1 ? 1 : 0)) * top -
        shape.notch * smoothstep(0.7, 0.0, d) * top;
      const fine = noise3(ca * 6 + o, y0 * 6, sa * 6) * 0.012;
      const flare = 1 + (shape.flare - 1) * smoothstep(0, 1, y0);
      const r = r0 * flare * lobe + ridge + fine * (r0 > 0 ? 1 : 0);
      const y = (y0 + rimY) * shape.height;
      const lean = shape.lean * Math.max(0, y) ** 2;
      const k = (j * segs + i) * 3;
      pos[k] = ca * r + Math.cos(leanA) * lean;
      pos[k + 1] = y;
      pos[k + 2] = sa * r + Math.sin(leanA) * lean;
      // Colour: ridge crests catch light, grooves and the atrium stay dark;
      // silt settles on the rim and around the buried foot.
      const mottle = 0.85 + 0.3 * noise3(ca * 4 + o, y0 * 4, sa * 4);
      let shade = (0.6 + 0.6 * crest * outer + 0.15 * (1 - outer)) * mottle;
      shade *= 1 - inner * (0.72 - 0.2 * smoothstep(0.4, 0.95, y0));
      const silt = Math.max(smoothstep(0.12, -0.08, y0) * 0.65, (part >= 0.4 && part <= 1 ? 0.35 : 0) * (0.6 + 0.4 * crest));
      for (let c = 0; c < 3; c++) col[k + c] = (shape.tint[c] * (1 - silt) + SAND_RGB[c] * silt) * shade;
    }
  }
  // Triangles: (a, c, b), (b, c, d) face outward on the outer wall (and
  // into the atrium on the inner one: out of the sponge's body either way).
  const index = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * segs + i;
      const b = j * segs + ((i + 1) % segs);
      const c = a + segs;
      const d = b + segs;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** Cluster of open tube sponges. */
function makeTubeSponges(seed, lowPoly) {
  const rand = mulberry32(seed);
  const parts = [];
  const n = 5;
  for (let i = 0; i < n; i++) {
    const h = 0.35 + rand() * 0.75;
    const r = 0.05 + rand() * 0.05;
    const g = new THREE.CylinderGeometry(r * 1.15, r * 0.8, h, lowPoly ? 6 : 9, 3, true);
    g.translate(0, h / 2, 0);
    const lean = (rand() - 0.5) * 0.4;
    g.rotateZ(lean);
    g.rotateY(rand() * Math.PI * 2);
    const a = rand() * Math.PI * 2;
    const d = rand() * 0.15;
    g.translate(Math.cos(a) * d, 0, Math.sin(a) * d);
    stripToPN(g);
    const hue = rand();
    colorize(g, (p) => {
      const t = 0.7 + p.y * 0.3;
      return hue > 0.5 ? [0.5 * t, 0.46 * t, 0.3 * t] : [0.42 * t, 0.32 * t, 0.4 * t];
    });
    parts.push(g);
  }
  return mergeGeometries(parts);
}

/** Planar branching gorgonian fan built from thin tapered segments. */
function makeSeaFan(seed, lowPoly) {
  const rand = mulberry32(seed);
  const parts = [];
  const radial = 3;
  const grow = (x, y, ang, len, rad, depth) => {
    const x2 = x + Math.sin(ang) * len;
    const y2 = y + Math.cos(ang) * len;
    const g = new THREE.CylinderGeometry(rad * 0.7, rad, len, radial, 1, true);
    g.translate(0, len / 2, 0);
    g.rotateZ(-ang);
    g.translate(x, y, (rand() - 0.5) * 0.03);
    stripToPN(g);
    parts.push(g);
    if (depth <= 0 || len < 0.04) return;
    // Mostly binary branching that keeps fanning out in one plane; the
    // finest twigs make the fan read as a dense lattice from a distance.
    const kids = depth <= 2 && rand() < 0.5 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const spread = 0.28 + rand() * 0.3;
      // Pull branches back toward vertical so the fan stays fan-shaped.
      const na = (ang + (k - (kids - 1) / 2) * spread) * 0.88 + (rand() - 0.5) * 0.15;
      grow(x2, y2, na, len * (0.74 + rand() * 0.12), rad * 0.74, depth - 1);
    }
  };
  grow(0, 0, 0, 0.26, 0.035, lowPoly ? 5 : 6);
  const geo = mergeGeometries(parts);
  return colorize(geo, (p) => {
    const t = 0.75 + p.y * 0.2;
    return [0.52 * t, 0.2 * t, 0.2 * t];
  });
}

// Brain coral: olive-tan ridges, dark green-brown valleys (sand-pale domes
// read as boulders of sand).
const BRAIN_RIDGE = [0.4, 0.35, 0.21];
const BRAIN_VALLEY = [0.12, 0.13, 0.07];

/**
 * Boulder / brain coral: a squashed dome with broad meandering valleys. The
 * valleys are domain-warped bands ~0.65 dome-radii apart, cut into the shape
 * and darkened in the vertex colour over a wide, soft profile: this mesh has
 * only 3-5 vertices per band, and narrower or finer grooves alias into zigzags
 * and blotches. Mottled, darker toward the sand.
 */
function makeBrainCoral(lowPoly) {
  const geo = new THREE.SphereGeometry(1, lowPoly ? 20 : 36, lowPoly ? 10 : 18, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const pos = geo.attributes.position;
  const valley = new Float32Array(pos.count);
  const mottle = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    const warp = fbm3(_p.x * 1.2, _p.y * 1.2, _p.z * 1.2, 2) * 2.2;
    const groove = Math.abs(Math.sin((_p.x * 3.4 + _p.z * 2.5 + warp) * 1.15));
    valley[i] = smoothstep(0.78, 0.1, groove);
    mottle[i] = 0.85 + 0.3 * noise3(_p.x * 2.2 + 7, _p.y * 2.2, _p.z * 2.2 - 3);
    const d = 1 - (1 - groove) * 0.08 + noise3(_p.x * 3, _p.y * 3, _p.z * 3) * 0.04;
    pos.setXYZ(i, _p.x * d, (_p.y - 0.12) * d * 0.7, _p.z * d);
  }
  geo.computeVertexNormals();
  stripToPN(geo);
  return colorize(geo, (p, i) => {
    const t = (0.62 + 0.38 * smoothstep(-0.08, 0.45, p.y)) * mottle[i];
    const v = valley[i];
    return BRAIN_RIDGE.map((r, c) => (r + (BRAIN_VALLEY[c] - r) * v) * t);
  });
}

export class Coral {
  constructor(env) {
    const q = env.quality;
    const hf = env.heightfield;
    const lowPoly = q === 'low';
    const rand = mulberry32(9001);
    const scale = q === 'low' ? 0.5 : q === 'medium' ? 0.8 : 1;

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, vertexColors: true });
    const reefNrm = env.textures.reef?.normal;
    if (reefNrm) {
      // Porous, knobbly skin: world-space triplanar detail normals (0.6 m
      // tile), pits darkened; faded out with distance before it can shimmer.
      const uniforms = { uReefNrm: { value: reefNrm } };
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nuniform sampler2D uReefNrm;\n${TRIPLANAR_GLSL}`)
          .replace(
            '#include <normal_fragment_maps>',
            `#include <normal_fragment_maps>
{
  vec3 rfN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
  vec3 rfW = triWeights( rfN, 4.0 );
  vec3 rfP = vEnvWorldPos / 0.6;
  float rfK = 1.0 - smoothstep( 14.0, 32.0, length( vEnvWorldPos - cameraPosition ) );
  float rfH = triSample( uReefNrm, rfP, rfW ).a;
  diffuseColor.rgb *= mix( 1.0, 0.78 + 0.3 * rfH, rfK );
  rfN = triNormal( uReefNrm, rfP, rfN, rfW, 0.75 * rfK );
  normal = normalize( ( viewMatrix * vec4( rfN, 0.0 ) ).xyz );
}`,
          );
      };
      mat.customProgramCacheKey = () => 'coral-reef';
    }
    env.patchMaterial(mat);
    const fanMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, vertexColors: true, side: THREE.DoubleSide });
    env.patchMaterial(fanMat, { causticScale: 0.7 });

    const kinds = [
      { geo: makeBarrelSponge(1, lowPoly, 0), mat, list: [] },
      { geo: makeTubeSponges(3, lowPoly), mat, list: [] },
      { geo: makeSeaFan(17, lowPoly), mat: fanMat, list: [] },
      { geo: makeBrainCoral(lowPoly), mat, list: [] },
      { geo: makeBarrelSponge(2, lowPoly, 1), mat, list: [] },
      { geo: makeBarrelSponge(5, lowPoly, 2), mat, list: [] },
    ];
    const BARREL_KINDS = [0, 4, 5];

    const place = (kind, x, z, size, { align = 0.6, sink = 0.05, upright = false, width = 1 } = {}) => {
      const y = hf.heightAt(x, z);
      hf.normalAt(x, z, _n);
      if (upright) _n.copy(_up);
      else _n.lerp(_up, 1 - align).normalize();
      _q.setFromUnitVectors(_up, _n);
      const yaw = new THREE.Quaternion().setFromAxisAngle(_up, rand() * Math.PI * 2);
      _q.multiply(yaw);
      _p.set(x, y - sink * size, z);
      _s.set(size * width, size, size * width);
      kinds[kind].list.push(_m.compose(_p, _q, _s).clone());
    };

    // Around outcrops and along the cliff foot / trench lip (hard substrate).
    const spots = [];
    for (const o of LAYOUT.outcrops) {
      for (let i = 0; i < 9; i++) {
        const a = rand() * Math.PI * 2;
        const d = o.size * (0.9 + rand() * 1.1);
        spots.push([o.x + Math.cos(a) * d, o.z + Math.sin(a) * d]);
      }
    }
    const c = LAYOUT.cliff;
    for (let i = 0; i < 50; i++) {
      const th = c.center + (rand() * 2 - 1) * (c.half - c.taper);
      const { x, z } = polar(cliffRadius(th) - 3 - rand() * 12, th);
      spots.push([x, z]);
    }
    const t = LAYOUT.trench;
    for (let i = 0; i < 30; i++) {
      const th = t.center + (rand() * 2 - 1) * (t.half - t.taper);
      const { x, z } = polar(trenchRadius(th) - 1 - rand() * 8, th);
      spots.push([x, z]);
    }
    for (let i = 0; i < 40; i++) {
      const r = 14 + Math.sqrt(rand()) * 90;
      const th = rand() * Math.PI * 2;
      const { x, z } = polar(r, th);
      spots.push([x, z]);
    }
    for (const [x, z] of spots) {
      if (rand() > scale) continue;
      if (hf.slopeAt(x, z) > 0.35) continue;
      const roll = rand();
      if (roll < 0.28) {
        // Barrel sponge, 0.6-1.8 m: shape, width and burial from a position
        // hash (the placement RNG sequence stays as it was).
        const ix = Math.round(x * 16);
        const iz = Math.round(z * 16);
        const kind = BARREL_KINDS[Math.floor(hash2(ix, iz) * 3)];
        const width = 0.85 + 0.35 * hash2(iz + 7, ix - 3);
        place(kind, x, z, 0.6 + rand() * 1.2, { align: 0.3, sink: 0.05 + 0.12 * hash2(ix - 11, iz + 5), width });
      } else if (roll < 0.5) place(1, x, z, 0.8 + rand() * 0.8, { align: 0.4 });
      else if (roll < 0.74) place(2, x, z, 1.2 + rand() * 1.6, { upright: true, sink: 0.02 });
      else place(3, x, z, 0.4 + rand() * 0.9, { align: 0.8, sink: 0.12 });
    }

    // Spatial buckets (see instancing.js): everything sharing a material in a
    // CORAL_CELL grid cell is baked into one static mesh, culled on its own.
    // Coral casts no shadow: these are 0.4-2 m pieces whose soft shadows would
    // be a few texels in the 84 m shadow box, at a large triangle cost.
    this.group = new THREE.Group();
    this.group.name = 'coral';
    this.meshes = [];
    for (const m of [mat, fanMat]) {
      const items = [];
      for (const k of kinds) if (k.mat === m) for (const matrix of k.list) items.push({ geometry: k.geo, matrix });
      if (!items.length) continue;
      const meshes = makeMergedBuckets(items, m, {
        cell: q === 'low' ? CORAL_CELL_LOW : CORAL_CELL,
        name: m === fanMat ? 'seafans' : 'coral',
        castShadow: false,
        receiveShadow: q !== 'low',
      });
      for (const mesh of meshes) {
        this.group.add(mesh);
        this.meshes.push(mesh);
      }
    }
    this.count = kinds.reduce((a, k) => a + k.list.length, 0);
  }
}

