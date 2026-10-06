// Giant kelp forests and sea-grass meadows. One InstancedMesh per forest /
// meadow (so each is culled on its own); all motion is in the vertex shader
// (world-space current lean + travelling sway + blade flutter), applied in
// begin_vertex so lighting, shadows and the custom shadow-depth material all
// agree. Sea-grass blades keep a minimum on-screen width (patchMinWidth), so
// blades seen edge-on or far off don't break into MSAA dashes. Blades right in
// front of the lens fade out (patchNearFade) instead of filling the screen as
// flat paper strips.
import * as THREE from 'three';
import { mulberry32, smoothstep } from './noise.js';
import { LAYOUT } from './terrain.js';
import { makeInstancedBuckets } from './instancing.js';

const KELP_HEIGHT = 16; // metres, before per-instance scale
// Near fade (metres from the camera): gone inside [0], whole beyond [1]. Sea-
// grass blades are 3-6× narrower than kelp blades, so they only turn into
// strips nearer the lens, and a 1.5 m fade shaves a bald disc into the meadow
// under a low camera.
const KELP_NEAR = [1.5, 2.5];
const GRASS_NEAR = [1.0, 2.0];
// MSAA samples of PostFX's scene target per preset (src/render/PostFX.js);
// low has none, so it dithers with discard instead of alpha-to-coverage.
const MSAA_SAMPLES = { high: 4, medium: 2, low: 0 };
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

/**
 * Ribbon strip helper: centre line points + width per point → indexed strip.
 * With `out.rib`, each vertex also records its half-width vector (centre →
 * '+' edge) and which edge it is (±1), for the min-screen-width shader.
 */
function ribbon(points, widths, sideDir, colors, flutter, out) {
  const n = points.length;
  const base = out.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const w = widths[i];
    const sd = sideDir[i];
    for (let s = -1; s <= 1; s += 2) {
      out.pos.push(p.x + sd.x * w * s, p.y + sd.y * w * s, p.z + sd.z * w * s);
      out.col.push(colors[i][0], colors[i][1], colors[i][2]);
      out.flt.push(flutter[i]);
      out.rib?.push(sd.x * w, sd.y * w, sd.z * w, s);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    out.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

function finishGeometry(out) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
  geo.setAttribute('aFlutter', new THREE.Float32BufferAttribute(out.flt, 1));
  if (out.rib) geo.setAttribute('aRibbon', new THREE.Float32BufferAttribute(out.rib, 4));
  geo.setIndex(out.idx);
  geo.computeVertexNormals();
  return geo;
}

/** One giant-kelp frond: a slender stipe with alternating wavy blades. */
function makeKelpGeometry(seed, lowPoly) {
  const rand = mulberry32(seed);
  const out = { pos: [], col: [], flt: [], idx: [] };
  const H = KELP_HEIGHT;
  // Stipe as a thin cross of two ribbons (cheap, reads as a cylinder).
  const segs = lowPoly ? 14 : 24;
  const pts = [];
  const wid = [];
  const sideA = [];
  const sideB = [];
  const cols = [];
  const flt = [];
  const bend = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5).multiplyScalar(0.8);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(bend.x * t * t, t * H, bend.z * t * t));
    wid.push(0.045 * (1 - t * 0.5));
    sideA.push(new THREE.Vector3(1, 0, 0));
    sideB.push(new THREE.Vector3(0, 0, 1));
    const c = 0.24 + t * 0.2;
    cols.push([c * 1.0, c * 0.78, c * 0.38]);
    flt.push(0);
  }
  ribbon(pts, wid, sideA, cols, flt, out);
  ribbon(pts, wid, sideB, cols, flt, out);

  // Blades: long, narrow, wrinkled ribbons on short stalks all the way up the
  // stipe, rising briefly then drooping and streaming (Macrocystis).
  const nBlades = lowPoly ? 26 : 46;
  const up = new THREE.Vector3(0, 1, 0);
  for (let b = 0; b < nBlades; b++) {
    const t = 0.05 + (b / nBlades) * 0.93 + (rand() - 0.5) * 0.015;
    const root = new THREE.Vector3(bend.x * t * t, t * H, bend.z * t * t);
    const ang = b * 2.4 + rand() * 0.6; // phyllotaxis-ish
    const outDir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
    const len = (0.95 + rand() * 0.7) * (1 - Math.abs(t - 0.5) * 0.45);
    const rise = 0.45 + rand() * 0.3;
    const dir = outDir.clone().multiplyScalar(0.75).addScaledVector(up, rise).normalize();
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (side.lengthSq() < 0.01) side.set(1, 0, 0);
    // Twist the blade plane so blades show their face from the side, not their edge.
    const twist = 0.5 + rand() * 0.9;
    const bin = new THREE.Vector3().crossVectors(dir, side).normalize();
    side.multiplyScalar(Math.cos(twist)).addScaledVector(bin, Math.sin(twist)).normalize();
    const bsegs = lowPoly ? 3 : 4;
    const bp = [];
    const bw = [];
    const bs = [];
    const bc = [];
    const bf = [];
    const tone = 0.8 + rand() * 0.4;
    for (let k = 0; k <= bsegs; k++) {
      const u = k / bsegs;
      const p = root.clone().addScaledVector(dir, u * len);
      p.y -= Math.pow(u, 1.6) * len * 0.6; // droop toward the tip
      p.addScaledVector(side, Math.sin(u * 13 + b) * 0.025 * u); // wrinkles
      bp.push(p);
      bw.push(0.015 + Math.sin(Math.min(1, u * 1.35) * Math.PI) * 0.075 * (1 - u * 0.3));
      bs.push(side);
      const c = (0.27 + u * 0.15) * tone;
      bc.push([c * 1.2, c * 0.78, c * 0.28]);
      bf.push(0.2 + u);
    }
    ribbon(bp, bw, bs, bc, bf, out);
  }
  return finishGeometry(out);
}

/** A clump of eel-grass blades. */
function makeGrassGeometry(seed, lowPoly) {
  const rand = mulberry32(seed);
  const out = { pos: [], col: [], flt: [], idx: [], rib: [] };
  const blades = lowPoly ? 7 : 12;
  for (let b = 0; b < blades; b++) {
    const a = rand() * Math.PI * 2;
    const r0 = Math.sqrt(rand()) * 0.22;
    const root = new THREE.Vector3(Math.cos(a) * r0, 0, Math.sin(a) * r0);
    const h = 0.45 + rand() * 0.65;
    const lean = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.1 + rand() * 0.25);
    const side = new THREE.Vector3(-Math.sin(a + 0.6), 0, Math.cos(a + 0.6));
    const segs = lowPoly ? 3 : 4;
    const pts = [];
    const wid = [];
    const sd = [];
    const cols = [];
    const fl = [];
    const tone = 0.8 + rand() * 0.4;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      pts.push(new THREE.Vector3(root.x + lean.x * t * t * h * 2, t * h, root.z + lean.z * t * t * h * 2));
      wid.push(0.022 * (1 - t * 0.6));
      sd.push(side);
      const c = (0.38 + t * 0.32) * tone;
      cols.push([c * 0.78, c * 0.95, c * 0.5]);
      fl.push(t);
    }
    ribbon(pts, wid, sd, cols, fl, out);
  }
  return finishGeometry(out);
}

/** Vertex sway GLSL, injected after begin_vertex (instanced only). */
function swayChunk({ height, lean, sway, flutter, speed }) {
  return /* glsl */ `
#include <begin_vertex>
#ifdef USE_INSTANCING
{
  vec3 vgRoot = instanceMatrix[ 3 ].xyz;
  float vgPhase = vgRoot.x * 0.131 + vgRoot.z * 0.173;
  float vgH = clamp( position.y / ${height.toFixed(3)}, 0.0, 1.0 );
  float vgA = pow( vgH, 1.5 );
  float vgT = uVegTime * ${speed.toFixed(3)};
  // Steady lean with the current, plus slow travelling sway (surge).
  vec2 vgOff = uVegCurrent * vgA * ${lean.toFixed(3)};
  vgOff += vec2( sin( vgT * 0.53 + vgPhase + vgH * 2.6 ), sin( vgT * 0.71 + vgPhase * 1.7 + vgH * 3.4 ) ) * vgA * ${sway.toFixed(3)};
  vec3 vgW = vec3( vgOff.x, 0.0, vgOff.y );
  // Blade flutter.
  vgW += vec3(
    sin( vgT * 2.1 + vgPhase * 3.1 + position.y * 1.7 ),
    sin( vgT * 1.7 + vgPhase + position.y ) * 0.5,
    cos( vgT * 1.9 + vgPhase * 2.3 + position.y * 1.3 )
  ) * aFlutter * ${flutter.toFixed(3)};
  // Roughly conserve length: bending lowers the top a little.
  vgW.y -= dot( vgOff, vgOff ) * 0.5 / max( ${height.toFixed(3)} * 4.0, 1.0 ) * vgA;
  mat3 vgIm = mat3( instanceMatrix );
  transformed += transpose( vgIm ) * vgW / dot( vgIm[ 0 ], vgIm[ 0 ] );
}
#endif
`;
}

/**
 * Thin foliage transmits light: shade the side facing away from the sun as
 * if it faced it, slightly darker (cheap two-sided translucency).
 */
function patchTwoSided(shader, backTint) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
{
  vec3 vgWN = ( vec4( normal, 0.0 ) * viewMatrix ).xyz;
  if ( dot( vgWN, ENV_SUN_DIR ) < 0.0 ) {
    normal = -normal;
    diffuseColor.rgb *= vec3( ${backTint} );
  }
}`,
  );
}

/**
 * Per-instance shadow casting for a kelp bucket. The instances that should
 * cast are kept packed at the front of the instance buffer, and the shadow
 * pass draws only that prefix (onBeforeShadow / onAfterShadow swap `count`);
 * the main pass still draws every plant. Order is irrelevant to the shader
 * (sway phase comes from the instance position).
 */
function initShadowSubset(mesh) {
  const n = mesh.count;
  const src = mesh.instanceMatrix.array.slice(); // original order
  const sphere = new Float32Array(n * 4); // plant bounding sphere: centre + radius
  for (let i = 0; i < n; i++) {
    const e = src.subarray(i * 16, i * 16 + 16);
    const s = Math.hypot(e[0], e[1], e[2]);
    sphere[i * 4] = e[12];
    sphere[i * 4 + 1] = e[13] + KELP_HEIGHT * 0.5 * s;
    sphere[i * 4 + 2] = e[14];
    sphere[i * 4 + 3] = KELP_HEIGHT * 0.5 * s + 4; // + sway / lean headroom
  }
  const shadow = { full: n, count: n, src, sphere, order: new Uint16Array(n), next: new Uint16Array(n) };
  for (let i = 0; i < n; i++) shadow.order[i] = i;
  mesh.userData.shadow = shadow;
  mesh.onBeforeShadow = function onBeforeShadow() {
    this.count = this.userData.shadow.count;
  };
  mesh.onAfterShadow = function onAfterShadow() {
    this.count = this.userData.shadow.full;
  };
}

/**
 * Re-pack a kelp bucket so the plants whose bounding sphere comes within
 * `maxDist` of `cam` cast shadows. Returns how many cast. Uploads the
 * instance buffer only when that set changes.
 */
export function updateShadowSubset(mesh, cam, maxDist) {
  const s = mesh.userData.shadow;
  if (!s) return mesh.count;
  const { sphere, next, full } = s;
  let k = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < full; i++) {
      const dx = sphere[i * 4] - cam.x;
      const dy = sphere[i * 4 + 1] - cam.y;
      const dz = sphere[i * 4 + 2] - cam.z;
      const casts = Math.sqrt(dx * dx + dy * dy + dz * dz) - sphere[i * 4 + 3] < maxDist;
      if (casts === (pass === 0)) next[k++] = i;
    }
    if (pass === 0) s.count = k;
  }
  let changed = false;
  for (let i = 0; i < full; i++) {
    if (next[i] !== s.order[i]) {
      changed = true;
      break;
    }
  }
  if (changed) {
    const dst = mesh.instanceMatrix.array;
    const src = s.src;
    for (let j = 0; j < full; j++) {
      s.order[j] = next[j];
      const o = next[j] * 16;
      for (let c = 0; c < 16; c++) dst[j * 16 + c] = src[o + c];
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  return s.count;
}

/**
 * Minimum on-screen width for thin ribbons (needs the `aRibbon` attribute).
 * A blade seen edge-on, or far away, is narrower than a pixel and breaks into
 * MSAA dashes; push its two edges apart across the screen until the blade
 * covers `minPx` pixels. Works in view space after project_vertex: the screen
 * direction across the blade is ⟂ to the blade's axis and the view ray, and
 * an edge keeps the side it projects to, so a blade turning through edge-on
 * stays one continuous strip. Wider blades are left untouched.
 */
function patchMinWidth(shader, uniforms, minPx) {
  shader.uniforms.uVegPixelScale = uniforms.uVegPixelScale;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uVegPixelScale;\nattribute vec4 aRibbon;')
    .replace(
      '#include <project_vertex>',
      /* glsl */ `#include <project_vertex>
#ifdef USE_INSTANCING
{
  mat3 vgMv = mat3( modelViewMatrix ) * mat3( instanceMatrix );
  vec3 vgHalf = vgMv * aRibbon.xyz; // centre line → '+' edge
  vec3 vgOff = vgHalf * aRibbon.w; // centre line → this edge
  vec3 vgC = mvPosition.xyz - vgOff;
  vec3 vgV = normalize( vgC );
  // Across the blade on screen: ⟂ to its axis (same for both edges) and the view ray.
  vec3 vgD = cross( cross( vgHalf, vgMv * objectNormal ), vgV );
  float vgDl = length( vgD );
  float vgMin = ${(minPx * 0.5).toFixed(3)} * max( -vgC.z, 0.0 ) / uVegPixelScale;
  if ( vgDl > 1e-12 ) {
    vgD /= vgDl;
    float vgA = dot( vgOff, vgD ); // this edge's offset across the screen
    if ( abs( vgA ) < vgMin ) {
      float vgSide = vgA > 0.0 ? 1.0 : vgA < 0.0 ? -1.0 : aRibbon.w;
      mvPosition.xyz += vgD * ( vgSide * vgMin - vgA );
      gl_Position = projectionMatrix * mvPosition;
    }
  }
}
#endif`,
    );
}

/**
 * Near-camera fade. A blade within ~2 m of the lens is wider than a hand on
 * screen and, being a flat lit ribbon, reads as a paper strip; fade it out
 * between uVegNear.y and uVegNear.x metres (like VFX's uNearFade). Opaque
 * screen-door: with MSAA (`material.alphaToCoverage`) the fade becomes sample
 * coverage, hashed by one coverage step per pixel (interleaved gradient noise,
 * fixed on screen) so it doesn't band; without MSAA a dithered discard. Shadow
 * depth is not faded: the plant is still there, and a fade measured from the
 * light's camera would only cut holes in its shadow.
 */
function patchNearFade(shader, near, samples) {
  shader.uniforms.uVegNear = near;
  const step = samples > 0 ? 1 / samples : 0;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec2 uVegNear;')
    .replace(
      '#include <alphatest_fragment>',
      /* glsl */ `#include <alphatest_fragment>
{
  float vgFade = smoothstep( uVegNear.x, uVegNear.y, length( vEnvWorldPos - cameraPosition ) );
  if ( vgFade < 1.0 ) {
    float vgN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
#ifdef ALPHA_TO_COVERAGE
    diffuseColor.a = clamp( vgFade * ${(1 + step).toFixed(3)} - ${step.toFixed(3)} * vgN, 0.0, 1.0 );
    if ( diffuseColor.a <= 0.0 ) discard;
#else
    if ( vgFade <= vgN ) discard;
#endif
  }
}`,
    );
}

function patchSway(shader, uniforms, cfg) {
  shader.uniforms.uVegTime = uniforms.uVegTime;
  shader.uniforms.uVegCurrent = uniforms.uVegCurrent;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uVegTime;\nuniform vec2 uVegCurrent;\nattribute float aFlutter;')
    .replace('#include <begin_vertex>', swayChunk(cfg));
}

export class Vegetation {
  constructor(env) {
    this.env = env;
    const q = env.quality;
    const hf = env.heightfield;
    const lowPoly = q === 'low';
    this.uniforms = {
      uVegTime: { value: 0 },
      uVegCurrent: { value: new THREE.Vector2(0.55, 0.3) },
      // Focal length in drawing-buffer pixels (Environment keeps it current).
      uVegPixelScale: { value: 600 },
      // Near fade: blades vanish inside x metres of the camera, whole beyond y.
      uKelpNear: { value: new THREE.Vector2(...KELP_NEAR) },
      uGrassNear: { value: new THREE.Vector2(...GRASS_NEAR) },
    };
    const samples = MSAA_SAMPLES[q] ?? 0;
    this.group = new THREE.Group();
    this.group.name = 'vegetation';

    // ---- Kelp ----
    const kelpGeo = makeKelpGeometry(5, lowPoly);
    const kelpCfg = { height: KELP_HEIGHT, lean: 3.2, sway: 1.5, flutter: 0.1, speed: 1.0 };
    const kelpMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0,
      vertexColors: true,
      side: THREE.DoubleSide,
      alphaToCoverage: samples > 0, // near fade (patchNearFade)
    });
    kelpMat.onBeforeCompile = (shader) => {
      patchSway(shader, this.uniforms, kelpCfg);
      patchNearFade(shader, this.uniforms.uKelpNear, samples);
      // Thin blades transmit light: a soft backlit glow when looking toward the sun.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
{
  vec3 vgV = normalize( vEnvWorldPos - cameraPosition );
  float vgBack = pow( max( dot( vgV, ENV_SUN_DIR ), 0.0 ), 3.0 );
  reflectedLight.indirectDiffuse += diffuseColor.rgb * directionalLights[ 0 ].color * vec3( 0.8, 1.0, 0.6 ) * vgBack * 0.12;
}
#endif`,
      );
      patchTwoSided(shader, '0.62, 0.5, 0.32');
      env.patchShader(shader, { causticScale: 0.8 });
    };
    kelpMat.customProgramCacheKey = () => `kelp|${env.quality}`;
    const kelpDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    kelpDepth.onBeforeCompile = (shader) => patchSway(shader, this.uniforms, kelpCfg);
    kelpDepth.customProgramCacheKey = () => 'kelp-depth';

    const rand = mulberry32(4242);
    const kelpMatrices = [];
    const kelpPatch = []; // forest index per instance (one culling bucket each)
    const kelpScale = q === 'low' ? 0.45 : q === 'medium' ? 0.75 : 1;
    for (const [pi, patch] of LAYOUT.kelpPatches.entries()) {
      const n = Math.round(patch.radius * patch.radius * 0.3 * patch.density * kelpScale);
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const d = Math.sqrt(rand()) * patch.radius;
        const x = patch.x + Math.cos(a) * d;
        const z = patch.z + Math.sin(a) * d;
        if (hf.slopeAt(x, z) > 0.3) continue;
        const y = hf.heightAt(x, z) - 0.1;
        const edge = 1 - d / patch.radius;
        const s = (0.55 + rand() * 0.55) * (0.65 + 0.45 * smoothstep(0, 0.6, edge));
        _p.set(x, y, z);
        _e.set((rand() - 0.5) * 0.08, rand() * Math.PI * 2, (rand() - 0.5) * 0.08);
        _q.setFromEuler(_e);
        _s.setScalar(s);
        kelpMatrices.push(_m.compose(_p, _q, _s).clone());
        kelpPatch.push(pi);
      }
    }
    // One InstancedMesh per forest so each is culled (camera, shadow box, fog
    // distance) on its own. Sway can move tips a few metres: pad the spheres.
    // The sun's shadow box usually clips only the near edge of a forest, so
    // the shadow pass draws just the plants near the camera (see
    // updateShadowSubset).
    this.kelpMeshes = makeInstancedBuckets(kelpGeo, kelpMat, kelpMatrices, {
      keyOf: (m, i) => kelpPatch[i],
      name: 'kelp',
      pad: 6,
      castShadow: q !== 'low',
      receiveShadow: q === 'high',
      customDepthMaterial: kelpDepth,
    });
    for (const mesh of this.kelpMeshes) {
      initShadowSubset(mesh);
      this.group.add(mesh);
    }

    // ---- Sea grass ----
    const grassGeo = makeGrassGeometry(77, lowPoly);
    const grassCfg = { height: 0.9, lean: 0.12, sway: 0.1, flutter: 0.05, speed: 1.6 };
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      vertexColors: true,
      side: THREE.DoubleSide,
      alphaToCoverage: samples > 0,
    });
    // Blades are 2-4 cm wide: keep them ≥ 0.7 px (MSAA covers that without
    // gaps); low has no MSAA, so a whole pixel there.
    const grassMinPx = q === 'low' ? 1.0 : 0.7;
    grassMat.onBeforeCompile = (shader) => {
      patchSway(shader, this.uniforms, grassCfg);
      patchMinWidth(shader, this.uniforms, grassMinPx);
      patchNearFade(shader, this.uniforms.uGrassNear, samples);
      patchTwoSided(shader, '0.6, 0.75, 0.55');
      env.patchShader(shader, { causticScale: 0.9 });
    };
    grassMat.customProgramCacheKey = () => `grass|${env.quality}`;
    const grassMatrices = [];
    const grassMeadow = [];
    const grassScale = q === 'low' ? 0.35 : q === 'medium' ? 0.65 : 1;
    for (const [mi, m] of LAYOUT.grassMeadows.entries()) {
      const n = Math.round(m.radius * m.radius * 1.7 * grassScale);
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2;
        const d = Math.pow(rand(), 0.7) * m.radius;
        const x = m.x + Math.cos(a) * d;
        const z = m.z + Math.sin(a) * d;
        if (hf.slopeAt(x, z) > 0.2) continue;
        const y = hf.heightAt(x, z) - 0.03;
        const s = (0.6 + rand() * 0.7) * (0.5 + 0.5 * (1 - d / m.radius));
        _p.set(x, y, z);
        _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI * 2);
        _s.set(s * 1.2, s, s * 1.2);
        grassMatrices.push(_m.compose(_p, _q, _s).clone());
        grassMeadow.push(mi);
      }
    }
    this.grassMeshes = makeInstancedBuckets(grassGeo, grassMat, grassMatrices, {
      keyOf: (m, i) => grassMeadow[i],
      name: 'seagrass',
      pad: 1,
      castShadow: false,
      receiveShadow: q !== 'low',
    });
    for (const mesh of this.grassMeshes) this.group.add(mesh);
  }

  update(dt) {
    this.uniforms.uVegTime.value += dt;
  }
}
