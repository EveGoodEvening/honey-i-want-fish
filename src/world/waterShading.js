// Shared underwater shading: the water-radiance model used by fog and the
// background, caustics, and depth light absorption. Everything that wants to
// look "underwater" goes through here so the whole scene agrees.
//
// Two mechanisms:
//  1. installWaterFog() overrides three's fog shader chunks once, globally, so
//     *every* fogged material (ours and other modules') fades into the same
//     view-dependent water colour: bright looking up, near-black looking down,
//     a soft glow toward the sun. Fog uses true eye distance (not view z).
//     The veil is per channel (reds die first) and follows FOG_CURVE: a linear
//     term veils the near field, a quadratic term closes it in at the
//     visibility limit (see envFogTau below).
//  2. patchShader()/patchMaterial() inject caustics (modulating direct sun
//     light, so shadows and N·L are respected) and depth absorption into
//     MeshStandard/Physical/Lambert/Phong materials via onBeforeCompile.
import * as THREE from 'three';

// --- Fog curve (shared by every hand-written fog in the game) ---
// x = fogDensity·dist, tau = lin·x + quad·x², veil = 1 − exp(−tau·rgb).
// With WORLD.visibility = 55 the green veil is 12/25/51/74/86/94 % at
// 5/10/20/31/40/50 m. Shaders that fade by hand (light shafts, marine snow,
// VFX, jellyfish, whale) use the same scalar curve (green channel).
export const FOG_CURVE = { lin: 0.72, quad: 0.74, rgb: [1.5, 1.0, 0.9] };
// Optical depth (green) beyond which the water is opaque for any practical
// purpose: transmittance e^-10.5 ≈ 3e-5 (blue, ×0.9: 8e-5). Anything farther
// than FOG_OPAQUE_X / fogDensity from the eye can be skipped entirely.
export const FOG_OPAQUE_X = 3.3;
// Beyond FOG_LOD_X / fogDensity (≈ 59 m) the veil is ≥ 97.5 % (green): large
// static surfaces there (seabed tiles, cliff strips) switch to cheap "far"
// shading (mean albedo, no normal maps / caustics / shadows) whose average
// matches the full shader; the seabed's near shader fades into it exactly.
export const FOG_LOD_X = 1.8;

/** JS twin of the GLSL envFogTau(): optical depth of the veil (green channel). */
export function envFogTau(dist, density) {
  const x = density * dist;
  return x * (FOG_CURVE.lin + FOG_CURVE.quad * x);
}

/** Guarded GLSL helper `float envFogTau( float dist, float density )`. */
export const FOG_TAU_GLSL = /* glsl */ `
#ifndef ENV_FOG_TAU
#define ENV_FOG_TAU
// Per-channel scale of the optical depth (reds die first).
#define ENV_FOG_RGB vec3( ${FOG_CURVE.rgb.map((c) => c.toFixed(2)).join(', ')} )
// Optical depth of the water veil (green channel) after dist metres.
float envFogTau( float dist, float density ) {
  float x = density * dist;
  return x * ( ${FOG_CURVE.lin.toFixed(2)} + ${FOG_CURVE.quad.toFixed(2)} * x );
}
#endif
`;

// --- Tunables for the water radiance model (linear colour multipliers) ---
export const WATER_LOOK = {
  upGain: 2.7, // zenith radiance relative to horizontal
  downGain: 0.16, // nadir radiance relative to horizontal
  sunHaze: 0.75, // broad forward-scatter glow toward the sun
  sunCore: 1.1, // tighter glow around the refracted sun
  fogSaturation: 70, // metres after which the fog is effectively opaque
  dropK: [0.03, 0.022, 0.014], // darkening per metre the ray descends below the eye
};

const f = (x) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const v3 = (a) => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

/** Guarded macro so several injected blocks can share the sun direction. */
export function sunDefineGLSL(sunDir) {
  const n = (x) => x.toFixed(5);
  return `#ifndef ENV_SUN_DIR\n#define ENV_SUN_DIR vec3(${n(sunDir.x)}, ${n(sunDir.y)}, ${n(sunDir.z)})\n#endif`;
}

/**
 * GLSL for the water radiance model. `base` is the horizontal water colour at
 * the eye (linear), `dir` the unit view ray, `dist` the ray length.
 */
export function waterRadianceGLSL(sunDir) {
  const L = WATER_LOOK;
  return /* glsl */ `
#ifndef ENV_WATER_RADIANCE
#define ENV_WATER_RADIANCE
${sunDefineGLSL(sunDir)}
vec3 envWaterRadiance( vec3 base, vec3 dir, float dist ) {
  float up = dir.y;
  float g = up >= 0.0
    ? 1.0 + ${f(L.upGain - 1)} * pow( up, 1.4 )
    : mix( 1.0, ${f(L.downGain)}, pow( -up, 0.75 ) );
  // Rays that dive deep pick up in-scatter from darker, bluer water.
  float drop = min( dist, ${f(L.fogSaturation)} ) * max( -up, 0.0 );
  vec3 col = base * g * exp( -drop * ${v3(L.dropK)} );
  // Forward scattering around the refracted sun.
  float s = max( dot( dir, ENV_SUN_DIR ), 0.0 );
  float sunGlow = pow( s, 6.0 ) * ${f(L.sunHaze)} + pow( s, 40.0 ) * ${f(L.sunCore)};
  col += base * sunGlow * vec3( 0.85, 1.0, 1.0 );
  return col;
}
// fogColor arrives in the output colour space (sRGB when drawing straight to
// the canvas, linear when rendering into a render target for post).
vec3 envOutputToLinear( vec3 c ) {
  return linearToOutputTexel( vec4( 0.5 ) ).r > 0.6 ? sRGBTransferEOTF( vec4( c, 1.0 ) ).rgb : c;
}
vec3 envLinearToOutput( vec3 c ) {
  return linearToOutputTexel( vec4( c, 1.0 ) ).rgb;
}
#endif
`;
}

/** Override three's fog chunks so fog colour depends on view direction. */
export function installWaterFog(sunDir) {
  const SC = THREE.ShaderChunk;
  if (SC.__envWaterFog) return;
  SC.__envWaterFog = true;

  SC.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif
`;
  // World position from the view-space position: works for meshes, instances,
  // skinned meshes, points and sprites alike (they all define mvPosition).
  SC.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldPos = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif
`;
  SC.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${waterRadianceGLSL(sunDir)}
	${FOG_TAU_GLSL}
#endif
`;
  // Per-channel veil: red is lost first, blue last, so colours sink into the
  // water's teal with distance instead of just greying out.
  SC.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	vec3 envFogRay = vFogWorldPos - cameraPosition;
	float envFogDist = length( envFogRay );
	#ifdef FOG_EXP2
		vec3 envFogF = 1.0 - exp( - envFogTau( envFogDist, fogDensity ) * ENV_FOG_RGB );
	#else
		vec3 envFogF = vec3( smoothstep( fogNear, fogFar, envFogDist ) );
	#endif
	float fogFactor = envFogF.g; // scalar, for shaders that read it after this chunk
	vec3 envFogCol = envWaterRadiance( envOutputToLinear( fogColor ), envFogRay / max( envFogDist, 1e-4 ), envFogDist );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, envLinearToOutput( envFogCol ), envFogF );
#endif
`;
}

/** Uniforms shared (by reference) by every patched material. */
export function createEnvUniforms() {
  return {
    uEnvTime: { value: 0 },
    uEnvRefDepth: { value: 20 }, // depth (m, positive) the scene lights are tuned for
    uEnvAbsorb: { value: new THREE.Vector3(0.11, 0.04, 0.03) }, // per-metre light absorption
    uEnvCaustics: { value: 1 }, // global caustic strength
    uEnvDim: { value: 1 }, // global light dimmer (e.g. a huge shape overhead)
  };
}

// Caustic network: iterated domain-warped trig, after joltz0r's well-known
// "tileable water caustic". ITER controls the cost.
export function causticsGLSL(sunDir, iterations, layers) {
  // Shift along the refracted sun ray up to the surface: caustic patterns are
  // projected, so they slide sideways as depth changes (feels volumetric).
  const kx = sunDir.x / sunDir.y;
  const kz = sunDir.z / sunDir.y;
  return /* glsl */ `
#ifndef ENV_CAUSTICS_GLSL
#define ENV_CAUSTICS_GLSL
float envCausticLayer( vec2 uv, float time, float sharp ) {
  vec2 p = mod( uv * 6.28318, 6.28318 ) - 250.0;
  vec2 i = p;
  float c = 1.0;
  const float inten = 0.005;
  for ( int n = 0; n < ${iterations}; n++ ) {
    float t = time * ( 1.0 - ( 3.5 / float( n + 1 ) ) );
    i = p + vec2( cos( t - i.x ) + sin( t + i.y ), sin( t - i.y ) + cos( t + i.x ) );
    c += 1.0 / length( vec2( p.x / ( sin( i.x + t ) / inten ), p.y / ( cos( i.y + t ) / inten ) ) );
  }
  c /= ${f(iterations)};
  c = 1.17 - pow( c, 1.4 );
  return pow( abs( c ), sharp );
}
// Caustic brightness pattern (~0..1.5) at a world position.
float envCausticPattern( vec3 wp, float time ) {
  float depth = max( -wp.y, 0.0 );
  vec2 p = wp.xz + vec2( ${f(kx)}, ${f(kz)} ) * depth;
  float scale = 4.0 + depth * 0.07; // caustics grow and blur with depth
  float sharp = mix( 9.0, 5.0, clamp( depth / 50.0, 0.0, 1.0 ) );
  float c = envCausticLayer( p / scale, time * 0.5 + 23.0, sharp );
  ${layers > 1 ? 'c = c * 0.75 + envCausticLayer( p / ( scale * 1.9 ) + vec2( 0.37, 0.11 ), time * 0.37 + 3.1, sharp ) * 0.45;' : ''}
  return c;
}
#endif
`;
}

function fragmentPars(sunDir, quality) {
  const iters = quality === 'low' ? 3 : quality === 'medium' ? 4 : 5;
  const layers = quality === 'high' ? 2 : 1;
  return /* glsl */ `
${sunDefineGLSL(sunDir)}
uniform float uEnvTime;
uniform float uEnvRefDepth;
uniform vec3 uEnvAbsorb;
uniform float uEnvCaustics;
uniform float uEnvDim;
varying vec3 vEnvWorldPos;
${causticsGLSL(sunDir, iters, layers)}
// Multiplier for direct sunlight: bright caustic filaments, slightly darker gaps.
// k (0..1) scales the caustic amount for this material / fragment.
float envCausticFactor( vec3 wp, float k ) {
  float depth = max( -wp.y, 0.0 );
  float amt = k * uEnvCaustics * ( 0.45 + 0.55 * exp( -depth / 26.0 ) );
  float dist = length( wp - cameraPosition );
  amt *= 1.0 - 0.8 * smoothstep( 25.0, 75.0, dist ); // fade before it aliases
  // Gone entirely where the fog is opaque anyway (>= 99 % beyond ~70 m), so
  // the expensive pattern can be skipped there (spatially coherent branch).
  amt *= 1.0 - smoothstep( 70.0, 95.0, dist );
  if ( amt < 0.004 ) return 1.0;
  float c = envCausticPattern( wp, uEnvTime );
  return max( 0.0, 1.0 + amt * ( c * 6.5 - 0.6 ) );
}
// Light reaching a point is absorbed over its depth; the scene lights are
// already tuned for uEnvRefDepth, so only the difference is applied here.
vec3 envTransmit( float y ) {
  float d = max( -y, 0.0 );
  return min( exp( -uEnvAbsorb * ( d - uEnvRefDepth ) ), vec3( 3.0 ) ) * uEnvDim;
}
`;
}

const VERT_PARS = /* glsl */ `
varying vec3 vEnvWorldPos;
`;
const VERT_MAIN = /* glsl */ `
vEnvWorldPos = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
`;

/**
 * Inject env uniforms + caustics + absorption into a built-in lit shader
 * (inside onBeforeCompile). Options:
 *   caustics (default true), absorption (default true),
 *   causticScale (0..1 multiplier on the caustic amount for this material),
 *   causticMask (GLSL float expression, 0..1, evaluated per fragment after
 *   the material's own code, e.g. a distance fade; 0 skips the pattern).
 */
export function patchShader(shader, uniforms, sunDir, quality, opts = {}) {
  const { caustics = true, absorption = true, causticScale = 1, causticMask = '1.0' } = opts;
  Object.assign(shader.uniforms, uniforms);

  let vs = shader.vertexShader;
  if (!vs.includes('varying vec3 vEnvWorldPos;')) {
    vs = vs.replace('#include <common>', `#include <common>\n${VERT_PARS}`);
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
  }
  shader.vertexShader = vs;

  let fs = shader.fragmentShader;
  if (!fs.includes('uniform float uEnvTime;')) {
    fs = fs.replace('#include <common>', `#include <common>\n${fragmentPars(sunDir, quality)}`);
  }
  if (caustics && fs.includes('#include <lights_fragment_end>')) {
    fs = fs.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
{
  float envC = envCausticFactor( vEnvWorldPos, ${f(causticScale)} * ${causticMask} );
  reflectedLight.directDiffuse *= envC;
  reflectedLight.directSpecular *= envC;
}`,
    );
  }
  if (absorption && fs.includes('#include <opaque_fragment>')) {
    fs = fs.replace(
      '#include <opaque_fragment>',
      `outgoingLight *= envTransmit( vEnvWorldPos.y );\n#include <opaque_fragment>`,
    );
  }
  shader.fragmentShader = fs;
  return shader;
}

/**
 * Public patchMaterial: chains any existing onBeforeCompile and cache key.
 * Safe to call more than once on the same material.
 */
export function patchMaterial(material, uniforms, sunDir, quality, opts = {}) {
  if (!material || material.userData.__envPatched) return material;
  const lit = material.isMeshStandardMaterial || material.isMeshLambertMaterial || material.isMeshPhongMaterial;
  if (!lit && !material.isMeshBasicMaterial) return material;
  material.userData.__envPatched = true;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const key = `env1|${quality}|${opts.caustics === false ? 0 : 1}${opts.absorption === false ? 0 : 1}|${opts.causticScale ?? 1}|${opts.causticMask ?? ''}`;
  material.onBeforeCompile = function onBeforeCompile(shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    patchShader(shader, uniforms, sunDir, quality, opts);
  };
  material.customProgramCacheKey = function customProgramCacheKey() {
    return `${prevKey ? prevKey.call(this) : ''}|${key}`;
  };
  material.needsUpdate = true;
  return material;
}

// Small GLSL helpers shared by our own custom materials.
export const TRIPLANAR_GLSL = /* glsl */ `
#ifndef ENV_TRIPLANAR
#define ENV_TRIPLANAR
vec3 triWeights( vec3 n, float sharp ) {
  vec3 w = pow( abs( n ), vec3( sharp ) );
  return w / ( w.x + w.y + w.z );
}
vec4 triSample( sampler2D tex, vec3 p, vec3 w ) {
  return texture2D( tex, p.zy ) * w.x + texture2D( tex, p.xz ) * w.y + texture2D( tex, p.xy ) * w.z;
}
// Whiteout-blended triplanar normal mapping (Ben Golus). n = world normal.
vec3 triNormal( sampler2D tex, vec3 p, vec3 n, vec3 w, float strength ) {
  vec3 tnX = texture2D( tex, p.zy ).xyz * 2.0 - 1.0;
  vec3 tnY = texture2D( tex, p.xz ).xyz * 2.0 - 1.0;
  vec3 tnZ = texture2D( tex, p.xy ).xyz * 2.0 - 1.0;
  tnX.xy *= strength; tnY.xy *= strength; tnZ.xy *= strength;
  tnX = vec3( tnX.xy + n.zy, abs( tnX.z ) * n.x );
  tnY = vec3( tnY.xy + n.xz, abs( tnY.z ) * n.y );
  tnZ = vec3( tnZ.xy + n.xy, abs( tnZ.z ) * n.z );
  return normalize( tnX.zyx * w.x + tnY.xzy * w.y + tnZ.xyz * w.z );
}
// Explicit-gradient variants for use inside non-uniform branches (implicit
// derivatives are undefined there). dx/dy = dFdx/dFdy of p, taken outside.
vec4 triSampleGrad( sampler2D tex, vec3 p, vec3 w, vec3 dx, vec3 dy ) {
  return textureGrad( tex, p.zy, dx.zy, dy.zy ) * w.x
    + textureGrad( tex, p.xz, dx.xz, dy.xz ) * w.y
    + textureGrad( tex, p.xy, dx.xy, dy.xy ) * w.z;
}
vec3 triNormalGrad( sampler2D tex, vec3 p, vec3 n, vec3 w, float strength, vec3 dx, vec3 dy ) {
  vec3 tnX = textureGrad( tex, p.zy, dx.zy, dy.zy ).xyz * 2.0 - 1.0;
  vec3 tnY = textureGrad( tex, p.xz, dx.xz, dy.xz ).xyz * 2.0 - 1.0;
  vec3 tnZ = textureGrad( tex, p.xy, dx.xy, dy.xy ).xyz * 2.0 - 1.0;
  tnX.xy *= strength; tnY.xy *= strength; tnZ.xy *= strength;
  tnX = vec3( tnX.xy + n.zy, abs( tnX.z ) * n.x );
  tnY = vec3( tnY.xy + n.xz, abs( tnY.z ) * n.y );
  tnZ = vec3( tnZ.xy + n.xy, abs( tnZ.z ) * n.z );
  return normalize( tnX.zyx * w.x + tnY.xzy * w.y + tnZ.xyz * w.z );
}
#endif
`;
