// Boulders and rock clusters: a few displaced, fractured icosahedron variants
// plus a dense ribbed spire for the tall outcrops, scattered by transform and
// baked into spatially bucketed static meshes (see instancing.js), plus the
// shared rock material (world-space triplanar rock with silt settling on top
// faces) also used by the cliff.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm3, ridged3, mulberry32, smoothstep } from './noise.js';
import { LAYOUT, cliffRadius, trenchRadius, polar } from './terrain.js';
import { TRIPLANAR_GLSL } from './waterShading.js';
import { makeMergedBuckets } from './instancing.js';

// Bucket cell sizes (m) for the spatial split of the rocks.
const ROCK_CELL = 32;
const SMALL_CELL = 70;
const ROCK_CELL_Y = 20; // depth bands: trench-wall blocks apart from the lip above
// Low quality casts no shadows, so boulders and stones share coarser buckets:
// fewer draw calls for a weak CPU, at a few more off-screen triangles.
const LOW_CELL = 48;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Fractured boulder: noise-displaced sphere, then sliced by a few random
 * planes (flat fracture faces), with a flattened base. Vertex colour = AO.
 */
export function makeRockGeometry(seed, { detail = 4, stretch = [1, 0.8, 1], cuts = 5, rough = 1 } = {}) {
  const rand = mulberry32(seed);
  let geo = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const pos = geo.attributes.position;
  const planes = [];
  for (let i = 0; i < cuts; i++) {
    const n = new THREE.Vector3(rand() * 2 - 1, rand() * 1.4 - 0.3, rand() * 2 - 1).normalize();
    planes.push({ n, d: 0.5 + rand() * 0.32 });
  }
  const ox = rand() * 100;
  const oz = rand() * 100;
  const cav = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i).normalize();
    const big = fbm3(_p.x * 1.1 + ox, _p.y * 1.1, _p.z * 1.1 + oz, 3) * 0.32;
    const rid = ridged3(_p.x * 2.4 + oz, _p.y * 2.4 + ox, _p.z * 2.4, 3) * 0.22;
    const fine = fbm3(_p.x * 6 + ox, _p.y * 6, _p.z * 6 - oz, 2) * 0.05 * rough;
    const r = 1 + big + rid - 0.1 + fine;
    _p.multiplyScalar(r);
    _p.x *= stretch[0];
    _p.y *= stretch[1];
    _p.z *= stretch[2];
    // Fracture planes: clamp to the plane, with a little noise so faces are not mirror-flat.
    for (const pl of planes) {
      const dd = _p.dot(pl.n);
      const lim = pl.d + fine * 0.6;
      if (dd > lim) _p.addScaledVector(pl.n, lim - dd);
    }
    // Flat-ish base so it sits on the sand.
    if (_p.y < -0.35) _p.y = -0.35 + (_p.y + 0.35) * 0.3;
    pos.setXYZ(i, _p.x, _p.y, _p.z);
    cav[i] = big + rid;
  }
  geo.computeVertexNormals();
  // Ambient occlusion-ish vertex colours: crevices and the underside darker.
  const col = new Float32Array(pos.count * 3);
  const nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    const ao = THREE.MathUtils.clamp(0.62 + cav[i] * 0.9 + ny * 0.18, 0.25, 1.05);
    const under = smoothstep(-0.2, -0.36, pos.getY(i)) * 0.35;
    const a = ao * (1 - under);
    col[i * 3] = a;
    col[i * 3 + 1] = a;
    col[i * 3 + 2] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** Polynomial smooth minimum (blend radius k). */
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

/**
 * Pinnacle: a weathered spire for the tall outcrops (8-13 m). A lumpy column
 * tapering to a narrow, rounded crown, cut by wandering vertical runnels
 * (sharp ribs between rounded grooves), a few strata ledges, and two or three
 * steep fracture faces with softened edges; broad flattened base. Built on a
 * dense UV sphere (more segments around than up: the ribs run vertically) —
 * the boulder recipe (hard plane cuts on a 500-triangle icosahedron) read as
 * a faceted pyramid at this size. Vertex colour = AO.
 */
export function makePinnacleGeometry(seed, lowPoly = false) {
  const rand = mulberry32(seed);
  let geo = new THREE.SphereGeometry(1, lowPoly ? 22 : 40, lowPoly ? 14 : 24);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo); // weld the seam and the poles
  const pos = geo.attributes.position;
  const o = rand() * 100;
  const planes = [];
  const cuts = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < cuts; i++) {
    const a = rand() * Math.PI * 2;
    planes.push({ n: new THREE.Vector3(Math.cos(a), 0.1 + rand() * 0.2, Math.sin(a)).normalize(), d: 0.58 + rand() * 0.14 });
  }
  const cav = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i).normalize();
    const h = _p.y * 0.5 + 0.5; // 0 bottom .. 1 top
    const big = fbm3(_p.x * 1.3 + o, _p.y * 1.1, _p.z * 1.3 - o, 3) * 0.36;
    // Runnels: ridged noise squeezed vertically → vertical ribs.
    const rib = ridged3(_p.x * 2.6 + o, _p.y * 0.75 - o, _p.z * 2.6, 3);
    // Strata: thin overhanging ledges at wavy heights.
    const band = h * 5.5 + fbm3(_p.x * 1.1, o, _p.z * 1.1, 2) * 0.9;
    const fr = band - Math.floor(band);
    const ledge = smoothstep(0.72, 0.9, fr) * (1 - smoothstep(0.9, 1, fr)) * smoothstep(0.15, 0.3, h);
    const fine = fbm3(_p.x * 6 + o, _p.y * 5, _p.z * 6, 2) * 0.04;
    _p.multiplyScalar(0.9 + big + rib * 0.22 + ledge * 0.08 + fine);
    // Column: tall, narrowing a little toward a broad, knobbly crown (a
    // tower, not a cone: the top is squashed rather than drawn to a point).
    const taper = 1 - 0.26 * smoothstep(-0.4, 1.0, _p.y);
    _p.x *= 0.84 * taper;
    _p.z *= 0.88 * taper;
    _p.y = _p.y > 0.5 ? 0.5 + (_p.y - 0.5) * 0.45 : _p.y;
    _p.y *= 1.85;
    // Fracture faces, edges rounded off by a smooth clamp.
    for (const pl of planes) {
      const dd = _p.dot(pl.n);
      const lim = pl.d + fine * 0.8;
      if (dd > lim - 0.14) _p.addScaledVector(pl.n, smin(dd, lim, 0.14) - dd);
    }
    // Flat-ish base so it sits on the sand.
    if (_p.y < -0.35) _p.y = -0.35 + (_p.y + 0.35) * 0.3;
    pos.setXYZ(i, _p.x, _p.y, _p.z);
    cav[i] = big + (rib - 0.45) * 0.3 - ledge * 0.05;
  }
  geo.computeVertexNormals();
  const col = new Float32Array(pos.count * 3);
  const nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    // Crevices and the undersides of ledges darker, the foot darker still.
    const ao = THREE.MathUtils.clamp(0.72 + cav[i] * 0.9 + ny * 0.2, 0.25, 1.05);
    const a = ao * (1 - smoothstep(-0.2, -0.36, pos.getY(i)) * 0.35);
    col[i * 3] = a;
    col[i * 3 + 1] = a;
    col[i * 3 + 2] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Rock material: triplanar rock albedo/normal in world space, sediment and a
 * dull algal film on upward faces, vertex-colour AO, env caustics/absorption.
 */
export function createRockMaterial(env, { tint = 0xffffff, siltAmount = 1, scale = 6.5, far = false } = {}) {
  const tex = env.textures;
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.92,
    metalness: 0,
    vertexColors: true,
  });
  const uniforms = {
    uRockAlb: { value: tex.rock.albedo },
    uRockNrm: { value: tex.rock.normal },
    uSandAlb: { value: tex.sand.albedo },
    uVarTex: { value: tex.variation },
  };
  if (far) return createRockFarMaterial(env, mat, uniforms, siltAmount, scale);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uRockAlb;
uniform sampler2D uRockNrm;
uniform sampler2D uSandAlb;
uniform sampler2D uVarTex;
${TRIPLANAR_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec3 rkWP = vEnvWorldPos;
vec3 rkGeoN = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz );
vec3 rkTw = triWeights( rkGeoN, 5.0 );
vec3 rkP = rkWP / ${scale.toFixed(2)};
vec3 rkAlb = triSample( uRockAlb, rkP, rkTw ).rgb;
vec4 rkVar = texture2D( uVarTex, rkWP.xz / 37.0 + rkWP.y / 53.0 );
// Sediment settles on top faces; a dull green-brown film elsewhere.
float rkTop = smoothstep( 0.45, 0.85, rkGeoN.y + ( rkVar.b - 0.5 ) * 0.5 ) * ${siltAmount.toFixed(2)};
vec3 rkSilt = texture2D( uSandAlb, rkWP.xz / 4.0 ).rgb * vec3( 0.72, 0.72, 0.64 );
vec3 rkFilm = mix( vec3( 1.0 ), vec3( 0.78, 0.86, 0.66 ), smoothstep( 0.4, 0.75, rkVar.g ) * 0.8 );
rkAlb = mix( rkAlb * rkFilm, rkSilt, rkTop * 0.85 );
rkAlb *= 0.8 + 0.4 * rkVar.r;
diffuseColor.rgb *= rkAlb;
`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `
{
  vec3 rkN = triNormal( uRockNrm, rkP, rkGeoN, rkTw, 0.85 * ( 1.0 - rkTop * 0.6 ) );
  normal = normalize( ( viewMatrix * vec4( rkN, 0.0 ) ).xyz );
}
`,
      );
    env.patchShader(shader, { causticScale: 1.0 });
  };
  mat.customProgramCacheKey = () => `rock|${env.quality}|${siltAmount}|${scale}`;
  return mat;
}

/**
 * Fog-LOD rock shading (`far: true`) for surfaces wholly beyond the ≥ 97.5 %
 * veil (see FOG_LOD_X): mean rock / sand albedo (1×1 mips) with the same silt,
 * film and AO terms, geometric normal, no caustics. Matches the full shader
 * on average, so the switch is invisible under the fog.
 */
function createRockFarMaterial(env, mat, uniforms, siltAmount, scale) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uRockAlb;
uniform sampler2D uSandAlb;
uniform sampler2D uVarTex;`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec3 rkWP = vEnvWorldPos;
vec3 rkGeoN = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz );
vec3 rkAlb = textureLod( uRockAlb, vec2( 0.5 ), 16.0 ).rgb;
vec4 rkVar = texture2D( uVarTex, rkWP.xz / 37.0 + rkWP.y / 53.0 );
float rkTop = smoothstep( 0.45, 0.85, rkGeoN.y + ( rkVar.b - 0.5 ) * 0.5 ) * ${siltAmount.toFixed(2)};
vec3 rkSilt = textureLod( uSandAlb, vec2( 0.5 ), 16.0 ).rgb * vec3( 0.72, 0.72, 0.64 );
vec3 rkFilm = mix( vec3( 1.0 ), vec3( 0.78, 0.86, 0.66 ), smoothstep( 0.4, 0.75, rkVar.g ) * 0.8 );
rkAlb = mix( rkAlb * rkFilm, rkSilt, rkTop * 0.85 );
rkAlb *= 0.8 + 0.4 * rkVar.r;
diffuseColor.rgb *= rkAlb;
`,
      );
    env.patchShader(shader, { caustics: false });
  };
  mat.customProgramCacheKey = () => `rock|${env.quality}|${siltAmount}|${scale}|far`;
  return mat;
}

/**
 * Scatter boulders: cliff-foot talus, trench-lip rubble, outcrop clusters,
 * the wreck surroundings and a sparse field.
 */
export class Rocks {
  constructor(env) {
    this.env = env;
    const q = env.quality;
    const hf = env.heightfield;
    const rand = mulberry32(777);
    const detail = q === 'low' ? 3 : 4;
    this.geometries = [
      makeRockGeometry(11, { detail, stretch: [1.15, 0.75, 1.0], cuts: 6 }),
      makeRockGeometry(23, { detail, stretch: [1.3, 0.5, 1.1], cuts: 7 }),
      makeRockGeometry(37, { detail, stretch: [0.9, 1.05, 0.95], cuts: 8 }),
      makePinnacleGeometry(51, q === 'low'), // the tall outcrops' spires
      makeRockGeometry(67, { detail: 2, stretch: [1.1, 0.7, 0.95], cuts: 5, rough: 0.5 }), // small stones
    ];
    this.material = createRockMaterial(env);

    const lists = [[], [], [], [], []];
    const density = q === 'low' ? 0.55 : q === 'medium' ? 0.8 : 1;
    const add = (variant, x, z, size, opts = {}) => {
      const y = hf.heightAt(x, z);
      const tall = opts.tall ?? 1;
      const sink = opts.sink ?? 0.22;
      _p.set(x, y - size * sink * tall, z);
      if (opts.tilt !== false) {
        hf.normalAt(x, z, _n);
        _n.lerp(_up, 0.5).normalize();
        _q.setFromUnitVectors(_up, _n);
      } else _q.identity();
      const yaw = rand() * Math.PI * 2;
      _e.set((rand() - 0.5) * 0.35, yaw, (rand() - 0.5) * 0.35);
      const q2 = new THREE.Quaternion().setFromEuler(_e);
      _q.multiply(q2);
      _s.set(size * (0.85 + rand() * 0.3), size * tall * (0.85 + rand() * 0.3), size * (0.85 + rand() * 0.3));
      // Small stones never need the dense mesh.
      if (variant < 3 && size < 0.9) variant = 4;
      lists[variant].push(new THREE.Matrix4().compose(_p, _q, _s));
    };

    // 1) Talus along the foot of the cliff (big near the wall).
    const c = LAYOUT.cliff;
    const nTalus = Math.round(110 * density);
    for (let i = 0; i < nTalus; i++) {
      const th = c.center + (rand() * 2 - 1) * (c.half - c.taper * 0.4);
      const R = cliffRadius(th);
      const back = Math.pow(rand(), 1.6) * 16;
      const r = R - 1.5 - back;
      const { x, z } = polar(r, th);
      const size = (0.5 + Math.pow(rand(), 2.2) * 4.2) * (1 - back / 26);
      add(Math.floor(rand() * 3), x, z, size);
    }
    // 2) Rubble along the trench lip, some perched right on the edge.
    const t = LAYOUT.trench;
    const nLip = Math.round(70 * density);
    for (let i = 0; i < nLip; i++) {
      const th = t.center + (rand() * 2 - 1) * (t.half - t.taper * 0.3);
      const R = trenchRadius(th);
      const r = R - 7 + rand() * 9;
      const { x, z } = polar(r, th);
      const size = 0.4 + Math.pow(rand(), 2.5) * 2.6;
      add(Math.floor(rand() * 3), x, z, size);
    }
    // Blocks that broke off and lodged on the trench wall's ledges.
    for (let i = 0; i < Math.round(45 * density); i++) {
      const th = t.center + (rand() * 2 - 1) * (t.half - t.taper);
      const r = trenchRadius(th) + 2 + rand() * 22;
      const { x, z } = polar(r, th);
      add(Math.floor(rand() * 3), x, z, 1.5 + rand() * 4.5, { sink: 0.4 });
    }
    // 3) Outcrops: one dominant (often a pinnacle) + satellites.
    for (const o of LAYOUT.outcrops) {
      const main = o.tall > 1.3 ? 3 : 0;
      add(main, o.x, o.z, o.size * 0.75, { tall: o.tall * (main === 3 ? 0.75 : 1), sink: 0.15, tilt: false });
      const sat = Math.round((5 + rand() * 4) * (q === 'low' ? 0.6 : 1));
      for (let k = 0; k < sat; k++) {
        const a = rand() * Math.PI * 2;
        const d = o.size * (0.45 + rand() * 0.75);
        add(Math.floor(rand() * 3), o.x + Math.cos(a) * d, o.z + Math.sin(a) * d, o.size * (0.18 + rand() * 0.35), { tall: 0.8 + rand() * 0.6 });
      }
    }
    // 4) Around the wreck (debris field).
    const w = LAYOUT.wreck;
    for (let i = 0; i < Math.round(8 * density); i++) {
      const a = rand() * Math.PI * 2;
      const d = 6 + rand() * 9;
      add(Math.floor(rand() * 3), w.x + Math.cos(a) * d, w.z + Math.sin(a) * d, 0.4 + rand() * 1.1);
    }
    // 5) Sparse field stones (keep the inner ring mostly clear).
    const nField = Math.round(130 * density);
    for (let i = 0; i < nField; i++) {
      const r = 9 + Math.sqrt(rand()) * 100;
      const th = rand() * Math.PI * 2;
      const { x, z } = polar(r, th);
      if (hf.slopeAt(x, z) > 0.25) continue;
      const big = r > 22 ? 1.4 : 0.6;
      add(Math.floor(rand() * 3), x, z, (0.2 + Math.pow(rand(), 3) * 1.6) * big);
    }

    // Spatial buckets (see instancing.js): all variants in a ROCK_CELL grid
    // cell are baked into one static mesh, so the camera, the shadow box and
    // the fog-distance cull skip whole groups of boulders for one draw call
    // per visible cell. The small stones (variant 4) are too small to cast a
    // useful shadow at ~4 cm per shadow texel: they get their own coarser,
    // non-casting buckets. On low nothing casts, so everything shares
    // LOW_CELL buckets.
    const big = [];
    const small = [];
    lists.forEach((list, i) => {
      for (const matrix of list) (i === 4 ? small : big).push({ geometry: this.geometries[i], matrix });
    });
    this.meshes =
      q === 'low'
        ? makeMergedBuckets([...big, ...small], this.material, { cell: LOW_CELL, name: 'rocks', castShadow: false, receiveShadow: true })
        : [
            ...makeMergedBuckets(big, this.material, { cell: ROCK_CELL, cellY: ROCK_CELL_Y, name: 'rocks', castShadow: true, receiveShadow: true }),
            ...makeMergedBuckets(small, this.material, { cell: SMALL_CELL, name: 'stones', castShadow: false, receiveShadow: true }),
          ];
    this.group = new THREE.Group();
    this.group.name = 'rocks';
    for (const mesh of this.meshes) this.group.add(mesh);
    this.instanceCount = lists.reduce((a, l) => a + l.length, 0);
  }
}

