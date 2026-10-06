// Seabed terrain: the Heightfield grid rendered 1:1 (same vertices, same
// triangle split), shaded with world-space sand (two scales, rotated, to kill
// tiling), dark silt patches and triplanar rock on steep slopes.
//
// Draw lists (tileLists.js). The grid is one shared vertex buffer cut into
// SEABED_TILES² small square tiles (index ranges, ~10 m), sorted per camera
// position into three lists, one mesh / draw call each:
//   rock / sand — "near" tiles (any part within the fog-LOD distance), full
//                 shading and shadows; tiles whose ground never gets steep
//                 enough for rock use the sand-only variant;
//   far         — wholly beyond it (≥ 97.5 % veil): the cheap fog-LOD shader.
// Tiles wholly in opaque fog are dropped. The lists are re-sorted only after
// the camera has moved HYSTERESIS metres (classified with that margin). Small
// tiles keep the near shading to what is really near: with one mesh per big
// tile, a tile grazing the LOD distance shaded tens of metres of fogged floor
// at full cost.
//
// Seamless LOD: the near shader fades its detail (sand / rock texture, normal
// maps, caustics) out over the last stretch before the LOD distance, reaching
// *exactly* the far shader's result (mean albedos, geometric normal, no
// caustics — same code path) there. A tile only goes far when wholly beyond
// it, so the switch can never show (shadows aside, which end there as before
// under a ≥ 97.5 % veil).
import * as THREE from 'three';
import { TRIPLANAR_GLSL, FOG_OPAQUE_X, FOG_LOD_X } from './waterShading.js';
import { textureMeanLinear } from './textures.js';
import { TileLists } from './tileLists.js';

export const SEABED_TILES = 40;

// Seabed LOD in fog units (x = fogDensity·dist, see FOG_CURVE): detail fades
// from SEABED_FADE_X (≈ 48 m, 92.6 % green veil) to FOG_LOD_X (≈ 59 m,
// 97.5 %), where the far shader takes over.
export const SEABED_FADE_X = 1.45;
const HYSTERESIS = 4; // metres the camera may move before the lists are re-sorted

// Rock appears where slope + (noise − 0.5)·0.22 > 0.2 (see the shader), i.e.
// nowhere with slope below 0.09. Interpolated normals are never steeper than
// the steepest vertex of their triangle, so a tile whose vertices all stay
// under this can skip rock entirely.
const ROCK_SLOPE_MIN = 0.085;

// Draw lists.
const ROCK = 0;
const SAND = 1;
const FAR = 2;

/**
 * Shared vertex buffer for the whole grid plus a tile-major index buffer:
 * tile t owns indices [start[t], start[t] + len[t]). Smooth normals from
 * central differences on the full grid, so tiles shade seamlessly. Tile
 * borders fall on whole grid cells, so the triangle split matches
 * Heightfield.heightAt() exactly.
 */
export function buildSeabedGrid(hf, tiles = SEABED_TILES) {
  const n = hf.segments;
  const row = n + 1;
  const h = hf.heights;
  const cell = hf.cell;
  const pos = new Float32Array(row * row * 3);
  const nor = new Float32Array(row * row * 3);
  for (let iz = 0; iz < row; iz++) {
    for (let ix = 0; ix < row; ix++) {
      const i = iz * row + ix;
      pos[i * 3] = -hf.half + ix * cell;
      pos[i * 3 + 1] = h[i];
      pos[i * 3 + 2] = -hf.half + iz * cell;
      const nx = h[iz * row + Math.max(ix - 1, 0)] - h[iz * row + Math.min(ix + 1, n)];
      const ny = 2 * cell;
      const nz = h[Math.max(iz - 1, 0) * row + ix] - h[Math.min(iz + 1, n) * row + ix];
      const inv = 1 / Math.hypot(nx, ny, nz);
      nor[i * 3] = nx * inv;
      nor[i * 3 + 1] = ny * inv;
      nor[i * 3 + 2] = nz * inv;
    }
  }

  const IndexArray = row * row > 65535 ? Uint32Array : Uint16Array;
  const index = new IndexArray(n * n * 6);
  const count = tiles * tiles;
  const start = new Uint32Array(count);
  const len = new Uint32Array(count);
  const box = new Float32Array(count * 6); // minX, minY, minZ, maxX, maxY, maxZ
  const rock = new Uint8Array(count);
  const edges = [];
  for (let t = 0; t <= tiles; t++) edges.push(Math.round((t * n) / tiles));
  let k = 0;
  for (let tz = 0; tz < tiles; tz++) {
    for (let tx = 0; tx < tiles; tx++) {
      const t = tz * tiles + tx;
      const x0 = edges[tx];
      const x1 = edges[tx + 1];
      const z0 = edges[tz];
      const z1 = edges[tz + 1];
      start[t] = k;
      for (let iz = z0; iz < z1; iz++) {
        for (let ix = x0; ix < x1; ix++) {
          const a = iz * row + ix;
          const b = a + row;
          index[k++] = a;
          index[k++] = b;
          index[k++] = a + 1;
          index[k++] = b;
          index[k++] = b + 1;
          index[k++] = a + 1;
        }
      }
      len[t] = k - start[t];
      let minY = Infinity;
      let maxY = -Infinity;
      let minNy = 1;
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const g = iz * row + ix;
          if (h[g] < minY) minY = h[g];
          if (h[g] > maxY) maxY = h[g];
          if (nor[g * 3 + 1] < minNy) minNy = nor[g * 3 + 1];
        }
      }
      box.set([-hf.half + x0 * cell, minY, -hf.half + z0 * cell, -hf.half + x1 * cell, maxY, -hf.half + z1 * cell], t * 6);
      rock[t] = 1 - minNy > ROCK_SLOPE_MIN ? 1 : 0;
    }
  }
  return { pos, nor, index, start, len, box, rock, count };
}

/** Linear mean albedos the far shader (and the near one, faded out) uses. */
function meanAlbedos(env) {
  const sand = textureMeanLinear(env.textures.sand.albedo);
  // Fold in the near shader's second sand scale: mix(s, s·s2·1.9, 0.45) with
  // s2 ≈ s on average.
  if (env.quality !== 'low') sand.multiply(new THREE.Color(1, 1, 1).lerp(sand.clone().multiplyScalar(1.9), 0.45));
  const rock = textureMeanLinear(env.textures.rock.albedo).multiply(new THREE.Color(0.78, 0.8, 0.78));
  return { sand, rock };
}

/**
 * Fragment code (`#include <map_fragment>` replacement) shared by the near
 * and far shaders, so that the near one at full fade is the far one exactly:
 * large-scale variation, silt, the rock weight from slope, and the albedo,
 * with the texture detail mixed toward the mean by sbFade (far: const 1).
 */
function albedoGLSL({ rock, far, hq }) {
  return /* glsl */ `
vec3 sbWP = vEnvWorldPos;
vec3 sbGeoN = normalize( ( vec4( normalize( vNormal ), 0.0 ) * viewMatrix ).xyz );
${far ? 'const float sbFade = 1.0;' : 'float sbFade = smoothstep( uSbLod.x, uSbLod.y, length( sbWP - cameraPosition ) );'}
vec4 sbVar = texture2D( uVarTex, sbWP.xz / 110.0 );
// Rock where the ground is steep (cliff foot, trench wall), broken up by noise.
float sbRock = 0.0;
${rock ? 'sbRock = smoothstep( 0.2, 0.42, ( 1.0 - sbGeoN.y ) + ( texture2D( uVarTex, sbRot( sbWP.xz ) / 31.0 + 0.37 ).g - 0.5 ) * 0.22 );' : ''}
vec3 sbSand = uSbSandMean;
${far ? '' : `// Sand: two scales + a rotated copy so the 5 m tile never reads as a grid.
vec2 sbUvA = sbWP.xz / 5.0;
vec2 sbUvB = sbRot( sbWP.xz ) / 13.0 + 0.5;
vec3 sbSandD = texture2D( uSandAlb, sbUvA ).rgb;
${hq ? 'sbSandD = mix( sbSandD, sbSandD * texture2D( uSandAlb, sbUvB ).rgb * 1.9, 0.45 );' : ''}
sbSand = mix( sbSandD, sbSand, sbFade );`}
// Large silt / detritus patches: darker, greyer, faintly green.
float sbSilt = smoothstep( 0.42, 0.72, sbVar.r ) * 0.85;
sbSand = mix( sbSand, sbSand * vec3( 0.42, 0.45, 0.40 ), sbSilt );
sbSand *= 0.85 + 0.3 * sbVar.a;
sbSand = mix( sbSand, sbSand * vec3( 0.75, 0.82, 0.68 ), smoothstep( 0.55, 0.8, sbVar.g ) * 0.6 );
vec3 sbAlb = sbSand;
${rock && !far ? `// Rock albedo: only fetched where it can show. Gradients are taken outside
// the (spatially coherent) branch so mip selection stays correct.
vec3 sbP = sbWP / 7.5;
vec3 sbPdx = dFdx( sbP );
vec3 sbPdy = dFdy( sbP );
vec3 sbTw = triWeights( sbGeoN, 4.0 );` : ''}
${rock ? `if ( sbRock > 0.003 ) {
  vec3 sbRockC = uSbRockMean;
  ${far ? '' : 'sbRockC = mix( triSampleGrad( uRockAlb, sbP, sbTw, sbPdx, sbPdy ).rgb * vec3( 0.78, 0.8, 0.78 ), sbRockC, sbFade );'}
  sbAlb = mix( sbSand, sbRockC, sbRock );
}` : ''}
diffuseColor.rgb *= sbAlb;
`;
}

/**
 * Seabed material. `env` provides textures, shared uniforms and the common
 * caustics/absorption patch; `lod` the shared { uSbLod, uSbSandMean,
 * uSbRockMean } uniforms. `rock: false` builds the cheaper sand-only variant
 * for tiles that never get steep; `far: true` the fog-LOD shader for tiles
 * wholly beyond the LOD distance (mean albedos, geometric normal, no
 * caustics), which the near one fades into.
 */
export function createSeabedMaterial(env, lod, { rock = true, far = false } = {}) {
  const tex = env.textures;
  const hq = env.quality !== 'low';
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0 });
  mat.name = far ? 'SeabedFar' : rock ? 'SeabedRock' : 'SeabedSand';
  mat.dithering = true;
  const uniforms = {
    uSandAlb: { value: tex.sand.albedo },
    uSandNrm: { value: tex.sand.normal },
    uRockAlb: { value: tex.rock.albedo },
    uRockNrm: { value: tex.rock.normal },
    uVarTex: { value: tex.variation },
    ...lod,
  };
  const normalGLSL = /* glsl */ `
{
  // Top-projected sand normals, whiteout-blended over the geometric normal.
  vec3 tA = texture2D( uSandNrm, sbUvA ).xyz * 2.0 - 1.0;
  ${hq ? 'vec3 tB = texture2D( uSandNrm, sbUvB ).xyz * 2.0 - 1.0; tB.xy = mat2( 0.8, 0.6, -0.6, 0.8 ) * tB.xy; tA.xy = tA.xy * 0.85 + tB.xy * 0.45;' : ''}
  tA.xy *= mix( 1.0, 0.35, sbSilt ); // silt smooths the ripples out
  vec3 sbN = normalize( vec3( tA.x + sbGeoN.x, sbGeoN.y * abs( tA.z ), tA.y + sbGeoN.z ) );
  ${rock ? `if ( sbRock > 0.003 ) {
    vec3 sbRockN = triNormalGrad( uRockNrm, sbP, sbGeoN, sbTw, 1.3, sbPdx, sbPdy );
    sbN = normalize( mix( sbN, sbRockN, sbRock ) );
  }` : ''}
  sbN = normalize( mix( sbN, sbGeoN, sbFade ) ); // far: the geometric normal
  normal = normalize( ( viewMatrix * vec4( sbN, 0.0 ) ).xyz );
}
`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let fs = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uSandAlb;
uniform sampler2D uSandNrm;
uniform sampler2D uRockAlb;
uniform sampler2D uRockNrm;
uniform sampler2D uVarTex;
uniform vec2 uSbLod; // detail fade start / end distance (m)
uniform vec3 uSbSandMean;
uniform vec3 uSbRockMean;
${TRIPLANAR_GLSL}
vec2 sbRot( vec2 p ) { return mat2( 0.8, -0.6, 0.6, 0.8 ) * p; }`,
      )
      // The far shader serves every tile, rock or not.
      .replace('#include <map_fragment>', albedoGLSL({ rock: rock || far, far, hq }))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix( 0.97, 0.85, sbRock );');
    if (!far) fs = fs.replace('#include <normal_fragment_maps>', normalGLSL);
    shader.fragmentShader = fs;
    // Near: caustics fade out with the detail (the far shader has none).
    env.patchShader(shader, far ? { caustics: false } : { causticScale: 1.0, causticMask: '( 1.0 - sbFade )' });
  };
  mat.customProgramCacheKey = () => `seabed|${env.quality}|${far ? 'far' : rock ? 'rock' : 'sand'}`;
  return mat;
}

/**
 * The seabed: materials, the shared grid and its draw lists (see the header
 * and tileLists.js). `group` holds one mesh per list; update() runs before
 * every render of the scene (Environment._cullFar).
 */
export class Seabed {
  constructor(env) {
    // Lists are classified with the base fog density: the live one only ever
    // rises above it (murk near the bottom), which only shortens distances.
    this.baseDensity = env.fogDensity;
    const M = HYSTERESIS;
    const nearR = FOG_LOD_X / this.baseDensity + M;
    const keepR = FOG_OPAQUE_X / this.baseDensity + M;
    const grid = buildSeabedGrid(env.heightfield);
    this.grid = grid;
    const means = meanAlbedos(env);
    this.uniforms = {
      uSbLod: { value: new THREE.Vector2(30, 40) },
      uSbSandMean: { value: means.sand },
      uSbRockMean: { value: means.rock },
    };
    this.materials = {
      rock: createSeabedMaterial(env, this.uniforms, { rock: true }),
      sand: createSeabedMaterial(env, this.uniforms, { rock: false }),
      far: createSeabedMaterial(env, this.uniforms, { far: true }),
    };
    // Capacity per list: the tiles that can ever land in it — eligible ones,
    // and no more than fit in a disc of the list's outer radius (padded by a
    // tile diagonal) around any camera position.
    const cap = [0, 0, 0];
    let maxLen = 0;
    for (let t = 0; t < grid.count; t++) {
      cap[grid.rock[t] ? ROCK : SAND] += grid.len[t];
      maxLen = Math.max(maxLen, grid.len[t]);
    }
    const side = grid.box[3] - grid.box[0];
    const disc = (r) => Math.ceil((Math.PI * (r + side * Math.SQRT2) ** 2) / (side * side)) * maxLen;
    const all = grid.index.length;
    cap[ROCK] = Math.min(cap[ROCK], disc(nearR));
    cap[SAND] = Math.min(cap[SAND], disc(nearR));
    cap[FAR] = Math.min(all, disc(keepR));
    const m = this.materials;
    this.lists = new TileLists(
      grid,
      { position: new THREE.BufferAttribute(grid.pos, 3), normal: new THREE.BufferAttribute(grid.nor, 3) },
      [
        { name: 'seabed-rock', material: m.rock, capacity: cap[ROCK], receiveShadow: true },
        { name: 'seabed-sand', material: m.sand, capacity: cap[SAND], receiveShadow: true },
        { name: 'seabed-far', material: m.far, capacity: cap[FAR] },
      ],
      // Drawn after the other opaque scenery, so rocks, coral, the cliff and
      // the sharks hide it by early depth test instead of being overdrawn.
      { hysteresis: HYSTERESIS, renderOrder: 1 },
    );
    this.group = this.lists.group;
    this.group.name = 'seabed';
    this.meshes = this.lists.meshes;
    // Classifier (bound once, no per-frame closure): near = any part possibly
    // within the LOD distance, dropped = surely in opaque fog; the radii
    // include the hysteresis margin.
    this._classify = (d, t) => {
      if (d >= keepR) return -1;
      if (d < nearR) return grid.rock[t] ? ROCK : SAND;
      return FAR;
    };
  }

  /**
   * Per render: the detail fade follows the live fog `density` (never thinner
   * than the base the lists are classified with, so it always completes
   * inside the near tiles); the lists are re-sorted once the camera `cam` has
   * left the hysteresis radius. Returns true on a rebuild.
   */
  update(cam, density) {
    const k = Math.max(density, this.baseDensity);
    this.uniforms.uSbLod.value.set(SEABED_FADE_X / k, FOG_LOD_X / k);
    return this.lists.update(cam, 0, this._classify);
  }

  /** Warm-up frame: every list drawn, so all programs compile up front. */
  setWarm(on) {
    this.lists.setWarm(on);
  }
}
